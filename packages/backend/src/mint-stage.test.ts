import {describe,expect,it} from 'vitest';
import {DurableStore} from './store.js';
import {MintStageService,type MintStageSnapshot,type MintStageRequest} from './mint-stage.js';
const now=new Date('2026-11-13T12:00:00Z');
function stage():MintStageSnapshot{return {chainId:1,collection:`0x${'1'.repeat(40)}`,stageId:'public-1',method:'seadrop-v1-public',observedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),startsAt:new Date(+now-1000).toISOString(),endsAt:new Date(+now+3600000).toISOString(),priceWei:'0',maxPerWallet:10,maxSupply:'100',totalMinted:'1',feeRecipient:`0x${'2'.repeat(40)}`,proofBinding:'public-none',authorityReference:'common-block-verified'};}
async function request(service:MintStageService,snapshot:MintStageSnapshot):Promise<MintStageRequest>{const revision=await service.observe(snapshot);return {requestId:'run-1',createdAt:now.toISOString(),identity:snapshot,quantity:4,executionState:'not_started',approvedRevision:revision.revision,approvedDigest:revision.digest,validation:{revision:revision.revision,digest:revision.digest,expiresAt:new Date(+now+30000).toISOString(),eligibility:true,simulation:true,custody:true}};}
describe('durable mint stage revisions',()=>{
 it('reschedules a moved phase only after fresh validation without a new execution budget',async()=>{
 const store=new DurableStore();const service=new MintStageService(store,()=>now);const initial=stage();const queued=await request(service,initial);expect((await service.evaluate(queued,initial)).state).toBe('ready');
 const moved={...initial,startsAt:new Date(+now+3600000).toISOString(),endsAt:new Date(+now+7200000).toISOString()};
 expect(await service.evaluate(queued,moved)).toMatchObject({state:'refresh_required',approvalInvalidated:true,budgetAction:'preserve-existing'});
 const refreshed=await request(service,moved);expect(await service.evaluate(refreshed,moved)).toMatchObject({state:'reschedule',scheduledAt:moved.startsAt,approvalInvalidated:false,budgetAction:'preserve-existing'});
 expect(store.snapshot().reservations).toEqual([]);expect(store.snapshot().runs).toEqual([]);
 });
 it.each(['price','proof','recipient','supply','cap','method'] as const)('invalidates old approval after %s drift',async kind=>{
 const service=new MintStageService(new DurableStore(),()=>now);const initial=stage();const queued=await request(service,initial);const moved={...initial};
 if(kind==='price')moved.priceWei='1';if(kind==='proof')moved.proofBinding='new-proof';if(kind==='recipient')moved.feeRecipient=`0x${'3'.repeat(40)}`;if(kind==='supply')moved.totalMinted='2';if(kind==='cap')moved.maxPerWallet=9;if(kind==='method')moved.method='seadrop-v1-signed';
 expect(await service.evaluate(queued,moved)).toMatchObject({state:'refresh_required',approvalInvalidated:true,budgetAction:'preserve-existing'});
 });
 it('never repeats a started execution across restart, even when the mint stage moves',async()=>{
 const store=new DurableStore();const service=new MintStageService(store,()=>now);const snapshot=stage();const queued=await request(service,snapshot);await service.markExecutionStarted(queued,snapshot);
 const restarted=new MintStageService(store,()=>now);expect(await restarted.evaluate(queued,{...snapshot,totalMinted:'2'})).toMatchObject({state:'blocked',reason:'MINT_STAGE_EXECUTION_ALREADY_STARTED'});await expect(restarted.markExecutionStarted(queued,snapshot)).rejects.toThrow('MINT_STAGE_EXECUTION_ALREADY_STARTED');expect(store.snapshot().events.filter(event=>event.type==='mint_stage_execution_started')).toHaveLength(1);
 });
 it('rejects unvalidated, stale, overbound and ended schedules',async()=>{
 const service=new MintStageService(new DurableStore(),()=>now);const snapshot=stage();const queued=await request(service,snapshot);
 expect((await service.evaluate({...queued,validation:undefined},snapshot)).state).toBe('refresh_required');
 expect((await service.evaluate(queued,{...snapshot,expiresAt:now.toISOString()})).state).toBe('blocked');
 expect((await service.evaluate(queued,{...snapshot,startsAt:new Date(+now+7*3600000).toISOString(),endsAt:new Date(+now+8*3600000).toISOString()})).reason).toBe('MINT_STAGE_SCHEDULE_OUTSIDE_BOUNDS');
 expect((await service.evaluate({...queued,createdAt:new Date(+now-8*86400000).toISOString()},snapshot)).reason).toBe('MINT_STAGE_REQUEST_EXPIRED');
 expect((await service.evaluate(queued,{...snapshot,totalMinted:'100'})).reason).toBe('MINT_STAGE_ENDED_OR_SOLD_OUT');
 });
});
