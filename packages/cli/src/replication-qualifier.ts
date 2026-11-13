import { REVIEWED_ERC721_PUBLIC_BASELINE, PERSONAL_LIVE_FLEET_POLICY, BASE_PERSONAL_LIVE_FLEET_POLICY, type BackendStore, type EventRecord } from '@mint-bot/backend';
import { assertReviewedRegistryCurrent, SEADROP_V1_ADDRESS, readTurnkeyApprovedPolicyRecords, type SupportedChainId, type TurnkeyCanonicalPolicyRecord } from '@mint-bot/engine';
import type { Address, PublicClient } from 'viem';
import { loadReviewedProtocolStrategy, selectReviewedProtocolPolicy } from './reviewed-protocol-profile.js';
import { readReplicationSource, type QualifiedSource } from './replication-source.js';
type Profile=NonNullable<Awaited<ReturnType<typeof loadReviewedProtocolStrategy>>>;
/** Source routing grants no authority. Every non-SeaDrop transaction must pass
 * the fresh owner-signed registry, custody family, baseline and two-RPC source
 * verifier; discovery metadata alone cannot select an execution protocol. */
export function createHostReplicationQualifier(options:{
 store:BackendStore;secretRoot:string;maxQuantity:number;
 reader(chainId:SupportedChainId):Promise<PublicClient>;
 watchedWallets(chainId:number):readonly string[];
 loadReviewed?(chainId:SupportedChainId):Promise<Profile|undefined>;
 records?():Promise<readonly TurnkeyCanonicalPolicyRecord[]>;
 now?:()=>Date;
}){
 const now=options.now??(()=>new Date());
 const load=options.loadReviewed??(chainId=>loadReviewedProtocolStrategy(options.secretRoot,chainId));
 const records=options.records??(()=>readTurnkeyApprovedPolicyRecords('mainnet',options.secretRoot));
 const verified=new WeakMap<QualifiedSource,{recordDigest:string;policyReference:string}>();
 const authority=async(profile:Profile,source:QualifiedSource,wallets:readonly Address[])=>{
  assertReviewedRegistryCurrent(profile.registry,now());
  const reviewed=source.reviewedProtocol;const chainId=source.drop.chainId;
  if(!reviewed||reviewed.registryDigest!==profile.registry.digest||profile.registry.chainId!==chainId||source.drop.strategyName!=='erc721-reviewed-public-v1'||source.drop.mintPrice!==0n)throw new Error('ERC721_AUTOMATION_AUTHORITY_REQUIRED');
  const quantity=Math.min(options.maxQuantity,source.plan.observed.quantity??0,source.drop.maxTotalMintableByWallet,chainId===8453?4:10);
  const selected=source.plan.targets.map(target=>target.wallet).filter(wallet=>wallets.some(value=>value.toLowerCase()===wallet.toLowerCase()));
  const policy=selectReviewedProtocolPolicy((await records()).filter(record=>Date.parse(record.expiresAt)>+now()&&Date.parse(record.issuedAt)<=+now()),{chainId,strategy:source.drop.strategyName,mintPriceWei:source.drop.mintPrice,quantity,walletScope:selected,contract:source.drop.nftContract,reviewedProtocol:reviewed},profile.registry);
  if(!policy)throw new Error('ERC721_AUTOMATION_CUSTODY_REQUIRED');
  if(!options.store.snapshot().chainEvidence.some(evidence=>evidence.chainId===chainId&&evidence.status==='accepted'&&evidence.executionEnabled&&!evidence.seaDropCompatible&&evidence.strategyVersion===REVIEWED_ERC721_PUBLIC_BASELINE&&Date.parse(evidence.expiresAt)>+now()&&evidence.reviewedProtocol?.family===reviewed.family&&evidence.reviewedProtocol.registryDigest===reviewed.registryDigest&&evidence.reviewedProtocol.descriptorDigests.includes(reviewed.descriptorDigest)))throw new Error('ERC721_AUTOMATION_BASELINE_REQUIRED');
  assertReviewedRegistryCurrent(profile.registry,now());
  return policy;
 };
 const qualify=async(event:EventRecord,wallets:readonly Address[]):Promise<QualifiedSource>=>{
  const chainId=Number(event.data.chainId) as SupportedChainId;
  if(![1,8453,4663].includes(chainId)||!/^0x[a-f0-9]{40}$/i.test(String(event.data.contract))||!/^0x[a-f0-9]{64}$/i.test(String(event.data.txHash)))throw new Error('REPLICATION_SOURCE_INVALID');
  const client=await options.reader(chainId);const hash=event.data.txHash as `0x${string}`;
  const routing=await client.getTransaction({hash});
  const generic=routing.to?.toLowerCase()!==SEADROP_V1_ADDRESS.toLowerCase();
  const profile=generic?await load(chainId):undefined;
  if(generic&&!profile)throw new Error('ERC721_AUTOMATION_REGISTRY_REQUIRED');
  if(profile){assertReviewedRegistryCurrent(profile.registry,now());if(profile.registry.chainId!==chainId)throw new Error('ERC721_REGISTRY_BINDING_INVALID');}
  let targets=wallets;
  if(profile){
   if(wallets.length>30||new Set(wallets.map(wallet=>wallet.toLowerCase())).size!==wallets.length)throw new Error('ERC721_AUTOMATION_WALLET_SCOPE_INVALID');
   const drop=await profile.strategy.readDrop(profile.clients[0],event.data.contract as Address,chainId);
   const currentRecords=(await records()).filter(record=>Date.parse(record.expiresAt)>+now()&&Date.parse(record.issuedAt)<=+now());
   const descriptorDigest=String(drop.extra?.['descriptorDigest']);
   const fleetPolicy=chainId===8453?BASE_PERSONAL_LIVE_FLEET_POLICY:PERSONAL_LIVE_FLEET_POLICY;const fee=chainId===4663?200000000000000n:fleetPolicy.freeFeeAllowanceWei;const cap=chainId===4663?2000000000000000n:fleetPolicy.freeDailyCapWei;const maxWallets=Math.min(10,Number(cap/fee));
   targets=wallets.filter(wallet=>Boolean(selectReviewedProtocolPolicy(currentRecords,{chainId,strategy:drop.strategyName,mintPriceWei:drop.mintPrice,quantity:1,walletScope:[wallet],contract:drop.nftContract,reviewedProtocol:{registryDigest:profile.registry.digest,descriptorDigest}},profile.registry))).slice(0,maxWallets);
   if(!targets.length)throw new Error('ERC721_AUTOMATION_CUSTODY_REQUIRED');
  }
  const source=await readReplicationSource({client,chainId,contract:event.data.contract as Address,hash,watchedWallets:options.watchedWallets(chainId),targetWallets:targets,now,...(profile?{reviewedProtocol:{registry:profile.registry,clients:profile.clients}}:{})});
  if(source.reviewedProtocol){
   if(!profile)throw new Error('ERC721_AUTOMATION_REGISTRY_REQUIRED');
   const initial=await authority(profile,source,wallets);
   const current=await load(chainId);if(!current||current.registry.digest!==profile.registry.digest)throw new Error('ERC721_AUTOMATION_REGISTRY_CHANGED');
   const final=await authority(current,source,wallets);if(initial.recordDigest!==final.recordDigest||initial.policyReference!==final.policyReference)throw new Error('ERC721_AUTOMATION_CUSTODY_CHANGED');
   verified.set(source,{recordDigest:final.recordDigest,policyReference:final.policyReference});
   const age=+now()-Date.parse(source.mintedAt);if(!Number.isFinite(age)||age<0||age>15*60000)throw new Error('WATCHED_MINT_STALE_OR_REORGED');
  }else if(generic)throw new Error('ERC721_AUTOMATION_AUTHORITY_REQUIRED');
  return source;
 };
 return Object.assign(qualify,{assertSourceAuthority:async(source:QualifiedSource,wallets:readonly Address[])=>{
  if(source.reviewedProtocol){
   const expected=verified.get(source);if(!expected)throw new Error('ERC721_AUTOMATION_AUTHORITY_REQUIRED');
   const first=await load(source.drop.chainId);if(!first||first.registry.digest!==source.reviewedProtocol.registryDigest)throw new Error('ERC721_AUTOMATION_REGISTRY_CHANGED');
   const policy=await authority(first,source,wallets);
   const final=await load(source.drop.chainId);if(!final||final.registry.digest!==first.registry.digest)throw new Error('ERC721_AUTOMATION_REGISTRY_CHANGED');
   const current=await authority(final,source,wallets);if(current.recordDigest!==expected.recordDigest||current.policyReference!==expected.policyReference||current.recordDigest!==policy.recordDigest)throw new Error('ERC721_AUTOMATION_CUSTODY_CHANGED');
  }
  const age=+now()-Date.parse(source.mintedAt);if(!Number.isFinite(age)||age<0||age>15*60000)throw new Error('WATCHED_MINT_STALE_OR_REORGED');
 }});
}
