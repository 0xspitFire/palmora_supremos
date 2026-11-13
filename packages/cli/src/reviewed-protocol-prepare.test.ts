import {describe,it,expect,vi} from 'vitest';
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {TelegramAccessRepository} from '@mint-bot/database';
import {TelegramCommandRouter} from './telegram-commands.js';
import type {TelegramBotApi,TelegramUpdate} from './telegram-api.js';
import {timeStepAt} from './totp.js';
import {createTelegramActions,type TelegramActionDeps} from './telegram-actions.js';
import {planReviewedProtocolPreparation,prepareReviewedProtocolCampaign} from './reviewed-protocol-prepare.js';
import {simulateReviewedProtocolCampaign} from './reviewed-protocol-simulation.js';
import {reviewedProtocolFlowFixture,REVIEWED_TEST_WALLET,REVIEWED_TEST_CONTRACT} from './reviewed-protocol-test-fixture.js';

describe('owner reviewed manual prepare and simulate routing',()=>{
 it('routes the authenticated owner-private typed /prepare through the real command router and never accepts another user',async()=>{
  const f=await reviewedProtocolFlowFixture(1);try{const kill=join(f.directory,'kill');writeFileSync(kill,'test');const now=new Date();const access=new TelegramAccessRepository(f.db,()=>now);const actions=createTelegramActions({mode:'host',custody:'turnkey',store:f.store,application:f.app,projectRoot:f.directory,secretRoot:f.directory,killSwitchPath:kill,walletList:async()=>[REVIEWED_TEST_WALLET],reviewedProtocolPlan:(input:Parameters<NonNullable<TelegramActionDeps['reviewedProtocolPlan']>>[0])=>planReviewedProtocolPreparation({...input,store:f.store,killSwitchPath:kill,load:f.load})} as unknown as TelegramActionDeps);const preview=await actions.guidedPlan('ethereum',REVIEWED_TEST_CONTRACT,1,undefined);const replies:string[]=[];const api:TelegramBotApi={getUpdates:async()=>[],sendMessage:async(_chat,text)=>{replies.push(text);},answerCallback:async()=>undefined,deleteMessage:async()=>undefined};const router=new TelegramCommandRouter({api,access,actions,ownerUserId:'1001',totpKey:Buffer.from('synthetic totp marker'),record:async()=>undefined,alert:async()=>undefined,now:()=>now});let id=1;const message=(user=1001):TelegramUpdate=>({update_id:id++,message:{message_id:id++,date:now.getTime()/1000,chat:{id:user,type:'private'},from:{id:user},text:`/prepare ethereum ${REVIEWED_TEST_CONTRACT} 1 ${preview.phrase}`}});const before=f.store.snapshot().campaigns.length;
   await router.handle(message(2002));expect(f.store.snapshot().campaigns).toHaveLength(before);access.startSession(timeStepAt(now),3600000);await router.handle(message());expect(replies.join('\n')).toContain('Campaign recorded:');expect(f.store.snapshot().campaigns).toHaveLength(before+1);expect(f.store.snapshot().campaigns.at(-1)?.strategy).toBe('erc721-reviewed-public-v1');
  }finally{await f.cleanup();}
 });
 it.each([1,8453,4663] as const)('fresh Telegram prepare confirmation persists exact chain%s generic custody then simulates through reviewed transport',async chainId=>{
  const f=await reviewedProtocolFlowFixture(chainId);try{
   const kill=join(f.directory,'kill');writeFileSync(kill,'test');const load=vi.fn(f.load);const fleet=[...Array.from({length:29},(_,i)=>`0x${(i+1).toString(16).padStart(40,'0')}`),REVIEWED_TEST_WALLET];
   const plan=async(input:{chainId:1|8453|4663;contract:string;quantity?:number;wallets:readonly string[]})=>planReviewedProtocolPreparation({...input,store:f.store,killSwitchPath:kill,load});
   const actions=createTelegramActions({mode:'host',custody:'turnkey',store:f.store,application:f.app,projectRoot:f.directory,secretRoot:f.directory,killSwitchPath:kill,walletList:async()=>fleet,reviewedProtocolPlan:plan,reviewedProtocolSimulation:(campaign:Parameters<typeof simulateReviewedProtocolCampaign>[0]['campaign'],wallets:readonly string[])=>simulateReviewedProtocolCampaign({store:f.store,campaign,wallets,load:f.load})} as unknown as TelegramActionDeps);
   const chain=String(chainId),before=f.store.snapshot().campaigns.length;
   const preview=await actions.guidedPlan(chain,REVIEWED_TEST_CONTRACT,1,undefined);expect(preview.ok).toBe(true);expect(preview.phrase).toContain(`PREPARE REVIEWED ERC721 ${chainId}`);
   // A newly read block and harmless monotonic mint progress do not invalidate the reviewed economics.
   f.values['minted']=2n;
   const prepared=await actions.guidedPrepare(chain,REVIEWED_TEST_CONTRACT,1,preview.ready,preview.phrase);expect(prepared.campaignId).toBeTruthy();expect(load.mock.calls.length).toBeGreaterThanOrEqual(3);
   expect(f.store.snapshot().campaigns).toHaveLength(before+1);const campaign=f.store.snapshot().campaigns.find(value=>value.id===prepared.campaignId)!;
   expect(campaign).toMatchObject({chainId,strategy:'erc721-reviewed-public-v1',mintPriceWei:0n,chainVerification:{seaDropCompatible:false,evidenceId:f.campaign.chainVerification.evidenceId},custodyPolicy:f.binding});
   expect(await actions.simulate(campaign.id)).toContain('1 wallet(s) passed');expect(f.store.snapshot().simulations.find(value=>value.campaignId===campaign.id)).toMatchObject({success:true,sourceBlock:98n});
   // The typed /prepare action uses the same verified route and rechecks kill before writing.
   unlinkSync(kill);await expect(actions.prepare(chain,REVIEWED_TEST_CONTRACT,1,preview.phrase!)).rejects.toThrow('KILL_SWITCH_REQUIRED');expect(f.store.snapshot().campaigns).toHaveLength(before+1);
  }finally{await f.cleanup();}
 });
 it('rejects changed stage, revoked authority and forged or stale plan without recording a campaign',async()=>{
  const f=await reviewedProtocolFlowFixture(1);try{const kill=join(f.directory,'kill');writeFileSync(kill,'test');const opts={store:f.store,chainId:1 as const,contract:REVIEWED_TEST_CONTRACT,wallets:[REVIEWED_TEST_WALLET],quantity:1,killSwitchPath:kill,load:f.load};const initial=await planReviewedProtocolPreparation(opts);expect(initial).toBeTruthy();
   f.values['closes']=BigInt(f.values['closes'] as bigint)+60n;const fresh=await planReviewedProtocolPreparation(opts);expect(fresh!.phrase).not.toBe(initial!.phrase);const create=vi.fn(input=>f.app.createCampaign(input));
   await expect(prepareReviewedProtocolCampaign({plan:fresh!,confirm:initial!.phrase,killSwitchPath:kill,createCampaign:create})).rejects.toThrow('CONFIRMATION_REQUIRED');
   await expect(prepareReviewedProtocolCampaign({plan:{...fresh!},confirm:fresh!.phrase,killSwitchPath:kill,createCampaign:create})).rejects.toThrow('CONFIRMATION_REQUIRED');
   await expect(prepareReviewedProtocolCampaign({plan:fresh!,confirm:fresh!.phrase,killSwitchPath:kill,createCampaign:create,now:()=>new Date(Date.now()+31000)})).rejects.toThrow('CONFIRMATION_REQUIRED');
   await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===f.campaign.chainVerification.evidenceId)!.executionEnabled=false;});await expect(planReviewedProtocolPreparation(opts)).rejects.toThrow('BASELINE_REQUIRED');expect(create).not.toHaveBeenCalled();
  }finally{await f.cleanup();}
 });
 it('keeps an absent owner profile unclassified and refuses own-wallet failure',async()=>{const f=await reviewedProtocolFlowFixture(1);try{const opts={store:f.store,chainId:1 as const,contract:REVIEWED_TEST_CONTRACT,wallets:[REVIEWED_TEST_WALLET],killSwitchPath:join(f.directory,'kill')};expect(await planReviewedProtocolPreparation({...opts,load:async()=>undefined})).toBeUndefined();f.fail();await expect(planReviewedProtocolPreparation({...opts,load:f.load})).rejects.toThrow('NO_READY_WALLETS');}finally{await f.cleanup();}});
});
