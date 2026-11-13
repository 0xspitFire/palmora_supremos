import {describe,expect,it,vi} from 'vitest';
import {DurableStore,campaignInputDigest,type Campaign} from '@mint-bot/backend';
import type {DropConfig} from '@mint-bot/engine';
import type {FireScheduleRecord} from '@mint-bot/database';
import {createMintStageRuntime} from './mint-stage-runtime.js';
import {createFireScheduler,startFireScheduler} from './fire.js';
const NOW=Date.parse('2026-11-13T12:00:00Z');const contract=`0x${'1'.repeat(40)}` as const;const wallet=`0x${'2'.repeat(40)}` as const;
async function fixture(){let clock=NOW;let drop:DropConfig={nftContract:contract,chainId:1,mintPrice:0n,maxTotalMintableByWallet:10,maxTokenSupply:100n,totalMinted:1n,startTime:NOW/1000+60,endTime:NOW/1000+3600,feePayer:wallet,strategyName:'seadrop-v1-public'};const campaign:Campaign={id:'campaign',state:'Draft',chainId:1,contract,strategy:'seadrop-v1-public',quantity:1,dryRun:false,mintPriceWei:0n,spendPolicy:{maxRunWei:400000000000000n,dailyCapWei:400000000000000n,gasCeilingWei:400000000000000n},feePolicy:{kind:'free',configuredPriorityFeeWei:100000000n,totalFeeBudgetWei:400000000000000n},chainVerification:{chainId:1,status:'verified',seaDropCompatible:true,endpointReference:'configured-provider'},createdAt:new Date(NOW).toISOString(),updatedAt:new Date(NOW).toISOString()};const store=new DurableStore();await store.transaction(state=>state.campaigns.push(campaign));const validate=vi.fn(async()=>undefined);const runtime=createMintStageRuntime({store,now:()=>new Date(clock),readDrop:async()=>drop,validate});const schedule:FireScheduleRecord={id:'schedule',campaignId:campaign.id,campaignDigest:campaignInputDigest(campaign),wallets:[wallet],maxFeeGwei:'0.2',windowFrom:new Date(NOW).toISOString(),windowUntil:new Date(NOW+3600000).toISOString(),confirmationDigest:'owner-confirmed',createdAt:new Date(NOW).toISOString()};return {store,runtime,campaign,schedule,validate,advance:(milliseconds:number)=>{clock+=milliseconds;},set:(value:Partial<DropConfig>)=>{drop={...drop,...value};},now:()=>new Date(clock)};}
describe('actual stage scheduler bridge',()=>{
 it('accepts delayed confirmation idempotently, refreshes moved opening inside the original window, and executes once',async()=>{
 const f=await fixture();const candidate=await f.runtime.prepare(f.campaign);f.advance(2000);await f.runtime.bind(f.schedule,candidate);await f.runtime.bind(f.schedule,candidate);expect(f.store.snapshot().events.filter(event=>event.type==='mint_stage_schedule_approved')).toHaveLength(1);
 let claimed=false;let executions=0;const scheduler=createFireScheduler({schedules:()=>claimed?[]:[f.schedule],claim:()=>{if(claimed)return false;claimed=true;return true;},campaign:()=>f.campaign,campaignDigest:campaignInputDigest,killSwitchOn:()=>false,mintState:async()=> 'open',stageDecision:f.runtime.inspect,fire:async record=>{await f.runtime.claim(record,f.campaign);executions++;},record:async()=>undefined,alert:async()=>undefined,now:f.now});
 expect(await scheduler.tick()).toBe(0);expect(f.validate).not.toHaveBeenCalled();f.set({startTime:NOW/1000+120});f.advance(2000);expect(await scheduler.tick()).toBe(0);expect(f.store.snapshot().events.some(event=>event.type==='mint_stage_rescheduled'&&event.data.scheduledAt===new Date(NOW+120000).toISOString())).toBe(true);
 f.advance(120000);expect(await scheduler.tick()).toBe(1);expect(f.validate).toHaveBeenCalled();expect(await scheduler.tick()).toBe(0);expect(executions).toBe(1);await expect(f.runtime.claim(f.schedule,f.campaign)).rejects.toThrow('MINT_STAGE_EXECUTION_ALREADY_STARTED');
 });
 it.each(['price','method','root','cap','supply-cap','outside-window'] as const)('invalidates old approval for %s drift before a scheduler claim',async kind=>{
 const f=await fixture();await f.runtime.bind(f.schedule,await f.runtime.prepare(f.campaign));f.advance(2000);
 if(kind==='price')f.set({mintPrice:1n});if(kind==='method')f.set({strategyName:'seadrop-v1-signed'});if(kind==='root')f.set({extra:{allowlistRoot:`0x${'a'.repeat(64)}`}});if(kind==='cap')f.set({maxTotalMintableByWallet:9});if(kind==='supply-cap')f.set({maxTokenSupply:200n});if(kind==='outside-window')f.set({startTime:NOW/1000+7200,endTime:NOW/1000+9000});
 expect((await f.runtime.inspect(f.schedule,f.campaign)).state).toBe('blocked');expect(f.validate).not.toHaveBeenCalled();expect(f.store.snapshot().events.some(event=>event.type==='mint_stage_execution_started')).toBe(false);
 });
 it('preserves the seven-day lead and six-hour owner window without treating normal supply progress as a new grant',async()=>{
 const f=await fixture();const from=NOW+7*86400000;f.schedule.windowFrom=new Date(from).toISOString();f.schedule.windowUntil=new Date(from+6*3600000).toISOString();f.set({startTime:from/1000+60,endTime:from/1000+3600});await f.runtime.bind(f.schedule,await f.runtime.prepare(f.campaign));f.advance(7*86400000+120000);f.set({totalMinted:5n});expect((await f.runtime.inspect(f.schedule,f.campaign)).state).toBe('ready');expect(f.validate).toHaveBeenCalledOnce();
 });
});

