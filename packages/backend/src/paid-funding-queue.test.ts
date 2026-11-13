import {afterEach,describe,expect,it,vi} from 'vitest';
import {initializeMintFundingHolds,initializeNativeFundingRepository,type NativeFundingPolicy,type NativeFundingPreparation} from '@mint-bot/database';
import {ExecutionCoordinator} from './coordinator.js';
import {FundingCoordinatorService} from './native-funding.js';
import {ETHEREUM,NOW,WALLET_ONE,WALLET_TWO,fixture,campaignInput,close,noopEngine} from './canonical-fixtures.js';
afterEach(()=>vi.useRealTimers());
const FEE=370_000_000_000_000n,REQUIRED=FEE+100n;
const HASH=`0x${'b'.repeat(64)}`,HUB=`0x${'4'.repeat(40)}`,DIGEST=`sha256:${'a'.repeat(64)}`;
async function setup(){
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));const sql=await fixture(ETHEREUM,true,true,undefined,true,undefined,()=>new Date());
 initializeMintFundingHolds(sql.db);initializeNativeFundingRepository(sql.db);sql.db.prepare('UPDATE fee_policy SET max_total_fee_wei=?').run(FEE.toString());const selected=await sql.application.createCampaign({...campaignInput(ETHEREUM,true),maxRunWei:REQUIRED,dailyCapWei:REQUIRED,gasCeilingWei:FEE,feePolicy:{kind:'paid',configuredPriorityFeeWei:100000000n,l2ExecutionGasBudgetWei:FEE-100000000n,l1DataGasBudgetWei:0n,totalFeeBudgetWei:FEE}});for(const address of [WALLET_ONE,WALLET_TWO]){sql.db.prepare('INSERT INTO wallet(id,chain_profile_id,address,key_reference,created_at) VALUES(?,?,?,?,?)').run(`w-${address}`,'profile-1',address,'test-key',NOW);sql.db.prepare('INSERT INTO campaign_wallet(campaign_id,wallet_id,enabled,selected_at) VALUES(?,?,1,?)').run(selected.id,`w-${address}`,NOW);}
 await sql.store.transaction(state=>{state.runtime={startupState:'Ready',blockingReasons:[],dependencies:{engine:true,chain:true,backup:true,notifications:true}};});
 const {createPaidFundingService}=await import(new URL('../../cli/dist/paid-funding-service.js',import.meta.url).href);
 const {qualifyNativeFundingCampaign}=await import(new URL('../../cli/dist/native-funding-runtime.js',import.meta.url).href);
 const {recordPassingSimulationsAction}=await import(new URL('../../cli/dist/owner-actions.js',import.meta.url).href);
 const expires=new Date(Date.now()+600_000).toISOString();let finalized=false,funded=false,ownerValid=true,stage='reviewed:phase-one',signs=0;
 const policy:NativeFundingPolicy={kind:'native-fleet-topup-v1',active:true,chainId:1,hub:HUB,recipients:[WALLET_ONE,WALLET_TWO],walletSetDigest:DIGEST,recordDigest:DIGEST,budgetProfileDigest:DIGEST,policyReference:'signed:funding',expiresAt:expires,maxTransferWei:REQUIRED,rollingPrincipalCapWei:REQUIRED*2n,rollingFeeCapWei:100n,maxTransferFeeWei:100n,hubMaxBalanceWei:REQUIRED*10n,hubReserveWei:0n,recipientMaxBalanceWei:REQUIRED,fleetMaxBalanceWei:REQUIRED*2n,gasLimitMax:2n,maxFeePerGas:1n,maxPriorityFeePerGas:1n};
 const repository=sql.store.createNativeFundingRepository(()=>policy);
 let queue:ReturnType<typeof createPaidFundingService>;
 const assertIntent=async(event:never,c:never,wallets:string[],record?:never)=>queue.assertIntent(event,c,wallets,record);
 const funding=new FundingCoordinatorService({repository,policy:()=>policy,now:()=>new Date(),assertReady:async record=>{const hold=sql.store.fundingHold(record.request.parentHoldId)!;const event=sql.store.snapshot().events.find(row=>row.id===hold.qualification.ownerApprovedIntentId)!;await queue.assertIntent(event,hold.campaign,hold.wallets,record);},engine:{prepare:async()=>({hub:HUB,valueWei:REQUIRED,recipientBalanceWei:0n,fleetBalanceWei:0n,hubBalanceWei:REQUIRED*5n,gasLimit:2n,maxFeePerGas:1n,maxPriorityFeePerGas:1n,l1DataFeeBoundWei:0n,operatorFeeBoundWei:0n,nonce:0,observedAt:new Date().toISOString(),blockNumber:1n,blockHash:HASH,recipientCode:'0x'} satisfies NativeFundingPreparation),execute:async(_record,hooks)=>{await hooks.assertCurrent();await hooks.claimForSigning();signs++;await hooks.persistSigned(HASH);await hooks.markBroadcasting();await hooks.markSubmitted(HASH);return {hash:HASH};}},receipts:async()=>finalized?['first.example','second.example'].map(readerHost=>({readerHost,observedAt:new Date().toISOString(),chainId:1,transactionHash:HASH,from:HUB,to:WALLET_ONE,valueWei:REQUIRED,data:'0x',nonce:0,blockNumber:1n,blockHash:HASH,gasUsed:2n,effectiveGasPrice:1n,l1DataFeeWei:0n,operatorFeeWei:0n,success:true,finalityStage:'ethereum_final',finalityEvidenceReference:'test:final'})):[]});
 const coordinator=new ExecutionCoordinator(sql.store,noopEngine,{funding:{service:funding,assertReady:async()=>undefined,qualify:(c,wallets)=>qualifyNativeFundingCampaign({store:sql.store,campaign:c,wallets,readers:[],assertPaidFundingIntent:assertIntent,now:new Date()})}});
 const owner={ownerId:'owner',sessionId:'unlocked-session',expiresAt:expires};
 const notify=vi.fn(async()=>undefined),simulate=vi.fn(async(c:typeof selected,wallets:string[])=>recordPassingSimulationsAction({store:sql.store,campaign:c,wallets,port:{chainId:1,hasCode:async()=>true,readDrop:async()=>({nftContract:c.contract,priceWei:100n,startTime:Math.floor(Date.parse(NOW)/1000)-60,endTime:Math.floor(Date.parse(expires)/1000),maxPerWallet:10,maxSupply:100n,totalMinted:0n}),balance:async()=>funded?REQUIRED:0n,simulateMint:async()=>({outcome:'pass'})},latestBlock:async()=>({number:1n,hash:'0xblock'})}));
 const options={store:sql.store,coordinator,now:()=>new Date(),assertOwner:async(value:typeof owner)=>{if(!ownerValid||value.ownerId!==owner.ownerId||value.sessionId!==owner.sessionId)throw new Error('PAID_FUNDING_OWNER_SESSION_REQUIRED');},assertReady:async()=>undefined,inspect:async(_c:typeof selected,wallets:string[])=>({stageDigest:stage,phaseEndsAt:expires,wallets:wallets.map(wallet=>({wallet,requiredWei:REQUIRED,balanceWei:funded?REQUIRED:0n}))}),simulate,notify};queue=createPaidFundingService(options);
 const preview=await queue.preview(selected.id,[WALLET_ONE],0.2,owner);
 return {sql,selected,owner,preview,notify,simulate,get queue(){return queue;},restart:()=>{queue=createPaidFundingService(options);},signs:()=>signs,finalize:()=>{finalized=true;funded=true;},lock:()=>{ownerValid=false;},drift:()=>{stage='changed:phase';}};
}
describe('owner-confirmed paid funding queue through actual canonical coordinator',()=>{
 it('funds once, resumes finality after restart, records genuine fresh simulations and only notifies; never arms or mints',async()=>{
  const s=await setup();try{
   expect(s.sql.store.snapshot().events.some(row=>row.type==='funding_paid_owner_intent')).toBe(false);
   await s.queue.tick();expect(s.signs()).toBe(0);
   expect(await s.queue.confirm(s.preview.plan.id,s.preview.confirmation,s.owner)).toMatchObject({mintAuthorized:false});
   await s.queue.tick();expect(s.signs()).toBe(1);expect(s.simulate).not.toHaveBeenCalled();expect(s.sql.store.snapshot().runs).toEqual([]);
   const held=s.sql.store.unresolvedFundingHoldIds();expect(held).toHaveLength(1);s.restart();await s.queue.tick();expect(s.signs()).toBe(1);
   s.finalize();await s.queue.tick();expect(s.simulate).toHaveBeenCalledOnce();await expect(s.simulate.mock.results[0]!.value).resolves.toMatchObject({recorded:[WALLET_ONE]});expect(s.sql.store.snapshot().simulations,JSON.stringify(s.notify.mock.calls)).toHaveLength(1);
   expect(s.sql.store.snapshot().runs).toEqual([]);expect(s.sql.store.unclaimedLiveRunRequests()).toEqual([]);
   expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('Use /fire for final approval'),expect.any(String));
   await s.queue.tick();expect(s.signs()).toBe(1);expect(s.simulate).toHaveBeenCalledOnce();
  }finally{await close(s.sql);}
 });
 it.each(['session','stage','expiry'] as const)('refuses changed %s after funding confirmation and never signs',async(change)=>{
  const s=await setup();try{await s.queue.confirm(s.preview.plan.id,s.preview.confirmation,s.owner);if(change==='session')s.lock();else if(change==='stage')s.drift();else vi.setSystemTime(new Date(Date.parse(s.preview.plan.expiresAt)+1));await s.queue.tick();expect(s.signs()).toBe(0);expect(s.simulate).not.toHaveBeenCalled();expect(s.queue.status()[0]?.state).toBe('blocked');}finally{await close(s.sql);}
 });
 it('reconciles already submitted funds after session expiry without simulating or authorizing a mint',async()=>{
  const s=await setup();try{await s.queue.confirm(s.preview.plan.id,s.preview.confirmation,s.owner);await s.queue.tick();expect(s.signs()).toBe(1);s.lock();s.finalize();await s.queue.tick();expect(s.signs()).toBe(1);expect(s.simulate).not.toHaveBeenCalled();expect(s.sql.store.unresolvedFundingHoldIds()).toEqual([]);expect(s.sql.store.snapshot().runs).toEqual([]);}finally{await close(s.sql);}
 });
 it('rejects wrong confirmation and owner identity, preserving an unconfirmed preview without funding authority',async()=>{
  const s=await setup();try{await expect(s.queue.confirm(s.preview.plan.id,'wrong',s.owner)).rejects.toThrow('CONFIRMATION_MISMATCH');await expect(s.queue.confirm(s.preview.plan.id,s.preview.confirmation,{...s.owner,sessionId:'other'})).rejects.toThrow('OWNER_SESSION_REQUIRED');await s.queue.tick();expect(s.signs()).toBe(0);}finally{await close(s.sql);}
 });
 it('rejects a fabricated funding event without the actual owner-confirmed queue plan',async()=>{
  const s=await setup();try{
   const {qualifyNativeFundingCampaign}=await import(new URL('../../cli/dist/native-funding-runtime.js',import.meta.url).href);
   const {fundingCampaignDigest}=await import('./funding-hold.js');
   await s.sql.store.transaction(state=>state.events.push({id:'forged-intent',type:'funding_paid_owner_intent',at:NOW,data:{campaignId:s.selected.id,campaignDigest:fundingCampaignDigest(s.selected),ownerConfirmed:true,wallets:[WALLET_ONE],expiresAt:s.preview.plan.expiresAt}}));
   const input={store:s.sql.store,campaign:s.selected,wallets:[WALLET_ONE],readers:[],now:new Date()};
   await expect(qualifyNativeFundingCampaign(input)).rejects.toThrow('FUNDING_PAID_OWNER_INTENT_REQUIRED');
   await expect(qualifyNativeFundingCampaign({...input,assertPaidFundingIntent:s.queue.assertIntent})).rejects.toThrow('PAID_FUNDING_INTENT_INVALID');expect(s.signs()).toBe(0);
  }finally{await close(s.sql);}
 });

});
