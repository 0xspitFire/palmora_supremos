import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash,createPrivateKey,createPublicKey,type KeyObject} from 'node:crypto';
import type {Argv} from 'yargs';
import type {Address} from 'viem';
import {createReviewedErc721RegistryRecord,reviewedErc721RegistryDigest,signReviewedErc721Registry,verifyReviewedErc721Registry,readTurnkeyReviewedRegistry,turnkeyProviderPolicyExpressions,isSecureTurnkeyFileAccess,type ReviewedErc721RegistryRecord} from '@mint-bot/engine';
import {reviewedProtocolFamilyPolicy} from './reviewed-protocol-profile.js';

const MAX_PUBLIC_BYTES=262144;
const exact=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const keys=Object.keys(value);return required.every(key=>keys.includes(key))&&keys.every(key=>required.includes(key)||optional.includes(key));
};
async function noSymlinkParents(path:string):Promise<void>{let current=dirname(resolve(path));for(;;){const entry=await lstat(current);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('REVIEWED_CUSTODY_PATH_INVALID');const parent=dirname(current);if(parent===current)return;current=parent;}}
async function readProtected(path:string,maxBytes:number,privateMaterial=false):Promise<string>{
 try{
  const absolute=resolve(path);await noSymlinkParents(absolute);const handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await handle.stat();const uid=process.getuid?.();if(uid===undefined||!info.isFile()||info.size<1||info.size>maxBytes)throw new Error();
   if(privateMaterial ? info.uid!==uid||(info.mode&0o077)!==0||(info.mode&0o400)===0 : !isSecureTurnkeyFileAccess(info,uid,process.getgroups?.()??[]))throw new Error();
   const content=await handle.readFile('utf8');if(Buffer.byteLength(content)>maxBytes)throw new Error();return content;
  }finally{await handle.close();}
 }catch{throw new Error(privateMaterial?'REVIEWED_CUSTODY_OWNER_KEY_ACCESS_REQUIRED':'REVIEWED_CUSTODY_PROTECTED_INPUT_REQUIRED');}
}
async function readPublicJson(path:string):Promise<unknown>{try{return JSON.parse(await readProtected(path,MAX_PUBLIC_BYTES));}catch(error){if(error instanceof Error&&error.message==='REVIEWED_CUSTODY_PROTECTED_INPUT_REQUIRED')throw error;throw new Error('REVIEWED_CUSTODY_PUBLIC_JSON_INVALID');}}
async function publicPin(path:string):Promise<{key:KeyObject;fingerprint:string}>{
 const text=await readProtected(path,16384);
 try{if(text.includes('PRIVATE KEY'))throw new Error();const key=createPublicKey(text);if(key.asymmetricKeyType!=='ed25519')throw new Error();return {key,fingerprint:`sha256:${createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')}`};}catch{throw new Error('REVIEWED_CUSTODY_PUBLIC_PIN_INVALID');}
}
async function unsignedRegistry(path:string):Promise<ReviewedErc721RegistryRecord>{
 try{return createReviewedErc721RegistryRecord(await readPublicJson(path) as Parameters<typeof createReviewedErc721RegistryRecord>[0]);}catch(error){if(error instanceof Error&&error.message==='REVIEWED_CUSTODY_PROTECTED_INPUT_REQUIRED')throw error;throw new Error('REVIEWED_CUSTODY_REGISTRY_INPUT_INVALID');}
}
export function reviewedRegistrySigningPhrase(record:ReviewedErc721RegistryRecord,pinFingerprint:string):string{return `SIGN REVIEWED ERC721 CHAIN ${record.chainId} REGISTRY ${reviewedErc721RegistryDigest(record)} WITH ${pinFingerprint}`;}
async function writeNewPublicArtifact(path:string,value:unknown):Promise<void>{
 const absolute=resolve(path);try{await noSymlinkParents(absolute);}catch{throw new Error('REVIEWED_CUSTODY_OUTPUT_PATH_INVALID');}
 let handle;try{handle=await open(absolute,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{throw new Error('REVIEWED_CUSTODY_NEW_OUTPUT_REQUIRED');}
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
}
interface WalletDraft {
 version:1;chainId:1|8453|4663;organizationId:string;userId:string;environment:'production'|'testnet';policyId:string;
 wallets:readonly {keyId:string;address:Address}[];limits?:{gasLimitMax:string;maxFeePerGasMax:string;maxPriorityFeePerGasMax:string};
}
function walletDraft(value:unknown):WalletDraft{
 if(!exact(value,['version','chainId','organizationId','userId','environment','policyId','wallets'],['limits'])||value.version!==1||![1,8453,4663].includes(Number(value.chainId))||!['production','testnet'].includes(String(value.environment))||![value.organizationId,value.userId,value.policyId].every(item=>typeof item==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(item))||!Array.isArray(value.wallets)||!value.wallets.length||value.wallets.length>30||value.wallets.some(item=>!exact(item,['keyId','address'])||typeof item.keyId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(item.keyId)||typeof item.address!=='string'||!/^0x[0-9a-f]{40}$/i.test(item.address)))throw new Error('REVIEWED_CUSTODY_WALLET_DRAFT_INVALID');
 if(value.limits!==undefined&&(!exact(value.limits,['gasLimitMax','maxFeePerGasMax','maxPriorityFeePerGasMax'])||Object.values(value.limits).some(item=>typeof item!=='string'||!/^\d{1,20}$/.test(item))))throw new Error('REVIEWED_CUSTODY_WALLET_DRAFT_INVALID');
 return value as unknown as WalletDraft;
}

/** Offline owner operations only. Registration/help/preview never opens an owner private key. */
export function registerReviewedProtocolCustodyCommands<T>(cli:Argv<T>,options:{write?:(value:unknown)=>void;now?:()=>Date}={}):Argv<T>{
 return cli.command('reviewed-protocol-custody <action>','Offline reviewed registry signing and bounded family policy preview',builder=>builder.positional('action',{choices:['registry-preview','registry-sign','policy-preview'] as const,demandOption:true}).option('input',{type:'string',describe:'Protected public unsigned registry JSON'}).option('registry',{type:'string',describe:'Protected owner-signed public registry or registry catalog'}).option('approver-public-key',{type:'string',demandOption:true,describe:'Protected pinned Ed25519 public key'}).option('owner-key',{type:'string',describe:'Explicit owner-only offline Ed25519 private-key file; registry-sign only'}).option('wallet-draft',{type:'string',describe:'Protected public wallet scope, policy ID, chain and optional lower fee limits'}).option('output',{type:'string',describe:'New exclusive 0600 signed registry output; registry-sign only'}).option('confirm',{type:'string',describe:'Exact digest and public-pin confirmation from registry-preview'}),async args=>{
  try{
  const write=options.write??(value=>process.stdout.write(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item)+'\n'));
  const now=options.now??(()=>new Date());
  if(args.action!=='registry-sign'&&(args.ownerKey!==undefined||args.output!==undefined||args.confirm!==undefined))throw new Error('REVIEWED_CUSTODY_OFFLINE_ACTION_SCOPE_INVALID');
  const pin=await publicPin(args.approverPublicKey);
  if(args.action==='policy-preview'){
   if(!args.registry||!args.walletDraft||args.input)throw new Error('REVIEWED_CUSTODY_POLICY_INPUTS_REQUIRED');
   const draft=walletDraft(await readPublicJson(args.walletDraft));const registry=await readTurnkeyReviewedRegistry({reviewedProtocolRegistryPath:resolve(args.registry),policyApproverPublicKeyPath:resolve(args.approverPublicKey),organizationId:draft.organizationId,userId:draft.userId,environment:draft.environment},now(),draft.chainId);
   const enforcementPolicy=reviewedProtocolFamilyPolicy(registry,{policyId:draft.policyId,wallets:draft.wallets,...(draft.limits?{gasLimitMax:BigInt(draft.limits.gasLimitMax),maxFeePerGasMax:BigInt(draft.limits.maxFeePerGasMax),maxPriorityFeePerGasMax:BigInt(draft.limits.maxPriorityFeePerGasMax)}:{})});
   const expressions=turnkeyProviderPolicyExpressions(enforcementPolicy);
   write({kind:'offline-reviewed-family-policy-preview',chainId:draft.chainId,registryDigest:registry.digest,approverFingerprint:pin.fingerprint,enforcementPolicy,providerPolicy:{policyName:`MintBot reviewed ERC721 chain ${draft.chainId}`,notes:'D095 reviewed registry; local code/factory and own-wallet authority required; separate baseline required',effect:'EFFECT_ALLOW',...expressions},nextAction:'Use the existing canonical propose/install/rehearsal and offline signed bundle workflow. This preview installs nothing and does not enable minting.'});return;
  }
  if(!args.input||args.registry||args.walletDraft)throw new Error('REVIEWED_CUSTODY_REGISTRY_INPUT_REQUIRED');
  const record=await unsignedRegistry(args.input);const phrase=reviewedRegistrySigningPhrase(record,pin.fingerprint);
  if(args.action==='registry-preview'){write({kind:'offline-reviewed-registry-preview',registryDigest:reviewedErc721RegistryDigest(record),approverFingerprint:pin.fingerprint,record,confirm:phrase,validNow:Date.parse(record.issuedAt)<=now().getTime()&&Date.parse(record.expiresAt)>now().getTime(),nextAction:'Offline owner registry-sign with this exact confirmation and a new output path; no provider or baseline changes.'});return;}
  if(args.confirm!==phrase)throw new Error('REVIEWED_CUSTODY_EXACT_CONFIRMATION_REQUIRED');
  if(!args.ownerKey||!args.output)throw new Error('REVIEWED_CUSTODY_OWNER_KEY_AND_NEW_OUTPUT_REQUIRED');
  let key:KeyObject;try{key=createPrivateKey(await readProtected(args.ownerKey,16384,true));if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({type:'spki',format:'der'}).equals(pin.key.export({type:'spki',format:'der'})))throw new Error();}catch{throw new Error('REVIEWED_CUSTODY_OWNER_KEY_BINDING_REQUIRED');}
  const signed=signReviewedErc721Registry(record,key);verifyReviewedErc721Registry(signed,pin.key,now());await writeNewPublicArtifact(args.output,signed);
  write({kind:'offline-reviewed-registry-signed',registryDigest:signed.digest,chainId:record.chainId,output:resolve(args.output),approverFingerprint:pin.fingerprint,nextAction:'Review and install the public registry through the protected profile workflow. No family, baseline, funding or live grant was installed.'});
  }catch(error){throw new Error(error instanceof Error&&/^(?:REVIEWED_|ERC721_|TURNKEY_)[A-Z0-9_]{1,90}$/.test(error.message)?error.message:'REVIEWED_CUSTODY_OPERATION_FAILED');}
 });
}