it('rechecks queued scheduled requests against their original window and material authority without another claim',async()=>{
 const f=await fixture();await f.runtime.bind(f.schedule,await f.runtime.prepare(f.campaign));f.advance(120000);await f.runtime.claim(f.schedule,f.campaign);await f.runtime.assertRequested(f.schedule,f.campaign,[wallet]);expect(f.store.snapshot().events.filter(event=>event.type==='mint_stage_execution_started')).toHaveLength(1);
 f.advance(1001);f.set({extra:{merkleRoot:`0x${'b'.repeat(64)}`}});await expect(f.runtime.assertRequested(f.schedule,f.campaign,[wallet])).rejects.toThrow('MINT_STAGE_MATERIAL_REVISION_REQUIRES_APPROVAL');
 const clean=await fixture();await clean.runtime.bind(clean.schedule,await clean.runtime.prepare(clean.campaign));clean.advance(120000);await clean.runtime.claim(clean.schedule,clean.campaign);clean.advance(3600000);await expect(clean.runtime.assertRequested(clean.schedule,clean.campaign,[wallet])).rejects.toThrow('MINT_STAGE_OUTSIDE_OWNER_WINDOW');
});

it('a scheduler stopped during awaited stage validation cannot claim or fire later',async()=>{
 const f=await fixture();f.advance(120000);let resolve!:(value:{state:'ready'})=>void;const pending=new Promise<{state:'ready'}>(done=>{resolve=done;});const claim=vi.fn(()=>true),fire=vi.fn(async()=>undefined);const scheduler=startFireScheduler({schedules:()=>[f.schedule],claim,campaign:()=>f.campaign,campaignDigest:campaignInputDigest,killSwitchOn:()=>false,mintState:async()=> 'open',stageDecision:()=>pending,fire,record:async()=>undefined,alert:async()=>undefined,now:f.now});const tick=scheduler.tick();scheduler.stop();resolve({state:'ready'});expect(await tick).toBe(0);expect(claim).not.toHaveBeenCalled();expect(fire).not.toHaveBeenCalled();
});
