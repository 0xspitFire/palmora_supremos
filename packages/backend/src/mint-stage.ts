import { createHash } from 'node:crypto';
import type { BackendStore } from './store.js';
export type StageChainId=1|8453|4663;
export type StageMethod='seadrop-v1-public'|'seadrop-v1-allowlist'|'seadrop-v1-signed'|'erc721-reviewed-public-v1';
export interface MintStageIdentity { chainId:StageChainId; collection:string; stageId:string; method:StageMethod; }
export interface MintStageSnapshot extends MintStageIdentity {
 observedAt:string; expiresAt:string; startsAt:string; endsAt:string;
 priceWei:string; maxPerWallet:number; maxSupply:string; totalMinted:string;
 feeRecipient:string; proofBinding:string; authorityReference:string;
}
export interface MintStageRevision { key:string; revision:number; digest:string; snapshot:MintStageSnapshot; changed: boolean; }
export interface MintStageRequest {
 requestId:string; createdAt:string; windowFrom?:string; windowUntil?:string; approvedRevision:number; approvedDigest:string;
 identity:MintStageIdentity; quantity:number; executionState:'not_started'|'started'|'settled';
 /** The scheduler supplies evidence from its existing fresh eligibility, simulation and custody gates. */
 validation?:{ revision:number; digest:string; expiresAt:string; eligibility:true; simulation:true; custody:true };
}
export interface MintStageDecision { state:'ready'|'reschedule'|'refresh_required'|'blocked'; reason:string; revision?:number; digest?:string; scheduledAt?:string; approvalInvalidated:boolean; budgetAction:'preserve-existing'; }
const address=/^0x[a-f0-9]{40}$/i;const opaque=/^[A-Za-z0-9_.:-]{1,160}$/;const uint=/^(0|[1-9][0-9]{0,77})$/;
const methods=new Set<StageMethod>(['seadrop-v1-public','seadrop-v1-allowlist','seadrop-v1-signed','erc721-reviewed-public-v1']);
export function mintStageKey(identity:MintStageIdentity):string {
 if(![1,8453,4663].includes(identity.chainId)||!address.test(identity.collection)||!opaque.test(identity.stageId)||!methods.has(identity.method))throw new Error('MINT_STAGE_IDENTITY_INVALID');
 return `${identity.chainId}:${identity.collection.toLowerCase()}:${identity.stageId}:${identity.method}`;
}
function validate(snapshot:MintStageSnapshot,now:Date):void {
 mintStageKey(snapshot);const times=[snapshot.observedAt,snapshot.expiresAt,snapshot.startsAt,snapshot.endsAt].map(Date.parse);
 if(!times.every(Number.isFinite)||times[0]!>+now||times[1]!<=+now||times[1]!-times[0]!>5*60_000||times[2]!>=times[3]!||!uint.test(snapshot.priceWei)||!uint.test(snapshot.maxSupply)||!uint.test(snapshot.totalMinted)||BigInt(snapshot.maxSupply)<=0n||BigInt(snapshot.totalMinted)>BigInt(snapshot.maxSupply)||!Number.isSafeInteger(snapshot.maxPerWallet)||snapshot.maxPerWallet<1||snapshot.maxPerWallet>10000||!address.test(snapshot.feeRecipient)||!opaque.test(snapshot.proofBinding)||!opaque.test(snapshot.authorityReference))throw new Error('MINT_STAGE_SNAPSHOT_INVALID');
}
function stageDigest(snapshot:MintStageSnapshot):string {
 // Observation freshness and volatile RPC head identity are not stage configuration.
 const body={chainId:snapshot.chainId,collection:snapshot.collection.toLowerCase(),stageId:snapshot.stageId,method:snapshot.method,startsAt:snapshot.startsAt,endsAt:snapshot.endsAt,priceWei:snapshot.priceWei,maxPerWallet:snapshot.maxPerWallet,maxSupply:snapshot.maxSupply,totalMinted:snapshot.totalMinted,feeRecipient:snapshot.feeRecipient.toLowerCase(),proofBinding:snapshot.proofBinding,authorityReference:snapshot.authorityReference};
 return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}
