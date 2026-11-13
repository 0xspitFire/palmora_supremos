import { createHash, randomUUID } from 'node:crypto';
import { fundingCampaignDigest, type BackendStore, type Campaign, type ExecutionCoordinator, type EventRecord } from '@mint-bot/backend';
import type { NativeFundingRecord } from '@mint-bot/database';
export interface PaidFundingOwner { ownerId:string; sessionId:string; expiresAt:string; }
export interface PaidFundingInspection { stageDigest:string; phaseEndsAt:string; wallets: Array<{wallet:string;requiredWei:bigint;balanceWei:bigint}>; }
export interface PaidFundingPlan { id:string;nonce:string;owner:PaidFundingOwner;campaignId:string;campaignDigest:string;chainId:1;wallets:string[];maxFeeGwei:number;quantity:number;mintPriceWei:string;stageDigest:string;expiresAt:string;shortfalls:Array<{wallet:string;requiredWei:string;maxTopupWei:string}>; }
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_k,v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
const sameSet=(a:readonly string[],b:readonly string[])=>a.length===b.length&&new Set(a.map(w=>w.toLowerCase())).size===a.length&&a.every(w=>b.some(v=>v.toLowerCase()===w.toLowerCase()));
const code=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:'PAID_FUNDING_CHECK_FAILED';
export const paidFundingPhrase=(plan:PaidFundingPlan)=>`FUND-PAID ${plan.id.slice(-8)} ${digest(plan).slice(-12)} FUNDING-ONLY`;
interface Progress {requestId:string;revision:number;state:'funding'|'prepared'|'blocked';holdId?:string;code?:string;}
export interface PaidFundingServiceOptions {
 store:BackendStore;coordinator:Pick<ExecutionCoordinator,'prepareFunding'|'fundHold'|'reconcileFunding'|'releaseFundingHold'>;
 inspect(campaign:Campaign,wallets:readonly string[]):Promise<PaidFundingInspection>;
 simulate(campaign:Campaign,wallets:readonly string[]):Promise<{recorded:string[]}>;
 assertOwner(owner:PaidFundingOwner):Promise<void>;
 assertReady(campaign:Campaign,wallets:readonly string[]):Promise<void>;
 notify(text:string,dedupe:string):Promise<void>;now?:()=>Date;
}
/** Funding approval is NOT mint approval. This service has no arm/run/fire or
 * live-request port. Only a subsequent ordinary owner /fire can mint. */
