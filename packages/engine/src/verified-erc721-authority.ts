import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { encodeFunctionData, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { reviewedErc721Abi, reviewedErc721FactoryAbi, reviewedErc721DescriptorDigest, validateReviewedErc721Deployment, type ReviewedErc721Deployment } from './protocol-registry.js';
import { ReviewedErc721PublicStrategy } from './strategies/erc721-public.js';
import type { SupportedChainId, TransactionIntent } from './types.js';

const CONTEXT = 'mintbot.reviewed-erc721-registry/v1';
const SIGNATURE_CONTEXT = 'mintbot.reviewed-erc721-registry/signature/v1\0';
const registries = new WeakSet<object>();
const authorities = new WeakSet<object>();
export interface ReviewedErc721RegistryRecord {
 readonly version: 1; readonly context: typeof CONTEXT; readonly organizationId: string; readonly userId: string;
 readonly environment: 'production' | 'testnet'; readonly chainId: SupportedChainId;
 readonly descriptors: readonly ReviewedErc721Deployment[]; readonly issuedAt: string; readonly expiresAt: string;
}
export interface SignedReviewedErc721Registry { readonly version: 1; readonly algorithm: 'Ed25519'; readonly record: ReviewedErc721RegistryRecord; readonly digest: string; readonly signature: string; }
export interface VerifiedReviewedErc721Registry extends ReviewedErc721RegistryRecord { readonly digest: string; }
export interface VerifiedErc721Authority {
 readonly registryDigest: string; readonly descriptorDigest: string; readonly chainId: SupportedChainId;
 readonly contract: Address; readonly wallet: Address; readonly quantity: number; readonly data: Hex;
 readonly gasLimitMin: bigint; readonly checkedAt: number; readonly expiresAt: number;
}
const stable = (value: unknown): string => value !== null && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const keys = (value: object, expected: string[]): boolean => Object.keys(value).sort().join(',') === expected.sort().join(',');
function record(value: ReviewedErc721RegistryRecord): ReviewedErc721RegistryRecord {
 if (!value || !keys(value, ['version','context','organizationId','userId','environment','chainId','descriptors','issuedAt','expiresAt']) || value.version !== 1 || value.context !== CONTEXT || !['production','testnet'].includes(value.environment) || ![1,8453,4663].includes(value.chainId) || !/^[A-Za-z0-9_-]{1,200}$/.test(value.organizationId) || !/^[A-Za-z0-9_-]{1,200}$/.test(value.userId) || !Array.isArray(value.descriptors) || !value.descriptors.length || value.descriptors.length > 100) throw new Error('ERC721_REGISTRY_INVALID');
 const issued = Date.parse(value.issuedAt); const expires = Date.parse(value.expiresAt);
 if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 30*86400000) throw new Error('ERC721_REGISTRY_INVALID');
 const descriptors = value.descriptors.map(validateReviewedErc721Deployment).sort((a,b) => reviewedErc721DescriptorDigest(a).localeCompare(reviewedErc721DescriptorDigest(b)));
 if (descriptors.some(item => item.chainId !== value.chainId) || new Set(descriptors.map(reviewedErc721DescriptorDigest)).size !== descriptors.length) throw new Error('ERC721_REGISTRY_INVALID');
 return { version:1,context:CONTEXT,organizationId:value.organizationId,userId:value.userId,environment:value.environment,chainId:value.chainId,descriptors,issuedAt:new Date(issued).toISOString(),expiresAt:new Date(expires).toISOString() };
}
export function createReviewedErc721RegistryRecord(input: Omit<ReviewedErc721RegistryRecord,'version'|'context'>): ReviewedErc721RegistryRecord { return record({version:1,context:CONTEXT,...input}); }
export function reviewedErc721RegistryDigest(value: ReviewedErc721RegistryRecord): string { return `sha256:${createHash('sha256').update(stable(record(value))).digest('hex')}`; }
export function signReviewedErc721Registry(value: ReviewedErc721RegistryRecord, privateKey: KeyObject | string | Buffer): SignedReviewedErc721Registry {
 const canonical=record(value); const digest=reviewedErc721RegistryDigest(canonical);
 return {version:1,algorithm:'Ed25519',record:canonical,digest,signature:sign(null,Buffer.from(SIGNATURE_CONTEXT+digest),privateKey).toString('base64')};
}
export function verifyReviewedErc721Registry(value: unknown, publicKey: KeyObject | string | Buffer, now: Date = new Date()): VerifiedReviewedErc721Registry {
 try {
  if ((typeof publicKey === 'string' || Buffer.isBuffer(publicKey)) ? /PRIVATE KEY/.test(publicKey.toString()) : publicKey.type !== 'public') throw new Error();
  const signed=value as SignedReviewedErc721Registry;
  if (!signed || !keys(signed,['version','algorithm','record','digest','signature']) || signed.version!==1 || signed.algorithm!=='Ed25519' || typeof signed.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) throw new Error();
  const canonical=record(signed.record); const digest=reviewedErc721RegistryDigest(canonical);
  const key=publicKey instanceof Object && 'asymmetricKeyType' in publicKey ? publicKey as KeyObject : createPublicKey(publicKey);
  if(key.asymmetricKeyType!=='ed25519' || digest!==signed.digest || !verify(null,Buffer.from(SIGNATURE_CONTEXT+digest),key,Buffer.from(signed.signature,'base64'))) throw new Error();
  const result=freeze({...canonical,digest});registries.add(result);assertReviewedRegistryCurrent(result,now);return result;
 } catch { throw new Error('ERC721_REGISTRY_UNVERIFIED'); }
}
export function assertReviewedRegistryCurrent(value: VerifiedReviewedErc721Registry, now: Date = new Date()): void {
 if(!registries.has(value) || !Number.isFinite(now.getTime()) || Date.parse(value.issuedAt)>now.getTime() || Date.parse(value.expiresAt)<=now.getTime()) throw new Error('ERC721_REGISTRY_UNVERIFIED');
}
export function reviewedRegistryDescriptor(registry: VerifiedReviewedErc721Registry, digest: string, now: Date = new Date()): ReviewedErc721Deployment {
 assertReviewedRegistryCurrent(registry,now);const descriptor=registry.descriptors.find(item=>reviewedErc721DescriptorDigest(item)===digest);if(!descriptor)throw new Error('ERC721_DESCRIPTOR_NOT_APPROVED');return descriptor;
}
/** No authority can be minted from supplied JSON facts: execute real strategy reads and both simulations. */
export async function verifyErc721WalletAuthority(input: { registry: VerifiedReviewedErc721Registry; descriptorDigest: string; clients: readonly [PublicClient,PublicClient]; contract: Address; wallet: Address; quantity: number; now?:()=>Date }): Promise<VerifiedErc721Authority> {
 try {
 const clock=input.now??(()=>new Date());const started=clock().getTime();
 const descriptor=reviewedRegistryDescriptor(input.registry,input.descriptorDigest,clock());
 const hosts=input.clients.map(client=>{try{return new URL(client.transport.url as string).hostname.toLowerCase();}catch{return '';}});
 if(!hosts[0] || !hosts[1] || hosts[0]===hosts[1] || input.clients[0]===input.clients[1] || input.wallet===zeroAddress)throw new Error('ERC721_INDEPENDENT_PROVIDER_REQUIRED');
 const strategy=new ReviewedErc721PublicStrategy(descriptor,async()=>input.clients[1],()=>clock().getTime());
 const drop=await strategy.readDrop(input.clients[0],input.contract,descriptor.chainId);
 const gasLimitMin=await strategy.estimateGas(input.clients[0],drop,input.wallet,input.quantity);
 const checkedAt=clock().getTime();assertReviewedRegistryCurrent(input.registry,clock());
 if(checkedAt<started || checkedAt-started>30000 || checkedAt>=drop.endTime*1000 || checkedAt<drop.startTime*1000)throw new Error('ERC721_AUTHORITY_STALE');
 const data=encodeFunctionData({abi:reviewedErc721Abi(descriptor),functionName:'mint',args:[BigInt(input.quantity)]});
 const result=freeze({registryDigest:input.registry.digest,descriptorDigest:input.descriptorDigest,chainId:descriptor.chainId,contract:input.contract.toLowerCase() as Address,wallet:input.wallet.toLowerCase() as Address,quantity:input.quantity,data,gasLimitMin,checkedAt,expiresAt:Math.min(checkedAt+30000,drop.endTime*1000,Date.parse(input.registry.expiresAt))});
 authorities.add(result);return result;
 }catch(error){throw new Error(error instanceof Error && /^ERC721_[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'ERC721_AUTHORITY_UNAVAILABLE');}
}
export function assertErc721IntentAuthority(intent: TransactionIntent, registryDigest: string, descriptorDigests: readonly string[], now: Date = new Date()): void {
 const proof=intent.familyContext?.reviewedErc721Authority;const time=now.getTime();
 if(!proof || !authorities.has(proof) || !Number.isFinite(time) || proof.checkedAt>time || proof.expiresAt<=time || proof.registryDigest!==registryDigest || !descriptorDigests.includes(proof.descriptorDigest) || proof.chainId!==intent.chainId || proof.contract!==intent.to.toLowerCase() || proof.wallet!==intent.from.toLowerCase() || proof.gasLimitMin>intent.gasLimit || proof.data.toLowerCase()!==intent.data.toLowerCase() || intent.value!==0n || intent.familyContext?.nftContract.toLowerCase()!==proof.contract || !intent.campaignId || !intent.runId)throw new Error('ERC721_VERIFIED_AUTHORITY_REQUIRED');
}

const rehearsalAuthorities=new WeakSet<object>();
export interface VerifiedErc721RehearsalAuthority {readonly registryDigest:string;readonly descriptorDigest:string;readonly chainId:SupportedChainId;readonly contract:Address;readonly wallet:Address;readonly blockNumber:bigint;readonly blockHash:Hex;readonly checkedAt:number;readonly expiresAt:number;}
function directImmutableCode(code:Hex):boolean {
 let bytes=Buffer.from(code.slice(2),'hex');if(bytes.length>4){const start=bytes.length-2-bytes.readUInt16BE(bytes.length-2);if(start>0&&bytes[start-1]===0xfe&&bytes[start]!>=0xa0&&bytes[start]!<=0xbf&&bytes.subarray(start,bytes.length-2).includes(Buffer.from('solc')))bytes=bytes.subarray(0,start);}
 for(let i=0;i<bytes.length;i++){const opcode=bytes[i]!;if([0xf2,0xf4,0xff].includes(opcode))return false;if(opcode>=0x60&&opcode<=0x7f)i+=opcode-0x5f;}return true;
}
/** Code/provenance authority for INERT custody checks only; never a live eligibility proof. */
export async function verifyErc721RehearsalAuthority(input:{registry:VerifiedReviewedErc721Registry;descriptorDigest:string;clients:readonly [PublicClient,PublicClient];contract:Address;wallet:Address;now?:()=>Date}):Promise<VerifiedErc721RehearsalAuthority>{
 try{
  const clock=input.now??(()=>new Date()),started=clock().getTime();const descriptor=reviewedRegistryDescriptor(input.registry,input.descriptorDigest,clock());
  if(!/^0x[0-9a-f]{40}$/i.test(input.contract)||input.contract.toLowerCase()===zeroAddress||!/^0x[0-9a-f]{40}$/i.test(input.wallet)||input.wallet.toLowerCase()===zeroAddress||descriptor.binding==='deployment'&&descriptor.contract.toLowerCase()!==input.contract.toLowerCase())throw new Error('ERC721_REHEARSAL_BINDING_INVALID');
  const hosts=input.clients.map(client=>{try{return new URL(client.transport.url as string).hostname.toLowerCase();}catch{return '';}});if(input.clients[0]===input.clients[1]||!hosts[0]||!hosts[1]||hosts[0]===hosts[1])throw new Error('ERC721_INDEPENDENT_PROVIDER_REQUIRED');
  const heads=await Promise.all(input.clients.map(client=>client.getBlockNumber()));if(heads.some(value=>value<2n))throw new Error('ERC721_AUTHORITY_STALE');const blockNumber=(heads[0]!<heads[1]!?heads[0]!:heads[1]!)-2n;
  const views=await Promise.all(input.clients.map(async client=>{
   const [chain,block,code,currentCode,supports]=await Promise.all([client.getChainId(),client.getBlock({blockNumber}),client.getCode({address:input.contract,blockNumber}),client.getCode({address:input.contract}),client.readContract({address:input.contract,abi:reviewedErc721Abi(descriptor),functionName:'supportsInterface',args:['0x80ac58cd'],blockNumber})]);
   if(chain!==descriptor.chainId||!block.hash||!/^0x[0-9a-f]{64}$/i.test(block.hash)||!code||code==='0x'||currentCode!==code||keccak256(code)!==descriptor.bytecodeHash.toLowerCase()||!directImmutableCode(code)||supports!==true)throw new Error('ERC721_REHEARSAL_CODE_REQUIRED');
   if(descriptor.binding==='factory-template'){
    const factory=descriptor.template;const [factoryCode,currentFactory,deployed]=await Promise.all([client.getCode({address:factory.factory,blockNumber}),client.getCode({address:factory.factory}),client.readContract({address:factory.factory,abi:reviewedErc721FactoryAbi(descriptor),functionName:factory.deploymentRegistryMethod,args:[input.contract],blockNumber})]);
    if(!factoryCode||factoryCode==='0x'||currentFactory!==factoryCode||keccak256(factoryCode)!==factory.factoryBytecodeHash.toLowerCase()||!directImmutableCode(factoryCode)||deployed!==true)throw new Error('ERC721_FACTORY_PROVENANCE_REQUIRED');
   }
   return {hash:block.hash.toLowerCase() as Hex,timestamp:block.timestamp.toString()};
  }));
  if(JSON.stringify(views[0])!==JSON.stringify(views[1]))throw new Error('ERC721_PROVIDER_STATE_DISAGREEMENT');
  const checkedAt=clock().getTime(),age=checkedAt-Number(views[0]!.timestamp)*1000;assertReviewedRegistryCurrent(input.registry,clock());if(!Number.isFinite(age)||age< -30000||age>300000||checkedAt<started||checkedAt-started>30000)throw new Error('ERC721_AUTHORITY_STALE');
  const result=freeze({registryDigest:input.registry.digest,descriptorDigest:input.descriptorDigest,chainId:descriptor.chainId,contract:input.contract.toLowerCase() as Address,wallet:input.wallet.toLowerCase() as Address,blockNumber,blockHash:views[0]!.hash,checkedAt,expiresAt:Math.min(checkedAt+30000,Date.parse(input.registry.expiresAt))});rehearsalAuthorities.add(result);return result;
 }catch(error){throw new Error(error instanceof Error&&/^ERC721_[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'ERC721_REHEARSAL_AUTHORITY_UNAVAILABLE');}
}
export function assertErc721RehearsalIntent(intent:TransactionIntent,registryDigest:string,descriptorDigests:readonly string[],now:Date=new Date()):void{
 const proof=intent.familyContext?.reviewedErc721RehearsalAuthority,time=now.getTime();
 if(!proof||!rehearsalAuthorities.has(proof)||!Number.isFinite(time)||proof.checkedAt>time||proof.expiresAt<=time||proof.registryDigest!==registryDigest||!descriptorDigests.includes(proof.descriptorDigest)||proof.chainId!==intent.chainId||proof.contract!==intent.to.toLowerCase()||proof.wallet!==intent.from.toLowerCase()||intent.familyContext?.nftContract.toLowerCase()!==proof.contract||intent.familyContext?.feeRecipient!==zeroAddress||intent.nonce!==Number.MAX_SAFE_INTEGER||intent.gasLimit!==0n||intent.value!==0n||intent.maxFeePerGas!==0n||intent.maxPriorityFeePerGas!==0n||(intent.accessList?.length??0)!==0||intent.data.toLowerCase()!==('0xa0712d68'+'0'.repeat(63)+'1')||intent.campaignId!=='reviewed-rehearsal'||intent.runId!=='reviewed-rehearsal')throw new Error('ERC721_INERT_REHEARSAL_REQUIRED');
}
