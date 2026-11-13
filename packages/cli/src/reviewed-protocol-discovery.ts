import { createHash } from 'node:crypto';
import { assertVerifiedContractObservation, REVIEWED_ERC721_PUBLIC_BASELINE, scoreOpportunity, type BackendStore, type ContractObservation, type IntelligenceAlertSink, type AdvancedIntelligencePort, type HistoricalQualityPort, type AdaptiveModelPort } from '@mint-bot/backend';
import type { QualifiedSource } from './replication-source.js';
export interface ReviewedDiscoveryOptions {
 store:BackendStore; qualify(observation:ContractObservation):Promise<QualifiedSource|undefined>;
 alerts?:IntelligenceAlertSink; now?:()=>Date; advanced?:AdvancedIntelligencePort; history?:HistoricalQualityPort; adaptive?:AdaptiveModelPort;
}
/** Separate, rate-bounded read-only bridge. Generic interface observations alone
 * never become scores or execution authority. The qualifier reads current code,
 * provenance, successful watched self-mint and own-wallet simulation via two RPCs. */
export function createReviewedProtocolDiscovery(options:ReviewedDiscoveryOptions){
 const now=options.now??(()=>new Date());let lastStarted=-Infinity;let running=false;
 return {async observe(observation:ContractObservation):Promise<void>{
  assertVerifiedContractObservation(observation);
  if(observation.kind!=='mint'||observation.standard!=='erc721')return;
  if(running||+now()-lastStarted<30000)throw new Error('REVIEWED_DISCOVERY_RATE_LIMITED');
  const id=`reviewed_mint_${createHash('sha256').update(`${observation.chainId}:${observation.transactionHash}`).digest('hex')}`;
  if(options.store.snapshot().events.some(event=>event.id===`${id}:score`))return;
  const age=+now()-Date.parse(observation.blockTimestamp);if(!Number.isFinite(age)||age<0||age>15*60000)return;
  running=true;lastStarted=+now();
  try{
   const source=await options.qualify(observation);if(!source?.reviewedProtocol||source.plan.verdict!=='replicable'||source.drop.strategyName!=='erc721-reviewed-public-v1'||source.drop.mintPrice!==0n||source.observed.hash?.toLowerCase()!==observation.transactionHash.toLowerCase()||source.observed.from.toLowerCase()!==observation.wallet?.toLowerCase()||source.drop.nftContract.toLowerCase()!==observation.contract.toLowerCase()||source.drop.chainId!==observation.chainId||source.observed.chainId!==observation.chainId||source.observed.to.toLowerCase()!==observation.contract.toLowerCase()||source.observed.value!==0n||source.observed.blockNumber?.toString()!==observation.blockNumber||source.sourceBlockHash?.toLowerCase()!==observation.blockHash.toLowerCase()||Date.parse(source.observed.observedAt??'')!==Date.parse(observation.blockTimestamp)||Date.parse(source.mintedAt)!==Date.parse(observation.blockTimestamp)||source.reviewedProtocol.family!=='erc721-reviewed-public-v1')return;
   const freshAge=+now()-Date.parse(observation.blockTimestamp);if(!Number.isFinite(freshAge)||freshAge<0||freshAge>15*60000)return;
   const scope=source.reviewedProtocol;const snapshot=options.store.snapshot();
   if(!snapshot.chainEvidence.some(evidence=>evidence.chainId===observation.chainId&&evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE&&evidence.status==='accepted'&&evidence.executionEnabled&&Date.parse(evidence.expiresAt)>+now()&&evidence.reviewedProtocol?.family===scope.family&&evidence.reviewedProtocol.registryDigest===scope.registryDigest&&evidence.reviewedProtocol.descriptorDigests.includes(scope.descriptorDigest)))return;
   const prior=snapshot.events.filter(event=>event.type==='watched_wallet_mint'&&event.data.chainId===observation.chainId&&String(event.data.contract).toLowerCase()===observation.contract.toLowerCase()&&event.data.strategy==='erc721-reviewed-public-v1'&&event.data.replicable===true&&Number.isFinite(Date.parse(event.at))&&+now()-Date.parse(event.at)>=0&&+now()-Date.parse(event.at)<=6*3600000);
   const wallets=[...new Set([...prior.map(event=>String(event.data.wallet).toLowerCase()),source.observed.from.toLowerCase()])];
   const context={chainId:source.drop.chainId,contract:source.drop.nftContract,watchedWallets:wallets,now:now()};
   const advanced=options.advanced?.snapshot(context);const history=options.history?.snapshot(context);
   const scored=scoreOpportunity({watchedMinters:wallets.length,watchingConfigured:true,priceWei:0n,budgetPerNftWei:0n,knownSeaDropPattern:false,knownReviewedTemplate:true,hasCode:true,mintsLastHour:prior.length+1,discoveredAt:new Date(source.mintedAt),now:now(),chainId:source.drop.chainId,contract:source.drop.nftContract,advanced,history,adaptiveModel:options.adaptive?.active(source.drop.chainId,now())});
   const at=now().toISOString();const expiresAt=new Date(Math.min(Date.parse(source.mintedAt)+15*60000,+now()+15*60000)).toISOString();if(Date.parse(expiresAt)<=+now())return;
   await options.store.transaction(state=>{if(state.events.some(event=>event.id===`${id}:score`))return;
    state.events.push({id,type:'watched_wallet_mint',at:source.mintedAt,data:{chainId:source.drop.chainId,contract:source.drop.nftContract,wallet:source.observed.from,txHash:source.observed.hash,strategy:source.drop.strategyName,quantity:source.plan.observed.quantity,priceWei:'0',replicable:true,reviewedProtocol:scope}});
    state.events.push({id:`${id}:score`,type:scored.band==='log'?'opportunity_scored':'opportunity_notified',at,data:{opportunityId:`reviewed-erc721:${observation.chainId}:${observation.contract.toLowerCase()}`,chainId:observation.chainId,contract:observation.contract,score:scored.score,scoreVersion:scored.modelVersion,staticScore:scored.baseScore??scored.score,...(scored.modelEpochId?{modelEpochId:scored.modelEpochId}:{}),factors:scored.factors,risks:scored.risks,blocked:scored.blocked,band:scored.band,priceWei:'0',watchedMinters:wallets,watchedMinterObservations:wallets.map(wallet=>({wallet,at:wallet===source.observed.from.toLowerCase()?source.mintedAt:prior.filter(event=>String(event.data.wallet).toLowerCase()===wallet).map(event=>event.at).sort().at(-1)})),firstSeenAt:source.mintedAt,lastActivityAt:source.mintedAt,expiresAt,sourceBlock:observation.blockNumber,sourceBlockHash:observation.blockHash,strategy:source.drop.strategyName,reviewedProtocol:scope,executionAuthorized:false}});
   });
   if(!scored.blocked&&scored.band!=='log')await options.alerts?.intelligence({kind:'opportunity',priority:scored.band==='proposal'?'immediate':'grouped',dedupe:`reviewed:${observation.chainId}:${observation.contract}:${scored.band}`,text:`Reviewed-template free mint · score ${scored.score}\n${observation.contract}\n${wallets.length} verified watched minter(s). Fresh preparation and all execution checks remain required.`});
  }finally{running=false;}
 }};
}
