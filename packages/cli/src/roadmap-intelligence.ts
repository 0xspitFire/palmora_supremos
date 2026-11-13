import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseEther, type PublicClient } from 'viem';
import { AdaptiveFeedbackController, feedbackSamplesFromOutcomes, D033_READINESS_LIMITS, measuredAnalyticsOutcomes, startExternalAnalyticsIngestion, validActiveModel, validAdaptivePolicy, type EventRecord, type AnalyticsFloorQuote, type ActiveAdaptiveModel, type AdaptiveGovernancePolicy, type BackendStore, type ExecutionChainId, type ExternalAnalyticsCandidatePort, type ExternalAnalyticsChainPort, type ExternalAnalyticsWallet, type HistoricalQualityPort, type MeasuredIntelligenceOutcome, type QualityMeasure, type SourcedFact } from '@mint-bot/backend';
import { createAdvancedIntelligenceProvider, type AdvancedIntelligenceReaders } from './advanced-intelligence.js';
import { createSourcifyIntelligenceReaders } from './advanced-intelligence-sourcify.js';
import type { OpenSeaFloors } from './opensea-client.js';
export interface RoadmapReader {identity:string;client:PublicClient;}
export async function readAdaptivePolicyProfile(path:string|undefined,now=new Date()):Promise<readonly AdaptiveGovernancePolicy[]>{
 if(!path)return [];const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string;
 try{const metadata=await handle.stat();if(!metadata.isFile()||metadata.uid!==0||(metadata.mode&0o022)!==0||metadata.size>65536)throw new Error('ADAPTIVE_PROFILE_PERMISSIONS_REQUIRED');text=await handle.readFile('utf8');if(Buffer.byteLength(text)>65536)throw new Error('ADAPTIVE_PROFILE_INVALID');}finally{await handle.close();}
 const value=JSON.parse(text) as {version?:unknown;policies?:unknown};
 if(value.version!=='adaptive-policy-profile-v1'||!Array.isArray(value.policies)||value.policies.length>3||!value.policies.every(policy=>validAdaptivePolicy(policy,now))||new Set(value.policies.map(policy=>policy.chainId)).size!==value.policies.length)throw new Error('ADAPTIVE_PROFILE_INVALID');
 return structuredClone(value.policies);
}
export function openSeaAdvancedReader(floors:OpenSeaFloors,onQuote?:(quote:AnalyticsFloorQuote)=>Promise<void>):AdvancedIntelligenceReaders{return {trustedOrigin:'https://api.opensea.io',async floor(context){
 const quote=await floors.quote?.(context.chainId,context.contract);if(!quote||quote.chainId!==context.chainId||quote.contract.toLowerCase()!==context.contract.toLowerCase()||quote.currency!=='ETH'||quote.floorEth===undefined||!Number.isFinite(quote.floorEth)||quote.floorEth<0||quote.floorEth>1e9||Date.parse(quote.observedAt)>+context.now||Date.parse(quote.expiresAt)<=+context.now)return undefined;
 const floorWei=parseEther(quote.floorEth.toFixed(18)).toString();await onQuote?.({chainId:context.chainId,collection:context.contract,floorWei,observedAt:quote.observedAt,expiresAt:quote.expiresAt,sourceReference:`opensea:${context.chainId}:${context.contract.toLowerCase()}`});
 return {chainId:context.chainId,contract:context.contract,observedAt:quote.observedAt,expiresAt:quote.expiresAt,sourceReference:quote.sourceReference,value:{floorWei,feePerNftWei:D033_READINESS_LIMITS.freeFeeAllowanceWei.toString()}};
}};}
interface Summary{samples:number;profitable:number;unprofitable:number;breakEven:number;lastOutcomeAt:string;coverageFrom:string;coverageUntil:string;}
const key=(chainId:number,address:string)=>`${chainId}:${address.toLowerCase()}`;
function summarize(rows:readonly MeasuredIntelligenceOutcome[],select:(row:MeasuredIntelligenceOutcome)=>string|undefined):Map<string,Summary>{
 const output=new Map<string,Summary>();for(const row of rows){const identity=select(row);if(!identity)continue;const previous=output.get(identity);const profit=BigInt(row.realizedPnlWei!);output.set(identity,{samples:(previous?.samples??0)+1,profitable:(previous?.profitable??0)+(profit>0n?1:0),unprofitable:(previous?.unprofitable??0)+(profit<0n?1:0),breakEven:(previous?.breakEven??0)+(profit===0n?1:0),lastOutcomeAt:previous&&previous.lastOutcomeAt>row.outcomeAt?previous.lastOutcomeAt:row.outcomeAt,coverageFrom:previous&&previous.coverageFrom<row.decisionAt?previous.coverageFrom:row.decisionAt,coverageUntil:previous&&previous.coverageUntil>row.outcomeAt?previous.coverageUntil:row.outcomeAt});}return output;
}
export function createRoadmapIntelligence(options:{store:BackendStore;clients(chainId:ExecutionChainId):Promise<readonly RoadmapReader[]>;ownedWallets():Promise<readonly ExternalAnalyticsWallet[]>;watchedWallets():Promise<readonly ExternalAnalyticsWallet[]>;floors?:OpenSeaFloors;candidatePort?:ExternalAnalyticsCandidatePort;chainPort?(chainId:ExecutionChainId):Promise<ExternalAnalyticsChainPort>;adaptivePolicies?:readonly AdaptiveGovernancePolicy[];now?:()=>Date;record?(code:string):void;advancedReaders?:readonly AdvancedIntelligenceReaders[];intervalMs?:number}){
 const now=options.now??(()=>new Date());const interval=options.intervalMs??60000;if(!Number.isSafeInteger(interval)||interval<15000||interval>300000)throw new Error('ROADMAP_INTELLIGENCE_INTERVAL_INVALID');
 const controllers=new Map((options.adaptivePolicies??[]).map(policy=>[policy.chainId,new AdaptiveFeedbackController(options.store,policy,now)]));
 const readers=options.advancedReaders??[createSourcifyIntelligenceReaders({clients:async chainId=>(await options.clients(chainId)).map(reader=>reader.client)}),...(options.floors?[openSeaAdvancedReader(options.floors,async quote=>{const id=`analytics_floor_${createHash('sha256').update(JSON.stringify(quote)).digest('hex')}`;if(!options.store.snapshot().events.some(event=>event.id===id))await options.store.transaction(state=>{if(!state.events.some(event=>event.id===id))state.events.push({id,type:'analytics_floor_quote',at:now().toISOString(),data:{quote}});});})]:[])];
 const advanced=createAdvancedIntelligenceProvider({readers,now,timeoutMs:10000,rpcBudget:16,maxPerTick:2});
 let walletQuality=new Map<string,Summary>();let projectQuality=new Map<string,Summary>();let observedAt:Date|undefined;let priorSources=new Set<string>();let models=new Map<number,ActiveAdaptiveModel>();let running:Promise<void>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let external:ReturnType<typeof startExternalAnalyticsIngestion>|undefined;let stopped=false;let started=false;
 const history:HistoricalQualityPort={snapshot(context){if(stopped||!observedAt||+context.now-+observedAt<0||+context.now-+observedAt>=2*interval)return undefined;
  const selected=[...new Set(context.watchedWallets.map(wallet=>wallet.toLowerCase()))].map(wallet=>walletQuality.get(key(context.chainId,wallet))).filter((value):value is Summary=>!!value);
  const combine=(values:Summary[]):Summary|undefined=>values.length?{samples:values.reduce((sum,value)=>sum+value.samples,0),profitable:values.reduce((sum,value)=>sum+value.profitable,0),unprofitable:values.reduce((sum,value)=>sum+value.unprofitable,0),breakEven:values.reduce((sum,value)=>sum+value.breakEven,0),lastOutcomeAt:values.map(value=>value.lastOutcomeAt).sort().at(-1)!,coverageFrom:values.map(value=>value.coverageFrom).sort()[0]!,coverageUntil:values.map(value=>value.coverageUntil).sort().at(-1)!}:undefined;
  const fact=(value:Summary|undefined,sourceReference:string):SourcedFact<QualityMeasure>|undefined=>value?{chainId:context.chainId,contract:context.contract,observedAt:observedAt!.toISOString(),expiresAt:new Date(+observedAt!+2*interval).toISOString(),sourceReference,value:{...value,fullyCosted:true}}:undefined;
  return {version:'quality-facts-v1',chainId:context.chainId,contract:context.contract,walletQuality:fact(combine(selected),'observed-wallet-outcomes'),projectQuality:fact(projectQuality.get(key(context.chainId,context.contract)),'observed-project-outcomes')};
 }};
 const adaptive={active(chainId:ExecutionChainId,at:Date){const model=models.get(chainId);return !stopped&&observedAt&&+at-+observedAt<2*interval&&+at>=+observedAt&&validActiveModel(model,chainId,at)?structuredClone(model):undefined;}};
 const tick=async()=>{if(stopped||running)return;running=(async()=>{try{
  const owned=[...await options.ownedWallets()].map(row=>({chainId:row.chainId,address:row.address.toLowerCase()})).sort((a,b)=>a.chainId-b.chainId||a.address.localeCompare(b.address));
  if(owned.length>300||owned.some(row=>![1,8453,4663].includes(row.chainId)||!/^0x[a-f0-9]{40}$/.test(row.address))||new Set(owned.map(row=>key(row.chainId,row.address))).size!==owned.length)throw new Error('ANALYTICS_WALLET_SCOPE_INVALID');
  const existingScope=[...options.store.snapshot().events].reverse().find(event=>event.type==='analytics_wallet_scope');
  if(JSON.stringify(existingScope?.data.wallets)!==JSON.stringify(owned))await options.store.transaction(state=>{const previous=[...state.events].reverse().find(event=>event.type==='analytics_wallet_scope');if(JSON.stringify(previous?.data.wallets)!==JSON.stringify(owned))state.events.push({id:`analytics_scope_${state.events.length}`,type:'analytics_wallet_scope',at:now().toISOString(),data:{wallets:owned,revision:Number(previous?.data.revision??0)+1}});});
  const outcomes=measuredAnalyticsOutcomes(options.store.snapshot().events,now());const sources=new Set(outcomes.map(row=>row.sourceReference));const removed=[...priorSources].filter(source=>!sources.has(source));
  for(const controller of controllers.values())if(removed.length)await controller.invalidateReferences(removed);
  // On restart compare each persisted epoch's complete lineage to the current verified history.
  const events=options.store.snapshot().events;
  for(const controller of controllers.values()){const missing=events.filter(event=>event.type==='adaptive_model_promoted'&&Array.isArray(event.data.sourceReferences)).flatMap(event=>(event.data.sourceReferences as unknown[]).filter((ref):ref is string=>typeof ref==='string'&&!sources.has(ref)));if(missing.length)await controller.invalidateReferences(missing);}
  const samples=feedbackSamplesFromOutcomes(outcomes,options.store.snapshot().events,now());
  for(const [chainId,controller] of controllers){
   const measured=samples.filter(sample=>sample.chainId===chainId);
   if(measured.length<50)continue;
   const prior=[...options.store.snapshot().events].reverse().find(event=>event.type==='adaptive_model_candidate'&&(event.data.candidate as {chainId?:number}|undefined)?.chainId===chainId);
   // At most one proposal per day. Candidate generation never grants the first-model approval.
   if(prior){const candidate=prior.data.candidate as {sourceReferences?:string[]};const unchanged=Array.isArray(candidate.sourceReferences)&&JSON.stringify([...candidate.sourceReferences].sort())===JSON.stringify(measured.map(sample=>sample.sourceReference).sort());if(unchanged||+now()-Date.parse(prior.at)<86400000)continue;}
   try{const candidate=await controller.propose(measured);const accepted=options.store.snapshot().events.some(event=>event.type==='adaptive_initial_model_accepted'&&event.data.policyDigest===candidate.policyDigest);if(accepted)await controller.promote(candidate.id);else options.record?.('ADAPTIVE_INITIAL_MODEL_OWNER_APPROVAL_REQUIRED');}
   catch(error){const code=error instanceof Error&&/^ADAPTIVE_[A-Z_]{1,80}$/.test(error.message)?error.message:'ADAPTIVE_CANDIDATE_UNAVAILABLE';options.record?.(code);}
  }
  walletQuality=summarize(outcomes,row=>row.sourceWallet?key(row.chainId,row.sourceWallet):undefined);projectQuality=summarize(outcomes,row=>key(row.chainId,row.collection));priorSources=sources;observedAt=now();models=new Map([...controllers.entries()].flatMap(([chain,controller])=>{const model=controller.active(chain,now());return model?[[chain,model] as const]:[];}));
  await advanced.tick();
 }catch{models.clear();observedAt=undefined;try{options.record?.('ROADMAP_INTELLIGENCE_UNAVAILABLE');}catch{/* diagnostics cannot change scheduling */}}})();try{await running;}finally{running=undefined;}};
 const schedule=()=>{if(stopped)return;timer=setTimeout(()=>{void tick().finally(schedule);},interval);timer.unref();};
 const assertDecision=(score:EventRecord)=>{
  if(score.data.modelEpochId===undefined)return;
  const chain=score.data.chainId;const controller=controllers.get(chain as ExecutionChainId);const model=controller?.active(chain as ExecutionChainId,now());
  if(stopped||!model||model.epochId!==score.data.modelEpochId)throw new Error('ADAPTIVE_DECISION_EPOCH_INVALID');
  const event=[...options.store.snapshot().events].reverse().find(row=>row.type==='adaptive_model_promoted'&&(row.data.model as {epochId?:string}|undefined)?.epochId===model.epochId);
  const currentSources=new Set(measuredAnalyticsOutcomes(options.store.snapshot().events,now()).map(outcome=>outcome.sourceReference));
  if(!event||!Array.isArray(event.data.sourceReferences)||event.data.sourceReferences.some(ref=>typeof ref!=='string'||!currentSources.has(ref)))throw new Error('ADAPTIVE_DECISION_LINEAGE_INVALID');
 };
 return {advanced,history,adaptive,assertDecision,tick,start(){if(started||stopped)return;started=true;if(options.candidatePort&&options.chainPort)external=startExternalAnalyticsIngestion({store:options.store,candidatePort:options.candidatePort,chainPort:options.chainPort,wallets:async()=>{const all=[...await options.ownedWallets(),...await options.watchedWallets()];return [...new Map(all.map(row=>[key(row.chainId,row.address),row])).values()];},intervalMs:Math.max(60000,interval),maxTransactions:4,maxWalletsPerTick:2,record:options.record});void tick().finally(schedule);},async stop(){stopped=true;models.clear();if(timer)clearTimeout(timer);await Promise.all([running,external?.stop(),advanced.stop()]);},diagnostics(){return {started,stopped,adaptiveChains:models.size,historyFresh:observedAt!==undefined,externalEnabled:external!==undefined,...advanced.diagnostics()};}};
}
