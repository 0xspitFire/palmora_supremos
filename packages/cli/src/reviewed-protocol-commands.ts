import { createHash } from 'node:crypto';
import {basename,resolve,sep} from 'node:path';
import {readProtectedText} from './turnkey-files.js';
import type { Argv } from 'yargs';
import { DurableStore, EvidenceService, REVIEWED_ERC721_PUBLIC_BASELINE, validFreeSignedRehearsalReference, type BackendStore, type ChainEvidenceRecord } from '@mint-bot/backend';
import { assertReviewedRegistryCurrent, type VerifiedReviewedErc721Registry } from '@mint-bot/engine';
import { loadReviewedProtocolStrategy } from './reviewed-protocol-profile.js';
import { configuredSecretRoot, createCliRuntime } from './runtime.js';

export function reviewedProtocolBaselinePhrase(record: ChainEvidenceRecord):string {return `ACCEPT REVIEWED ERC721 CHAIN ${record.chainId} REGISTRY ${record.reviewedProtocol?.registryDigest} EVIDENCE ${record.id}`;}
/** An owner CLI confirmation records one distinct baseline; it neither installs a family nor releases kill. */
export async function acceptReviewedProtocolBaseline(input:{store:BackendStore;registry:VerifiedReviewedErc721Registry;record:ChainEvidenceRecord;confirm:string;now?:Date}):Promise<void>{
 const now=input.now??new Date();assertReviewedRegistryCurrent(input.registry,now);const {record}=input;
 if(record.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE || record.chainId!==input.registry.chainId || record.reviewedProtocol?.registryDigest!==input.registry.digest || !record.reviewedProtocol.descriptorDigests.length || record.reviewedProtocol.descriptorDigests.some(digest=>!input.registry.descriptors.some(descriptor=>reviewedErc721DescriptorDigest(descriptor)===digest)) || Date.parse(record.checkedAt)>now.getTime() || Date.parse(record.expiresAt)<=now.getTime() || input.confirm!==reviewedProtocolBaselinePhrase(record))throw new Error('REVIEWED_PROTOCOL_BASELINE_APPROVAL_REQUIRED');
 const proof=createHash('sha256').update(JSON.stringify(record,(_,value)=>typeof value==='bigint'?value.toString():value)).update(input.confirm).digest('hex');
 const service=new EvidenceService(input.store,()=>now,{verify:(candidate,approval)=>candidate.id===record.id&&candidate.reviewedProtocol?.registryDigest===input.registry.digest&&approval.proof===proof&&approval.verifierId==='owner-cli'&&approval.acceptedAt===now.toISOString()});
 const existing=input.store.snapshot().chainEvidence.find(value=>value.id===record.id);
 if(existing){
  if(existing.status==='accepted'&&existing.executionEnabled&&existing.approvalProof===proof)return;
  if(existing.status!=='pending'||JSON.stringify(existing,(_key,value)=>typeof value==='bigint'?value.toString():value)!==JSON.stringify(record,(_key,value)=>typeof value==='bigint'?value.toString():value))throw new Error('REVIEWED_PROTOCOL_BASELINE_ID_CONFLICT');
 }else await service.recordChainEvidence(record);
 await service.acceptChainEvidence(record.id,{verifierId:'owner-cli',proof,acceptedAt:now.toISOString()});
}
export async function readReviewedProtocolBaselineInput(path:string):Promise<ChainEvidenceRecord>{
 try{
  if(!basename(path).endsWith('.json')||resolve(path).split(sep).some(part=>/(?:^|[._-])(?:env|keys?|keystore|credentials?|private)(?:[._-]|$)/i.test(part)))throw new Error();
  const raw=JSON.parse(await readProtectedText(resolve(path),'REVIEWED_PROTOCOL_PUBLIC_EVIDENCE_INVALID',true,100000)) as Record<string,unknown>;
  if(!raw||![1,8453,4663].includes(raw.chainId as number)||typeof raw!=='object'||Array.isArray(raw)||raw.strategyVersion!==REVIEWED_ERC721_PUBLIC_BASELINE||!validFreeSignedRehearsalReference(raw.id)||typeof raw.sourceBlockHash!=='string'||!/^0x[0-9a-f]{64}$/i.test(raw.sourceBlockHash)||(typeof raw.sourceBlock!=='string'||!/^\d{1,78}$/.test(raw.sourceBlock))&&!(typeof raw.sourceBlock==='number'&&Number.isSafeInteger(raw.sourceBlock)&&raw.sourceBlock>=0))throw new Error();
  for(const field of ['endpointIdentity','archiveEndpointIdentity']){const value=raw[field];if(value!==undefined&&(typeof value!=='string'||value.length>300||/[?&\r\n]|bearer|authorization|password|private.?key/i.test(value)||value.includes('://')&&value!=='https://sequencer.mainnet.chain.robinhood.com'))throw new Error();}
  const record={...raw,sourceBlock:BigInt(raw.sourceBlock as string|number)} as unknown as ChainEvidenceRecord;
  if(record.sourceBlock>=2n**256n)throw new Error();
  // Reuse the authoritative schema in an ephemeral validator; no canonical record is created for preview.
  await new EvidenceService(new DurableStore()).recordChainEvidence(record);return record;
 }catch{throw new Error('REVIEWED_PROTOCOL_PUBLIC_EVIDENCE_INVALID');}
}
export function registerReviewedProtocolCommands<T>(cli:Argv<T>,options:{runtimeRoot:string;store?:()=>Promise<BackendStore>;registry?:()=>Promise<VerifiedReviewedErc721Registry|undefined>;write?:(value:unknown)=>void}):Argv<T>{
 return cli.command('reviewed-protocol-baseline <action>','Inspect, explicitly accept or revoke a separate reviewed ERC721 chain baseline',builder=>builder.positional('action',{choices:['status','accept','revoke'] as const,demandOption:true}).option('chain',{type:'number',choices:[1,8453,4663]}).option('evidence-file',{type:'string'}).option('evidence-id',{type:'string'}).option('confirm',{type:'string'}),async args=>{
  let ownedStore:(BackendStore&{close?:()=>void})|undefined;
  try{
   const write=options.write??(value=>process.stdout.write(`${JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item)}\n`));
   const registry=await(options.registry?.()??loadReviewedProtocolStrategy(configuredSecretRoot(options.runtimeRoot),args.chain).then(value=>value?.registry));if(!registry)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');
   const getStore=async()=>{if(options.store)return options.store();const runtime=await createCliRuntime(options.runtimeRoot,undefined,undefined,undefined,{startCoordinator:false,allowTurnkey:true});ownedStore=runtime.store;return runtime.store;};
   if(args.action==='status'){const store=await getStore();write({family:'erc721-reviewed-public-v1',chainId:registry.chainId,registryDigest:registry.digest,baselines:store.snapshot().chainEvidence.filter(value=>value.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE&&value.chainId===registry.chainId)});return;}
   if(args.action==='revoke'){
    if(!args.evidenceId||!validFreeSignedRehearsalReference(args.evidenceId)||args.confirm!==`REVOKE REVIEWED ERC721 EVIDENCE ${args.evidenceId}`)throw new Error('REVIEWED_PROTOCOL_BASELINE_APPROVAL_REQUIRED');
    const store=await getStore();await store.transaction(state=>{const record=state.chainEvidence.find(value=>value.id===args.evidenceId&&value.chainId===registry.chainId&&value.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE);if(!record)throw new Error('CHAIN_VERIFICATION_EVIDENCE_NOT_FOUND');record.executionEnabled=false;});write({revoked:args.evidenceId});return;
   }
   if(!args.evidenceFile)throw new Error('REVIEWED_PROTOCOL_EVIDENCE_FILE_REQUIRED');const record=await readReviewedProtocolBaselineInput(args.evidenceFile);
   if(!args.confirm){write({confirmation:reviewedProtocolBaselinePhrase(record),chainId:record.chainId,registryDigest:record.reviewedProtocol?.registryDigest});return;}
   const store=await getStore();await acceptReviewedProtocolBaseline({store,registry,record,confirm:args.confirm});write({accepted:record.id,chainId:record.chainId,family:'erc721-reviewed-public-v1'});
  }catch(error){throw new Error(error instanceof Error&&/^(?:REVIEWED_|ERC721_|CHAIN_|EVIDENCE_|INVALID_)[A-Z0-9_]{1,90}$/.test(error.message)?error.message:'REVIEWED_PROTOCOL_BASELINE_OPERATION_FAILED');}
  finally{if(ownedStore)try{ownedStore.close?.();}catch{throw new Error('REVIEWED_PROTOCOL_STORE_CLOSE_FAILED');}}
 });
}
import { reviewedErc721DescriptorDigest } from '@mint-bot/engine';
