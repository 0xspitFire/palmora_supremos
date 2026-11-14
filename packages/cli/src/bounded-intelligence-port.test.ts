import {afterEach,describe,expect,it,vi} from 'vitest';
import {DiscoveryService,DurableStore,type IntelligenceChainPort} from '@mint-bot/backend';
import {boundedIntelligencePort} from './bounded-intelligence-port.js';
import {DiscoveryLiveness} from './discovery-liveness.js';
const nft=`0x${'1'.repeat(40)}`,wallet=`0x${'2'.repeat(40)}`,hash=`0x${'a'.repeat(64)}`;
function base():IntelligenceChainPort{return {chainId:1,safeHead:async()=>10n,scan:async(from,to)=>({ok:true,scan:{fromBlock:from,toBlock:to,mints:[],watchedMints:[],dropUpdates:[]}}),readDrop:async()=>null,hasCode:async()=>true,balance:async()=>0n,simulateMint:async()=>({outcome:'unknown',reason:'not-authority'})};}
afterEach(()=>vi.useRealTimers());
describe('bounded read-only intelligence dependencies',()=>{
 it('refuses values returned by an abort-ignoring reader after stop but before the deadline', async () => {
  const port = base(); let resolve!: (value: bigint) => void;
  port.balance = () => new Promise(done => { resolve = done; });
  const reads = boundedIntelligencePort(port);
  const pending = reads.port.balance(wallet); await Promise.resolve();
  reads.stop(); resolve(123n); expect(await pending).toBeNull();
 });
 it('retains partial watched coverage until a real complete slice replaces it', () => {
  const registry = new DiscoveryLiveness(() => 1000);
  const result = { status: 'ok' as const, fromBlock: '1', toBlock: '10', caughtUp: true, mintsObserved: 0, opportunitiesWritten: 0, calendarWritten: 0, alertsRaised: 0 };
  registry.complete(1, { ...result, watchedPartial: true });
  expect(registry.snapshot()).toMatchObject({ status: 'degraded', chains: [{ state: 'partial', watchedPartial: true }] });
  registry.complete(1, { ...result, fromBlock: undefined, toBlock: undefined });
  expect(registry.snapshot().status).toBe('degraded');
  registry.complete(1, result); expect(registry.snapshot().status).toBe('healthy');
 });
 it('preserves private-stage price and does not invent a public free calendar while metadata is deferred',async()=>{
  const store=new DurableStore();await store.open();let cursor=0n;const port=base();
  const metadata=vi.fn(async()=>({nftContract:nft,priceWei:0n,startTime:0,endTime:0,maxPerWallet:10,maxSupply:null,totalMinted:null}));port.readDrop=metadata;
  port.scan=async(from,to)=>({ok:true,scan:{fromBlock:from,toBlock:to,mints:[{nftContract:nft,minter:wallet,payer:wallet,quantity:1n,unitPriceWei:123n,dropStageIndex:1n,blockNumber:1n,txHash:hash,logIndex:0}],watchedMints:[],dropUpdates:[]}});
  const discovery=new DiscoveryService(store,{observedAddresses:()=>[{address:wallet}],cursor:()=>cursor,advanceCursor:(_chain,_source,value)=>{cursor=value;}},port,{budgetPerNftWei:1000n});
  await discovery.tick();expect(metadata).not.toHaveBeenCalled();
  expect(store.snapshot().events.some(row=>row.type==='calendar_entry')).toBe(false);
  expect(store.snapshot().events.find(row=>row.type.startsWith('opportunity_'))?.data.priceWei).toBe('123');
 });
 it('cancels before processing a late log range and does not advance the cursor',async()=>{
  const store=new DurableStore();await store.open();let cancelled=false,cursor=0n;const port=base();let finish!:()=>void;
  port.scan=async(from,to)=>{await new Promise<void>(resolve=>{finish=resolve;});return {ok:true,scan:{fromBlock:from,toBlock:to,mints:[],watchedMints:[],dropUpdates:[]}};};
  const discovery=new DiscoveryService(store,{observedAddresses:()=>[],cursor:()=>cursor,advanceCursor:(_chain,_source,value)=>{cursor=value;}},port,{budgetPerNftWei:1n,isCancelled:()=>cancelled});
  const pending=discovery.tick();await Promise.resolve();cancelled=true;finish();expect((await pending).reason).toBe('DISCOVERY_STOPPED');expect(cursor).toBe(0n);expect(store.snapshot().events).toHaveLength(0);
 });
 it('yields after its cooperative budget while retaining only durably scanned progress',async()=>{
  vi.useFakeTimers();const store=new DurableStore();await store.open();let cursor=0n;const port=base();
  port.scan=async(from)=>{vi.advanceTimersByTime(11);return {ok:true,scan:{fromBlock:from,toBlock:from,mints:[],watchedMints:[],dropUpdates:[]}};};
  const discovery=new DiscoveryService(store,{observedAddresses:()=>[],cursor:()=>cursor,advanceCursor:(_chain,_source,value)=>{cursor=value;}},port,{budgetPerNftWei:1n,tickBudgetMs:10});
  expect(await discovery.tick()).toMatchObject({status:'ok',toBlock:'1',caughtUp:false,reason:'TICK_BUDGET_EXCEEDED'});expect(cursor).toBe(1n);
 });
 it('reports catch-up and backwards time as degraded coverage',()=>{
  let now=10000;const registry=new DiscoveryLiveness(()=>now,1000);registry.complete(1,{status:'ok',toBlock:'1',headBlock:'10',caughtUp:false,mintsObserved:0,opportunitiesWritten:0,calendarWritten:0,alertsRaised:0});
  expect(registry.snapshot()).toMatchObject({status:'degraded',chains:[{state:'catching_up',headBlock:'10',caughtUp:false}]});now=0;expect(registry.snapshot().chains[0]?.state).toBe('stalled');
 });
 it('does not overlap retries when a reader ignores cancellation and never publishes its late result',async()=>{
  vi.useFakeTimers();let resolve!:(value:bigint|null)=>void;const port=base();const read=vi.fn(()=>new Promise<bigint|null>(done=>{resolve=done;}));port.safeHead=read;
  const reports:unknown[]=[];const wrapped=boundedIntelligencePort(port,{timeoutMs:20,report:value=>reports.push(value)});
  const first=wrapped.port.safeHead(),same=wrapped.port.safeHead();await vi.advanceTimersByTimeAsync(20);expect(await first).toBeNull();expect(await same).toBeNull();
  expect(await wrapped.port.safeHead()).toBeNull();expect(read).toHaveBeenCalledOnce();expect(wrapped.pending()).toBe(1);
  resolve(99n);await vi.advanceTimersByTimeAsync(0);expect(wrapped.pending()).toBe(0);expect(reports).toEqual(expect.arrayContaining([expect.objectContaining({operation:'safe_head',state:'timed_out'})]));
  port.safeHead=async()=>42n;expect(await wrapped.port.safeHead()).toBe(42n);wrapped.stop();
 });
 it('actually aborts a scoped read and only retries after the aborted work settles',async()=>{
  vi.useFakeTimers();const port=base();let active=0,max=0;const signals:AbortSignal[]=[];
  Object.assign(port,{withReadSignal:(signal:AbortSignal)=>({...port,safeHead:()=>new Promise<bigint|null>((_resolve,reject)=>{signals.push(signal);active++;max=Math.max(max,active);signal.addEventListener('abort',()=>{active--;reject(new Error('synthetic abort'));},{once:true});})})});
  const wrapped=boundedIntelligencePort(port,{timeoutMs:20});const pending=wrapped.port.safeHead();await vi.advanceTimersByTimeAsync(20);expect(await pending).toBeNull();expect(signals[0]?.aborted).toBe(true);expect(active).toBe(0);expect(max).toBe(1);wrapped.stop();
 });
 it('bounds stalled unique requests rather than accumulating a new unresolved read per tick',async()=>{
  vi.useFakeTimers();const port=base();const reads=vi.fn(()=>new Promise<null>(()=>undefined));port.readDrop=reads;const wrapped=boundedIntelligencePort(port,{timeoutMs:5,maxPending:2});
  const a=wrapped.port.readDrop(nft),b=wrapped.port.readDrop(wallet);await vi.advanceTimersByTimeAsync(5);await Promise.all([a,b]);expect(await wrapped.port.readDrop(`0x${'3'.repeat(40)}`)).toBeNull();expect(reads).toHaveBeenCalledTimes(2);wrapped.stop();
 });
 it('advances only the verified log range while stuck optional metadata stays unknown and cannot write late',async()=>{
  vi.useFakeTimers();const store=new DurableStore();await store.open();let cursor=0n;let late!:(value:null)=>void;const port=base();port.readDrop=()=>new Promise<null>(resolve=>{late=resolve;});port.scan=async(from,to)=>({ok:true,scan:{fromBlock:from,toBlock:to,mints:[{nftContract:nft,minter:wallet,payer:wallet,quantity:1n,unitPriceWei:0n,blockNumber:1n,txHash:hash,logIndex:0}],watchedMints:[],dropUpdates:[]}});
  const wrapped=boundedIntelligencePort(port,{timeoutMs:10});const discovery=new DiscoveryService(store,{observedAddresses:()=>[{address:wallet}],cursor:()=>cursor,advanceCursor:(_chain,_source,value)=>{cursor=value;}},wrapped.port,{budgetPerNftWei:1n});
  const tick=discovery.tick();await vi.advanceTimersByTimeAsync(15);expect((await tick).status).toBe('ok');expect(cursor).toBe(10n);const before=store.snapshot().events.length;expect(store.snapshot().events.some(row=>row.type==='calendar_entry')).toBe(false);
  late(null);await vi.advanceTimersByTimeAsync(0);expect(store.snapshot().events).toHaveLength(before);wrapped.stop();
 });
 it('reports a stuck chain separately from healthy peers and mint execution readiness',()=>{
  let now=0;const registry=new DiscoveryLiveness(()=>now,1000);registry.begin(1);registry.start(8453);registry.read({chainId:1,operation:'drop_metadata',state:'started',elapsedMs:0,pending:1});now=1100;registry.complete(8453,{status:'ok',toBlock:'22',mintsObserved:0,opportunitiesWritten:0,calendarWritten:0,alertsRaised:0});
  expect(registry.snapshot()).toMatchObject({status:'degraded',chains:[{chainId:1,state:'stalled',operation:'drop_metadata'},{chainId:8453,state:'healthy',lastSuccessBlock:'22'}]});
 });
});
