import {describe,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {encodeEventTopics,encodeFunctionData,parseAbi,zeroAddress,type Address} from 'viem';
import {BackendApplication,EvidenceService,PERSONAL_LIVE_FLEET_POLICY,type EventRecord} from '@mint-bot/backend';
import {createHostReplicationQualifier} from './replication-qualifier.js';
import {createReplicationAutomation} from './replication-automation.js';
import {prepareReplication} from './replication-prepare.js';
import {createFireWiring} from './fire-wiring.js';
import {processLiveRunRequests} from './live-request.js';
import {simulateReviewedProtocolCampaign} from './reviewed-protocol-simulation.js';
import {selectReviewedProtocolPolicy} from './reviewed-protocol-profile.js';
import {reviewedProtocolFlowFixture,REVIEWED_TEST_WALLET as wallet,REVIEWED_TEST_CONTRACT as contract,REVIEWED_TEST_HASH as hash} from './reviewed-protocol-test-fixture.js';
const watched=`0x${'4'.repeat(40)}` as Address;
const ABI=parseAbi(['function mint(uint256 quantity) payable','event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
async function setup(chainId:1|8453|4663, approvedWallets:readonly Address[]=[wallet],candidates:readonly Address[]=approvedWallets,observedQuantity=1,maxQuantity=1){
 const f=await reviewedProtocolFlowFixture(chainId,approvedWallets);const at=new Date().toISOString();const mintedAt=Math.floor(Date.now()/1000)-10;
 const tx={hash,from:watched,to:contract,value:0n,input:encodeFunctionData({abi:ABI,functionName:'mint',args:[BigInt(observedQuantity)]}),blockNumber:98n,blockHash:hash};
 const receipt={transactionHash:hash,from:watched,to:contract,status:'success',blockNumber:98n,blockHash:hash,logs:Array.from({length:observedQuantity},(_,index)=>({address:contract,data:'0x',topics:encodeEventTopics({abi:ABI,eventName:'Transfer',args:{from:zeroAddress,to:watched,tokenId:BigInt(index+7)}}),logIndex:index,removed:false,blockHash:hash,transactionHash:hash}))};
 for(const client of f.clients)Object.assign(client,{getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getBlock:async()=>({hash,timestamp:BigInt(mintedAt)})});
 const load=vi.fn(async()=>({registry:f.registry,strategy:f.strategy,clients:f.clients}));const records=vi.fn(async()=>[f.record]);
 const qualify=createHostReplicationQualifier({store:f.store,secretRoot:'/synthetic',maxQuantity,reader:async()=>f.clients[0],watchedWallets:()=>[watched],loadReviewed:load,records});
 const app=new BackendApplication(f.store,f.coordinator,{fleetPolicy:PERSONAL_LIVE_FLEET_POLICY,custodyPolicyFor:async input=>selectReviewedProtocolPolicy(await records(),input,f.registry)});
 const source:EventRecord={id:'actual-watched-source',type:'watched_wallet_mint',at,data:{chainId,contract,wallet:watched,txHash:hash}};
 await f.store.transaction(state=>state.events.push(source,{id:'actual-scored-opportunity',type:'opportunity_scored',at,data:{chainId,contract,score:70,blocked:false,expiresAt:new Date(Date.now()+15*60000).toISOString()}}));
 const legacy=vi.fn(async()=>{throw new Error('LEGACY_SEADROP_MUST_NOT_RUN');});
 const fire=createFireWiring({mode:'host',store:f.store,approve:validated=>app.command('approve',{validated}),killSwitchPath:join(f.directory,'off'),fireSchedules:()=>f.store.fireScheduleRepository(),unclaimedRequests:()=>f.store.unclaimedLiveRunRequests(),startedRequests:()=>[],walletList:async()=>[wallet],evmPort:legacy,evmLatestBlock:legacy,robinhoodDryRun:legacy,robinhoodLatestBlock:legacy,balanceOf:async()=>10n**18n,kick:()=>undefined,assertUnattendedReady:async()=>undefined,reviewedProtocolSimulation:(campaign,wallets)=>simulateReviewedProtocolCampaign({store:f.store,campaign,wallets,load:f.load})});
 const prepare=vi.fn((qualified:Awaited<ReturnType<typeof qualify>>,wallets:readonly Address[])=>prepareReplication({source:qualified,wallets,maxQuantity,maxFeeGwei:0.2,tipWei:100000000n,store:f.store,createCampaign:input=>app.createCampaign(input),now:new Date()}));
 const fundedWallets=vi.fn(async(source:Awaited<ReturnType<typeof qualify>>,wallets:readonly Address[])=>wallets.filter(wallet=>source.plan.targets.some(target=>target.wallet.toLowerCase()===wallet.toLowerCase())));
 const automation=createReplicationAutomation({store:f.store,watchedWallets:()=>[watched],wallets:async()=>[...candidates],qualify,fundedWallets,assertSourceAuthority:qualify.assertSourceAuthority,prepare,fire:fire.fireDeps,fireAutonomous:fire.fireAutonomous,assertUnattendedReady:async()=>undefined,notify:async()=>undefined});
 return {...f,qualify,app,source,load,records,prepare,automation,legacy,tx,receipt,fundedWallets};
}
describe('actual host reviewed protocol autonomous composition',()=>{
 it.each([1,8453,4663] as const)('qualifies independently, prepares, simulates, queues and canonically arms chain %s without SeaDrop',async chainId=>{
  const f=await setup(chainId);try{
   await f.automation.tick();const state=f.store.snapshot();expect(f.prepare).toHaveBeenCalledOnce();expect(f.load.mock.calls.length).toBeGreaterThanOrEqual(4);expect(f.legacy).not.toHaveBeenCalled();
   const claim=state.events.filter(event=>event.type==='replication_claim');expect(claim).toHaveLength(1);
   const request=f.store.unclaimedLiveRunRequests()[0];expect(request,JSON.stringify(state.events.filter(event=>event.type==='replication_decision').map(event=>event.data))).toBeTruthy();
   const campaign=state.campaigns.find(value=>value.id===request!.campaignId)!;expect(campaign).toMatchObject({strategy:'erc721-reviewed-public-v1',mintPriceWei:0n,chainVerification:{seaDropCompatible:false},custodyPolicy:{reviewedProtocol:{registryDigest:f.registry.digest,descriptorDigest:f.binding.reviewedProtocol!.descriptorDigest}}});
   let armed=false;const outcomes:unknown[]=[];
   await processLiveRunRequests({unclaimed:()=>f.store.unclaimedLiveRunRequests(),claim:(id,outcome)=>f.store.claimLiveRunRequest(id,outcome),campaign:id=>f.store.snapshot().campaigns.find(value=>value.id===id),command:async(name,input)=>{if(name==='run')throw new Error('TEST_STOPS_AFTER_REAL_CANONICAL_ARM');const run=await f.app.command<{id:string;state:string}>('arm',input);armed=true;return run;},setFeeCeiling:()=>undefined,record:async event=>{outcomes.push(event);},assertUnattendedReady:async()=>undefined,assertAutomationReady:f.automation.assertReady,now:()=>new Date()});
   expect(armed).toBe(true);expect(f.store.snapshot().runs).toHaveLength(1);expect(f.store.snapshot().runs[0]?.state).toBe('Armed');expect(outcomes).toEqual([expect.objectContaining({state:'stopped',code:'TEST_STOPS_AFTER_REAL_CANONICAL_ARM'})]);
   await f.automation.tick();expect(f.prepare).toHaveBeenCalledOnce();
  }finally{await f.cleanup();}
 });
 it.each(['missing','expired','revoked','mismatched-registry','missing-custody','expired-custody','registry-during-await','custody-during-await','stale-source'] as const)('refuses %s authority before claim/request',async mode=>{
  const f=await setup(1);try{
   if(mode==='missing')f.load.mockResolvedValue(undefined as never);
   if(mode==='expired'){f.load.mockImplementation(async()=>({registry:{...f.registry,expiresAt:new Date(Date.now()-1).toISOString()} as typeof f.registry,strategy:f.strategy,clients:f.clients}));}
   if(mode==='revoked')await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===f.campaign.chainVerification.evidenceId)!.executionEnabled=false;});
   if(mode==='mismatched-registry'){
    const original=f.store.snapshot().chainEvidence.find(value=>value.id===f.campaign.chainVerification.evidenceId)!;
    await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===original.id)!.executionEnabled=false;});
    const service=new EvidenceService(f.store,()=>new Date(),{verify:()=>true});
    const {acceptedAt:_at,acceptedBy:_by,approvalProof:_proof,...pending}=original;
    await service.recordChainEvidence({...pending,id:'other-registry-baseline',status:'pending',executionEnabled:false,reviewedProtocol:{...original.reviewedProtocol!,registryDigest:`sha256:${'f'.repeat(64)}`}});
    await service.acceptChainEvidence('other-registry-baseline',{verifierId:'owner-cli',proof:'synthetic-other-registry',acceptedAt:new Date().toISOString()});
   }
   if(mode==='missing-custody')f.records.mockResolvedValue([]);
   if(mode==='expired-custody')f.records.mockResolvedValue([{...f.record,expiresAt:new Date(Date.now()-1).toISOString()}]);
   if(mode==='registry-during-await')f.load.mockResolvedValueOnce({registry:f.registry,strategy:f.strategy,clients:f.clients}).mockResolvedValueOnce(undefined as never);
   if(mode==='custody-during-await')f.records.mockResolvedValueOnce([f.record]).mockResolvedValueOnce([]);
   if(mode==='stale-source')for(const client of f.clients)Object.assign(client,{getBlock:async()=>({hash,timestamp:BigInt(Math.floor(Date.now()/1000)-16*60)})});
   await f.automation.tick();expect(f.prepare).not.toHaveBeenCalled();expect(f.store.snapshot().events.some(event=>event.type==='replication_claim')).toBe(false);expect(f.store.unclaimedLiveRunRequests()).toHaveLength(0);
  }finally{await f.cleanup();}
 });
 it.each(['registry','custody','baseline'] as const)('rechecks %s revoked during the funded-wallet await before consuming the one-shot claim',async mode=>{
  const f=await setup(1);try{
   f.fundedWallets.mockImplementationOnce(async(_source,wallets)=>{
    if(mode==='registry')f.load.mockResolvedValue(undefined as never);
    if(mode==='custody')f.records.mockResolvedValue([]);
    if(mode==='baseline')await f.store.transaction(state=>{state.chainEvidence.find(value=>value.id===f.campaign.chainVerification.evidenceId)!.executionEnabled=false;});
    return [...wallets];
   });
   await f.automation.tick();expect(f.fundedWallets).toHaveBeenCalledOnce();expect(f.prepare).not.toHaveBeenCalled();expect(f.store.snapshot().events.some(event=>event.type==='replication_claim')).toBe(false);expect(f.store.unclaimedLiveRunRequests()).toHaveLength(0);
  }finally{await f.cleanup();}
 });

 it('isolates an explicitly ineligible own wallet and still prepares the healthy authorized wallet',async()=>{
  const bad=`0x${'5'.repeat(40)}` as Address;const f=await setup(1,[bad,wallet]);try{
   for(const client of f.clients){const original=client.readContract.bind(client);Object.assign(client,{readContract:async(input:{functionName:string;args?:readonly unknown[]})=>input.functionName==='numberMinted'&&String(input.args?.[0]).toLowerCase()===bad?10n:original(input as never)});}
   await f.automation.tick();expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepare.mock.calls[0]?.[1]).toEqual([wallet]);expect(f.store.unclaimedLiveRunRequests()[0]?.wallets).toEqual([wallet]);
  }finally{await f.cleanup();}
 });
 it('filters a thirty-wallet fleet through the actual signed family before the bounded own-proof pass',async()=>{
  const candidates=[...Array.from({length:29},(_,i)=>`0x${(i+1).toString(16).padStart(40,'0')}` as Address),wallet];const f=await setup(1,[wallet],candidates);try{
   await f.automation.tick();expect(f.prepare).toHaveBeenCalledOnce();expect(f.prepare.mock.calls[0]?.[1]).toEqual([wallet]);expect(f.store.unclaimedLiveRunRequests()[0]?.wallets).toEqual([wallet]);
  }finally{await f.cleanup();}
 });
 it('blocks the fleet when every authorized wallet is ineligible or authority is systemic/unknown',async()=>{
  const f=await setup(1);try{f.values['numberMinted']=10n;await f.automation.tick();expect(f.prepare).not.toHaveBeenCalled();expect(f.store.unclaimedLiveRunRequests()).toEqual([]);expect(f.store.snapshot().events.some(event=>event.type==='replication_claim')).toBe(false);}finally{await f.cleanup();}
  const unknown=await setup(1);try{unknown.fail();await unknown.automation.tick();expect(unknown.prepare).not.toHaveBeenCalled();expect(unknown.store.unclaimedLiveRunRequests()).toEqual([]);expect(unknown.store.snapshot().events.some(event=>event.type==='replication_claim')).toBe(false);}finally{await unknown.cleanup();}
 });

 it.each([[1,10],[8453,4],[4663,10]] as const)('accepts a verified watched quantity20 on chain%s while capping our own proof and campaign at%s',async(chainId,cap)=>{
  const f=await setup(chainId,[wallet],[wallet],20,20);try{
   f.values['limit']=100n;f.values['minted']=20n;
   const source=await f.qualify(f.source,[wallet]);expect(source.plan.observed.quantity).toBe(20);expect(source.plan.targets[0]?.quantity).toBe(cap);
   await f.automation.tick();expect(f.prepare).toHaveBeenCalledOnce();const request=f.store.unclaimedLiveRunRequests()[0];expect(request).toBeTruthy();expect(f.store.snapshot().campaigns.find(row=>row.id===request!.campaignId)?.quantity).toBe(cap);
  }finally{await f.cleanup();}
 });
 it.each(['oversized','malformed','missing-logs'] as const)('rejects %s watched quantity evidence without claiming or preparing',async mode=>{
  const f=await setup(1,[wallet],[wallet],20,20);try{
   f.values['limit']=100n;f.values['minted']=20n;
   if(mode==='oversized')f.tx.input=encodeFunctionData({abi:ABI,functionName:'mint',args:[BigInt(Number.MAX_SAFE_INTEGER)+1n]});
   if(mode==='malformed')f.tx.input=(f.tx.input+'00') as typeof f.tx.input;
   if(mode==='missing-logs')f.receipt.logs.pop();
   await f.automation.tick();expect(f.prepare).not.toHaveBeenCalled();expect(f.store.unclaimedLiveRunRequests()).toEqual([]);expect(f.store.snapshot().events.some(row=>row.type==='replication_claim')).toBe(false);
  }finally{await f.cleanup();}
 });

});