export function createPaidFundingService(options:PaidFundingServiceOptions){
 const now=options.now??(()=>new Date());
 const campaign=(id:string)=>{const c=options.store.snapshot().campaigns.find(row=>row.id===id);if(!c||c.dryRun||c.chainId!==1||c.mintPriceWei<=0n||c.feePolicy.kind!=='paid')throw new Error('PAID_FUNDING_ETHEREUM_PAID_ONLY');return c;};
 const latest=(id:string):Progress|undefined=>options.store.snapshot().events.filter(row=>row.type==='paid_funding_progress'&&row.data.requestId===id).map(row=>row.data as unknown as Progress).sort((a,b)=>b.revision-a.revision)[0];
 const progress=async(id:string,state:Progress['state'],extra:Pick<Progress,'holdId'|'code'>={})=>{await options.store.transaction(s=>{const prior=s.events.filter(row=>row.type==='paid_funding_progress'&&row.data.requestId===id).map(row=>Number(row.data.revision));const revision=Math.max(0,...prior)+1;s.events.push({id:`paid_funding_progress_${id}_${revision}`,type:'paid_funding_progress',at:now().toISOString(),data:{requestId:id,revision,state,...extra}});});};
 const assertPlan=async(plan:PaidFundingPlan,record?:NativeFundingRecord)=>{
  if(stopped)throw new Error('PAID_FUNDING_STOPPED');
  if(!plan||!plan.owner||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=+now()||Date.parse(plan.owner.expiresAt)<Date.parse(plan.expiresAt))throw new Error('PAID_FUNDING_INTENT_EXPIRED');
  await options.assertOwner(plan.owner);const c=campaign(plan.campaignId);
  if(fundingCampaignDigest(c)!==plan.campaignDigest||c.quantity!==plan.quantity||c.mintPriceWei.toString()!==plan.mintPriceWei||plan.chainId!==1||!sameSet(plan.wallets,plan.shortfalls.map(row=>row.wallet)))throw new Error('PAID_FUNDING_CAMPAIGN_CHANGED');
  await options.assertReady(c,plan.wallets);const inspection=await options.inspect(c,plan.wallets);
  if(inspection.stageDigest!==plan.stageDigest||Date.parse(inspection.phaseEndsAt)<Date.parse(plan.expiresAt)||!sameSet(plan.wallets,inspection.wallets.map(row=>row.wallet)))throw new Error('PAID_FUNDING_STAGE_CHANGED');
  for(const row of inspection.wallets){const approved=plan.shortfalls.find(value=>value.wallet.toLowerCase()===row.wallet.toLowerCase());if(!approved||row.requiredWei.toString()!==approved.requiredWei||row.balanceWei<0n||row.requiredWei-row.balanceWei>BigInt(approved.maxTopupWei))throw new Error('PAID_FUNDING_SHORTFALL_INCREASED');}
  if(record){const approved=plan.shortfalls.find(row=>row.wallet.toLowerCase()===record.request.recipient.toLowerCase());if(!approved||record.request.chainId!==1||record.preparation.valueWei>BigInt(approved.maxTopupWei)||record.request.requiredBalanceWei.toString()!==approved.requiredWei)throw new Error('PAID_FUNDING_TRANSFER_EXCEEDS_APPROVAL');}
  await options.assertOwner(plan.owner);if(stopped)throw new Error('PAID_FUNDING_STOPPED');if(Date.parse(plan.expiresAt)<=+now())throw new Error('PAID_FUNDING_INTENT_EXPIRED');
  return c;
 };
 const intentPlan=(event:EventRecord):PaidFundingPlan=>{const plan=event.data.plan as PaidFundingPlan;if(!plan||event.id!==plan.id||event.data.planDigest!==digest(plan)||event.data.ownerConfirmed!==true||event.data.campaignDigest!==plan.campaignDigest||!Array.isArray(event.data.wallets)||!sameSet(event.data.wallets as string[],plan.wallets)||event.data.expiresAt!==plan.expiresAt)throw new Error('PAID_FUNDING_INTENT_INVALID');return plan;};
 let busy=false,stopped=false,cursor=0;
 return {
  async preview(campaignId:string,wallets:readonly string[],maxFeeGwei:number,owner:PaidFundingOwner){
   await options.assertOwner(owner);const c=campaign(campaignId);const selected=wallets.map(w=>w.toLowerCase()).sort();
   if(!selected.length||selected.length>10||new Set(selected).size!==selected.length||selected.some(w=>!/^0x[a-f0-9]{40}$/.test(w))||!Number.isFinite(maxFeeGwei)||maxFeeGwei<=0||maxFeeGwei>500)throw new Error('PAID_FUNDING_SCOPE_INVALID');
   if(options.store.snapshot().events.some(event=>event.type==='funding_paid_owner_intent'&&event.data.campaignId===c.id&&Date.parse(String(event.data.expiresAt))>+now()&&latest(event.id)?.state!=='blocked'))throw new Error('PAID_FUNDING_INTENT_ALREADY_OPEN');
   await options.assertReady(c,selected);const inspection=await options.inspect(c,selected);
   if(!sameSet(selected,inspection.wallets.map(row=>row.wallet))||typeof inspection.stageDigest!=='string'||!inspection.stageDigest)throw new Error('PAID_FUNDING_INSPECTION_INVALID');
   const expires=Math.min(+now()+15*60000,Date.parse(owner.expiresAt),Date.parse(inspection.phaseEndsAt));if(!Number.isFinite(expires)||expires<=+now())throw new Error('PAID_FUNDING_INTENT_EXPIRED');
   const plan:PaidFundingPlan={id:`paid_funding_${randomUUID()}`,nonce:randomUUID(),owner,campaignId:c.id,campaignDigest:fundingCampaignDigest(c),chainId:1,wallets:selected,maxFeeGwei,quantity:c.quantity,mintPriceWei:c.mintPriceWei.toString(),stageDigest:inspection.stageDigest,expiresAt:new Date(expires).toISOString(),shortfalls:inspection.wallets.map(row=>{if(row.requiredWei<=0n||row.balanceWei<0n)throw new Error('PAID_FUNDING_INSPECTION_INVALID');return {wallet:row.wallet.toLowerCase(),requiredWei:row.requiredWei.toString(),maxTopupWei:(row.requiredWei>row.balanceWei?row.requiredWei-row.balanceWei:0n).toString()};})};
   await options.assertOwner(owner);await options.store.transaction(state=>state.events.push({id:`preview_${plan.id}`,type:'paid_funding_preview',at:now().toISOString(),data:{plan,planDigest:digest(plan)}}));
   return {plan,confirmation:paidFundingPhrase(plan),mintAuthorized:false as const};
  },
  async confirm(id:string,phrase:string,owner:PaidFundingOwner){
   await options.assertOwner(owner);const preview=options.store.snapshot().events.find(event=>event.id===`preview_${id}`&&event.type==='paid_funding_preview');const plan=preview?.data.plan as PaidFundingPlan|undefined;
   if(!plan||preview?.data.planDigest!==digest(plan)||phrase!==paidFundingPhrase(plan)||owner.ownerId!==plan.owner.ownerId||owner.sessionId!==plan.owner.sessionId)throw new Error('PAID_FUNDING_CONFIRMATION_MISMATCH');
   await assertPlan(plan);
   await options.store.transaction(state=>{const existing=state.events.find(row=>row.id===plan.id);if(existing){if(existing.type!=='funding_paid_owner_intent'||existing.data.planDigest!==digest(plan))throw new Error('PAID_FUNDING_INTENT_CONFLICT');return;}if(state.events.some(row=>row.type==='funding_paid_owner_intent'&&row.data.campaignId===plan.campaignId&&Date.parse(String(row.data.expiresAt))>+now()&&!state.events.some(result=>result.type==='paid_funding_progress'&&result.data.requestId===row.id&&result.data.state==='blocked')))throw new Error('PAID_FUNDING_INTENT_ALREADY_OPEN');state.events.push({id:plan.id,type:'funding_paid_owner_intent',at:now().toISOString(),data:{plan,planDigest:digest(plan),campaignId:plan.campaignId,campaignDigest:plan.campaignDigest,wallets:plan.wallets,expiresAt:plan.expiresAt,ownerConfirmed:true,mintAuthorized:false}});});
   return {requestId:id,state:'funding-queued',mintAuthorized:false as const};
  },
  async assertIntent(event:EventRecord,c:Campaign,wallets:readonly string[],record?:NativeFundingRecord){const plan=intentPlan(event);if(c.id!==plan.campaignId||fundingCampaignDigest(c)!==plan.campaignDigest||!sameSet(wallets,plan.wallets)||latest(event.id)?.state==='blocked')throw new Error('PAID_FUNDING_SCOPE_CHANGED');await assertPlan(plan,record);},
  status(){return options.store.snapshot().events.filter(event=>event.type==='funding_paid_owner_intent').slice(-20).map(event=>({id:event.id,campaignId:event.data.campaignId,expiresAt:event.data.expiresAt,state:latest(event.id)?.state??'queued',mintAuthorized:false}));},
  async tick(){if(busy||stopped)return;busy=true;try{
   const queue=options.store.snapshot().events.filter(row=>row.type==='funding_paid_owner_intent'&&latest(row.id)?.state!=='prepared');
   const selected=[...queue.slice(cursor),...queue.slice(0,cursor)].slice(0,20);cursor=queue.length?(cursor+selected.length)%queue.length:0;
   for(const event of selected){
    const prior=latest(event.id);if(prior?.state==='prepared')continue;
    let holdId=prior?.holdId;
    try{
     const plan=intentPlan(event);
     if(holdId)await options.coordinator.reconcileFunding(holdId); // Settlement survives session/intent expiry.
     if(prior?.state==='blocked'){if(holdId)await options.coordinator.releaseFundingHold(holdId).catch(()=>undefined);continue;}
     const c=await assertPlan(plan);if(stopped)return;
     if(!holdId){const hold=await options.coordinator.prepareFunding({campaignId:c.id,wallets:plan.wallets,idempotencyKey:`paid-owner:${event.id}`,expiresAt:plan.expiresAt});holdId=hold.id;await progress(event.id,'funding',{holdId});}
     await assertPlan(plan);await options.coordinator.fundHold(holdId);const rows=await options.coordinator.reconcileFunding(holdId);
     if(rows.some(row=>row.state!=='settled'))continue;
     await assertPlan(plan);const simulations=await options.simulate(c,plan.wallets);
     if(!sameSet(simulations.recorded,plan.wallets))throw new Error('PAID_FUNDING_FRESH_SIMULATION_REQUIRED');
     await assertPlan(plan);if(stopped)return;await progress(event.id,'prepared',{holdId});
     await options.notify(`Paid campaign ${c.id} is funded and freshly simulated. Funding approval did not authorize a mint. Use /fire for final approval before ${plan.expiresAt}.`,`paid-funding:${event.id}:prepared`);
    }catch(error){await progress(event.id,'blocked',{...(holdId?{holdId}:{}),code:code(error)});if(holdId)await options.coordinator.releaseFundingHold(holdId).catch(()=>undefined);await options.notify(`Paid funding request ${event.id} stopped: ${code(error)}. No mint was authorized. Pending transfers remain reserved until reconciled.`,`paid-funding:${event.id}:blocked`).catch(()=>undefined);}
   }
  }finally{busy=false;}},
  stop(){stopped=true;},
 };
}
export type PaidFundingService=ReturnType<typeof createPaidFundingService>;
export function startPaidFundingWorker(service:PaidFundingService,intervalMs=5000){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('PAID_FUNDING_INTERVAL_INVALID');
 let pending:Promise<void>|undefined;
 const tick=()=>{if(pending)return pending;const operation=service.tick();pending=operation.finally(()=>{pending=undefined;});return pending;};
 const timer=setInterval(()=>{void tick().catch(()=>undefined);},intervalMs);timer.unref?.();
 return {tick,stop:async()=>{clearInterval(timer);service.stop();await pending?.catch(()=>undefined);}};
}