/** Durable drift control; never allocates funds, signs, fires or resets execution state. */
export class MintStageService {
 public constructor(private readonly store:BackendStore,private readonly now:()=>Date=()=>new Date()){}
 public async observe(snapshot:MintStageSnapshot):Promise<MintStageRevision>{
  validate(snapshot,this.now());const key=mintStageKey(snapshot);const digest=stageDigest(snapshot);
  return this.store.transaction(state=>{
   const prior=[...state.events].reverse().find(event=>event.type==='mint_stage_revision'&&event.data.key===key);
   const revision=prior?.data.digest===digest?Number(prior.data.revision):Number(prior?.data.revision??0)+1;
   const changed=!!prior&&prior.data.digest!==digest;
   // Always retain the last observation for diagnostics, even if configuration is unchanged.
   state.events.push({id:`mint_stage_observation_${key}_${state.events.length}`,type:'mint_stage_observed',at:this.now().toISOString(),data:{key,revision,digest,observedAt:snapshot.observedAt}});
   if(prior?.data.digest!==digest)state.events.push({id:`mint_stage_revision_${key}_${revision}`,type:'mint_stage_revision',at:this.now().toISOString(),data:{key,revision,digest,snapshot:structuredClone(snapshot)}});
   return {key,revision,digest,snapshot:structuredClone(snapshot),changed};
  });
 }
 public async evaluate(request:MintStageRequest,snapshot:MintStageSnapshot):Promise<MintStageDecision>{
  const decision=(state:MintStageDecision['state'],reason:string,approvalInvalidated:boolean,extra:Partial<MintStageDecision>={}):MintStageDecision=>({state,reason,approvalInvalidated,budgetAction:'preserve-existing',...extra});
  if(!opaque.test(request.requestId)||!Number.isFinite(Date.parse(request.createdAt))||Date.parse(request.createdAt)>+this.now())return decision('blocked','MINT_STAGE_REQUEST_INVALID',true);
  const started=this.store.snapshot().events.some(event=>event.type==='mint_stage_execution_started'&&event.data.requestId===request.requestId);
  if(started||request.executionState!=='not_started')return decision('blocked','MINT_STAGE_EXECUTION_ALREADY_STARTED',true);
  let observed:MintStageRevision;
  try{if(mintStageKey(request.identity)!==mintStageKey(snapshot))return decision('refresh_required','MINT_STAGE_IDENTITY_CHANGED',true);observed=await this.observe(snapshot);}catch{return decision('blocked','MINT_STAGE_AUTHORITY_UNAVAILABLE',true);}
  const extra={revision:observed.revision,digest:observed.digest};const now=+this.now();
  if(now-Date.parse(request.createdAt)>7*86_400_000+6*3_600_000)return decision('blocked','MINT_STAGE_REQUEST_EXPIRED',true,extra);
  if(Date.parse(snapshot.endsAt)<=now||BigInt(snapshot.totalMinted)>=BigInt(snapshot.maxSupply))return decision('blocked','MINT_STAGE_ENDED_OR_SOLD_OUT',true,extra);
  if(!Number.isSafeInteger(request.quantity)||request.quantity<1||request.quantity>snapshot.maxPerWallet||BigInt(request.quantity)>BigInt(snapshot.maxSupply)-BigInt(snapshot.totalMinted))return decision('blocked','MINT_STAGE_QUANTITY_INVALID',true,extra);
  const from=Date.parse(request.windowFrom??request.createdAt),until=Date.parse(request.windowUntil??new Date(from+6*3_600_000).toISOString());
  if(![from,until].every(Number.isFinite)||until<=from||until-from>6*3_600_000||from-Date.parse(request.createdAt)>7*86_400_000||Date.parse(snapshot.startsAt)>=until||Date.parse(snapshot.endsAt)<=from||now>=until)return decision('blocked','MINT_STAGE_SCHEDULE_OUTSIDE_BOUNDS',true,extra);
  if(request.approvedRevision!==observed.revision||request.approvedDigest!==observed.digest)return decision('refresh_required','MINT_STAGE_DRIFT_REVALIDATION_REQUIRED',true,extra);
  const evidence=request.validation;
  if(!evidence||evidence.revision!==observed.revision||evidence.digest!==observed.digest||evidence.eligibility!==true||evidence.simulation!==true||evidence.custody!==true||!Number.isFinite(Date.parse(evidence.expiresAt))||Date.parse(evidence.expiresAt)<=now||Date.parse(evidence.expiresAt)>now+5*60_000)return decision('refresh_required','MINT_STAGE_FRESH_VALIDATION_REQUIRED',true,extra);
  if(Math.max(Date.parse(snapshot.startsAt),from)>now)return decision('reschedule','MINT_STAGE_WAITING_FOR_OPEN',false,{...extra,scheduledAt:new Date(Math.max(Date.parse(snapshot.startsAt),from)).toISOString()});
  return decision('ready','MINT_STAGE_CURRENT_AND_VALIDATED',false,extra);
 }
 public async markExecutionStarted(request:MintStageRequest,snapshot:MintStageSnapshot):Promise<void>{
  const result=await this.evaluate(request,snapshot);if(result.state!=='ready')throw new Error(result.reason);
  await this.store.transaction(state=>{
   if(state.events.some(event=>event.type==='mint_stage_execution_started'&&event.data.requestId===request.requestId))throw new Error('MINT_STAGE_EXECUTION_ALREADY_STARTED');
   const latest=[...state.events].reverse().find(event=>event.type==='mint_stage_revision'&&event.data.key===mintStageKey(snapshot));
   if(latest?.data.digest!==result.digest||latest?.data.revision!==result.revision)throw new Error('MINT_STAGE_DRIFT_REVALIDATION_REQUIRED');
   state.events.push({id:`mint_stage_execution_${request.requestId}`,type:'mint_stage_execution_started',at:this.now().toISOString(),data:{requestId:request.requestId,key:mintStageKey(snapshot),revision:result.revision,digest:result.digest}});
  });
 }
}
