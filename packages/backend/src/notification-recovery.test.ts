import {afterEach, describe, expect, it, vi} from 'vitest';
import {DurableStore} from './store.js';
import {AlertManager} from './alerts.js';
import {NotificationDispatcher} from './notifications.js';
import {TelegramNotifier} from './telegram.js';
import {HealthService} from './health.js';

class Store extends DurableStore { override capabilities() { return {durable:true,atomicAcrossProcesses:true}; } }
const at='2026-11-05T13:00:00.000Z';
afterEach(()=>vi.useRealTimers());

describe('notification recovery under concurrent startup and throttling',()=>{
  it('atomically records and sends one intelligence identity across 150 concurrent producers',async()=>{
    const store=new Store();const sent:string[]=[];
    const dispatcher=new NotificationDispatcher(store,{send:async m=>{sent.push(m.eventId);}});
    const alerts=new AlertManager(store,dispatcher);
    const result=await Promise.all(Array.from({length:150},()=>alerts.intelligence({kind:'health',dedupe:'same-gap',text:'gap',priority:'immediate'})));
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(store.snapshot().events.filter(e=>e.type==='alert_health')).toHaveLength(1);
    expect(store.snapshot().notificationOutbox).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('paces outbound delivery before acquiring leases, without losing queued messages',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date(at));
    const store=new Store();
    await store.transaction(s=>{for(let i=0;i<3;i++)s.events.push({id:`e${i}`,type:'alert_health',at,data:{}});});
    const sent:number[]=[];
    const dispatcher=new NotificationDispatcher(store,{send:async()=>{sent.push(Date.now());}},{minIntervalMs:1100});
    const pending=Promise.all([0,1,2].map(i=>dispatcher.dispatch(`e${i}`,'gap')));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(store.snapshot().notificationOutbox).toHaveLength(3);
    expect(store.snapshot().notificationOutbox.filter(item=>item.deliveryLeaseUntil)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1100);await pending;
    expect(sent).toEqual([Date.parse(at),Date.parse(at)+1100,Date.parse(at)+2200]);
    expect(store.snapshot().notificationOutbox.every(item=>item.state==='delivered')).toBe(true);
  });

  it('honors explicit Telegram retry_after across dispatcher retries without claiming delivery',async()=>{
    const store=new Store();await store.transaction(s=>{s.events.push({id:'limited',type:'alert_health',at,data:{}});});
    let now=new Date(at);let calls=0;
    const notifier=new TelegramNotifier({secretStore:{has:()=>true,get:name=>name==='TG_BOT_TOKEN'?'test-token':'123'},fetcher:async()=>{
      calls++;return calls===1?{ok:false,status:429,json:async()=>({ok:false,parameters:{retry_after:60}})}:{ok:true,status:200,json:async()=>({ok:true})};
    }});
    const dispatcher=new NotificationDispatcher(store,notifier,{now:()=>now,retryBaseMs:1000,retryMaxMs:1000});
    await expect(dispatcher.dispatch('limited','gap')).rejects.toThrow('TELEGRAM_DELIVERY_FAILED:429');
    expect(store.snapshot().notificationOutbox[0]).toMatchObject({state:'failed',attempts:1,nextAttemptAt:new Date(Date.parse(at)+60000).toISOString()});
    now=new Date(Date.parse(at)+1000);await dispatcher.dispatch('limited','gap');expect(calls).toBe(1);
    now=new Date(Date.parse(at)+60000);await dispatcher.dispatch('limited','gap');expect(calls).toBe(2);
    expect(store.snapshot().notificationOutbox[0]?.state).toBe('delivered');
  });

  it('defers a distinct event during a persisted provider cooldown, including after restart',async()=>{
    const store=new Store();await store.transaction(s=>{for(const id of ['first','second'])s.events.push({id,type:'alert_health',at,data:{}});});
    let now=new Date(at);let calls=0;
    const notifier=new TelegramNotifier({secretStore:{has:()=>true,get:name=>name==='TG_BOT_TOKEN'?'test-token':'123'},fetcher:async()=>{
      calls++;return calls===1?{ok:false,status:429,json:async()=>({ok:false,parameters:{retry_after:60}})}:{ok:true,status:200,json:async()=>({ok:true})};
    }});
    const first=new NotificationDispatcher(store,notifier,{now:()=>now});
    await expect(first.dispatch('first','gap')).rejects.toThrow('429');
    const restarted=new NotificationDispatcher(store,notifier,{now:()=>now});
    await restarted.dispatch('second','next gap');expect(calls).toBe(1);
    expect(store.snapshot().notificationOutbox.find(item=>item.sourceEventId==='second')).toMatchObject({state:'pending',attempts:0,nextAttemptAt:new Date(Date.parse(at)+60000).toISOString()});
    now=new Date(Date.parse(at)+60000);await restarted.dispatch('second','next gap');expect(calls).toBe(2);
  });

  it('atomically queues an immediate alert even when delivery never starts',async()=>{
    const store=new Store();let callbackStarted=false;
    const dispatcher=new NotificationDispatcher(store,{send:async()=>undefined});
    dispatcher.dispatch=async()=>{callbackStarted=true;throw new Error('simulated crash before dispatch');};
    const alerts=new AlertManager(store,dispatcher,undefined,{now:()=>new Date(at)});
    await expect(alerts.intelligence({kind:'health',dedupe:'atomic-gap',text:'gap',priority:'immediate',at})).rejects.toThrow('simulated crash');
    expect(callbackStarted).toBe(true);
    expect(store.snapshot().notificationOutbox[0]).toMatchObject({state:'pending',attempts:0,createdAt:at});
    const sent:string[]=[];
    const restarted=new AlertManager(store,new NotificationDispatcher(store,{send:async m=>{sent.push(m.text);}},()=>new Date(at)),undefined,{now:()=>new Date(at)});
    expect(await restarted.retryUndelivered()).toBe(1);expect(sent).toEqual(['gap']);
  });

  it('recovers a legacy summary plan and orphan immediate alert once without refreshing its age',async()=>{
    const store=new Store();const older=new Date(Date.parse(at)-3600000).toISOString();
    await store.transaction(s=>{
      s.events.push({id:'plan',type:'discovery_skip_notice_plan',at:older,data:{alertDedupe:'legacy-summary'}});
      s.events.push({id:'legacy',type:'alert_health',at:older,data:{priority:'immediate',dedupe:'legacy-summary',text:'retained gap'}});
      s.events.push({id:'too-old',type:'alert_health',at:new Date(Date.parse(at)-7*3600000).toISOString(),data:{priority:'immediate',text:'stale gap'}});
    });
    const sent:string[]=[];const dispatcher=new NotificationDispatcher(store,{send:async m=>{sent.push(m.text);}},()=>new Date(at));
    const alerts=new AlertManager(store,dispatcher,undefined,{now:()=>new Date(at)});
    expect(await alerts.retryUndelivered()).toBe(1);expect(await alerts.retryUndelivered()).toBe(0);
    expect(sent).toEqual(['retained gap']);
    expect(store.snapshot().notificationOutbox[0]).toMatchObject({sourceEventId:'legacy',createdAt:older,state:'delivered'});
    expect(store.snapshot().events.some(event=>event.id==='too-old')).toBe(true);
  });

  it('does not individually replay grouped or digest-covered alerts during orphan repair',async()=>{
    const store=new Store();await store.transaction(s=>{
      s.events.push({id:'started',type:'alert_started',at,data:{text:'started'}});
      s.events.push({id:'grouped',type:'alert_kill',at,data:{priority:'grouped',text:'grouped'}});
      s.events.push({id:'covered',type:'alert_failed',at,data:{priority:'immediate',text:'covered'}});
      s.events.push({id:'digest',type:'alert_digest',at,data:{includes:['started','grouped','covered'],text:'summary'}});
      s.notificationOutbox.push({id:'notify_digest',sourceEventId:'digest',type:'alert_digest',text:'summary',state:'delivered',attempts:1,createdAt:at,deliveredAt:at});
    });
    const sent:string[]=[];const alerts=new AlertManager(store,new NotificationDispatcher(store,{send:async m=>{sent.push(m.text);}},()=>new Date(at)),undefined,{now:()=>new Date(at)});
    expect(await alerts.retryUndelivered()).toBe(0);expect(sent).toEqual([]);
    expect(store.snapshot().notificationOutbox).toHaveLength(1);
  });

  it('preserves grouped run-start emission without a duplicate digest or orphan replay',async()=>{
    const store=new Store();const sent:string[]=[];
    const alerts=new AlertManager(store,new NotificationDispatcher(store,{send:async m=>{sent.push(m.type);}},()=>new Date(at)),undefined,{now:()=>new Date(at)});
    await alerts.started('run',1);await alerts.flush();
    expect(await alerts.flushDigest()).toBe(0);expect(await alerts.retryUndelivered()).toBe(0);
    expect(sent).toEqual(['alert_started']);
  });

  it('limits retry work per pass and prioritizes safety over informational backlog',async()=>{
    const store=new Store();
    await store.transaction(s=>{for(let i=0;i<25;i++){
      const type=i===24?'alert_kill':['alert_health','alert_status','alert_digest','alert_opportunity'][i%4]!;
      s.events.push({id:`event-${i}`,type,at,data:{}});
      s.notificationOutbox.push({id:`notify_event-${i}`,sourceEventId:`event-${i}`,type,text:'notice',state:'pending',attempts:0,createdAt:at});
    }});
    const sent:string[]=[];const dispatcher=new NotificationDispatcher(store,{send:async m=>{sent.push(m.type);}},()=>new Date(at));
    const alerts=new AlertManager(store,dispatcher,undefined,{now:()=>new Date(at)});
    expect(await alerts.retryUndelivered()).toBe(20);expect(sent[0]).toBe('alert_kill');
    expect(store.snapshot().notificationOutbox.filter(item=>item.state==='pending')).toHaveLength(5);
    expect(await alerts.retryUndelivered()).toBe(5);
    expect(store.snapshot().notificationOutbox.every(item=>item.state==='delivered')).toBe(true);
  });
});

describe('truthful blocked readiness diagnostics',()=>{
  it('does not label a reconciled killed service as startup reconciliation unfinished',async()=>{
    const store=new Store();await store.transaction(s=>{s.killed=true;s.runtime={startupState:'Blocked',blockingReasons:['KILLED'],reconciliationCompletedAt:at,dependencies:{engine:true,chain:true,backup:true,notifications:true}};});
    const health=new HealthService(store).check();
    expect(health.ready).toBe(false);expect(health.state).toBe('Killed');
    expect(health.blockingReasons).not.toContain('STARTUP_RECONCILIATION_REQUIRED');
    expect(health.blockingReasons).toContain('KILLED');
    expect(health.blockingReasons).toContain('RUNTIME_PROBE_REQUIRED');
  });
  it('retains an explicit deployment block when a reconciled blocked state has no reason',async()=>{
    const store=new Store();await store.transaction(s=>{s.runtime={startupState:'Blocked',blockingReasons:[],reconciliationCompletedAt:at,dependencies:{engine:true,chain:true,backup:true,notifications:true}};});
    const health=new HealthService(store).check();expect(health.ready).toBe(false);
    expect(health.blockingReasons).toContain('DEPLOYMENT_NOT_READY');
  });
});
