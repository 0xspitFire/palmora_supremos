import { createPublicClient, http, type PublicClient, type Address } from 'viem';
import { validateTurnkeyPolicyAst, turnkeyPolicySelection, readTurnkeySecretConfig, readTurnkeyReviewedRegistries, resolveChainConfigFromSecrets, independentPublicRpcEndpoints, ReviewedErc721PublicStrategy, reviewedErc721DescriptorDigest, assertReviewedRegistryCurrent, type VerifiedReviewedErc721Registry, type SupportedChainId, type MintStrategy } from '@mint-bot/engine';

/** Only a verified profile reaches this dispatcher. Discovery never edits the registry. */
export function createReviewedProtocolStrategy(registry: VerifiedReviewedErc721Registry, clients: readonly [PublicClient,PublicClient], now:()=>Date=()=>new Date()): MintStrategy {
 const strategies=new Map<string,ReviewedErc721PublicStrategy>();
 const select=async(contract:Address,chainId:SupportedChainId)=>{
  assertReviewedRegistryCurrent(registry,now());if(registry.chainId!==chainId)throw new Error('ERC721_REGISTRY_BINDING_INVALID');
  const candidates=registry.descriptors.filter(descriptor=>descriptor.binding==='factory-template'||descriptor.contract.toLowerCase()===contract.toLowerCase());
  for(const descriptor of candidates){const digest=reviewedErc721DescriptorDigest(descriptor);let strategy=strategies.get(digest);if(!strategy){strategy=new ReviewedErc721PublicStrategy(descriptor,async()=>clients[1],()=>now().getTime(),registry,async()=>clients);strategies.set(digest,strategy);}try{return {strategy,drop:await strategy.readDrop(clients[0],contract,chainId)};}catch{/* Try only another independently owner-reviewed descriptor. */}}
  throw new Error('ERC721_REVIEWED_DEPLOYMENT_REQUIRED');
 };
 const strategyFor=(drop:Parameters<MintStrategy['buildCalldata']>[0])=>{assertReviewedRegistryCurrent(registry,now());const value=strategies.get(String(drop.extra?.['descriptorDigest']));if(!value)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');return value;};
 return {name:'erc721-reviewed-public-v1',readDrop:async(_client,contract,chainId)=>(await select(contract,chainId)).drop,buildCalldata:(drop,wallet,quantity)=>strategyFor(drop).buildCalldata(drop,wallet,quantity),estimateGas:(_client,drop,wallet,quantity)=>strategyFor(drop).estimateGas(clients[0],drop,wallet,quantity),validateDrop:(drop,time)=>strategyFor(drop).validateDrop(drop,time),signingAuthority:(_client,drop,wallet,quantity)=>strategyFor(drop).signingAuthority(clients[0],drop,wallet,quantity)};
}
/** Absent public profile leaves the strategy unregistered. No provider write or grant occurs. */
export async function loadReviewedProtocolStrategies(secretRoot:string):Promise<readonly {registry:VerifiedReviewedErc721Registry;strategy:MintStrategy;clients:readonly [PublicClient,PublicClient]}[]>{
 const config=await readTurnkeySecretConfig(secretRoot,'mainnet');if(!config.reviewedProtocolRegistryPath)return [];
 const registries=await readTurnkeyReviewedRegistries(config);
 return Promise.all(registries.map(async registry=>{
  const endpoints=independentPublicRpcEndpoints((await resolveChainConfigFromSecrets(registry.chainId,'mainnet',secretRoot)).rpcEndpoints);
  const clients=endpoints.map(endpoint=>createPublicClient({transport:http(endpoint,{timeout:10000,retryCount:0})})) as [PublicClient,PublicClient];
  return {registry,clients,strategy:createReviewedProtocolStrategy(registry,clients)};
 }));
}
export async function loadReviewedProtocolStrategy(secretRoot:string, chainId?:number):Promise<{registry:VerifiedReviewedErc721Registry;strategy:MintStrategy;clients:readonly [PublicClient,PublicClient]}|undefined>{
 const values=(await loadReviewedProtocolStrategies(secretRoot)).filter(value=>chainId===undefined||value.registry.chainId===chainId);if(values.length>1)throw new Error('ERC721_EXPLICIT_CHAIN_REQUIRED');return values[0];
}
/** A single engine registry entry dispatches each chain only to its separately signed profile. */
export function composeReviewedProtocolStrategies(values:readonly {registry:VerifiedReviewedErc721Registry;strategy:MintStrategy}[]):MintStrategy{
 if(!values.length||values.length>3||new Set(values.map(value=>value.registry.chainId)).size!==values.length)throw new Error('ERC721_REGISTRY_BINDING_INVALID');
 const forChain=(chainId:number)=>{const value=values.find(value=>value.registry.chainId===chainId);if(!value)throw new Error('ERC721_REGISTRY_BINDING_INVALID');assertReviewedRegistryCurrent(value.registry);return value.strategy;};
 return {name:'erc721-reviewed-public-v1',readDrop:(client,contract,chainId)=>forChain(chainId).readDrop(client,contract,chainId),buildCalldata:(drop,wallet,quantity)=>forChain(drop.chainId).buildCalldata(drop,wallet,quantity),estimateGas:(client,drop,wallet,quantity)=>forChain(drop.chainId).estimateGas(client,drop,wallet,quantity),validateDrop:(drop,time)=>forChain(drop.chainId).validateDrop(drop,time),signingAuthority:(client,drop,wallet,quantity)=>{const strategy=forChain(drop.chainId);if(!strategy.signingAuthority)throw new Error('ERC721_VERIFIED_AUTHORITY_REQUIRED');return strategy.signingAuthority(client,drop,wallet,quantity);}};
}

/** Select an independently signed family only; no SeaDrop record can cover mint(uint256). */
export function selectReviewedProtocolPolicy(records: readonly import('@mint-bot/engine').TurnkeyCanonicalPolicyRecord[], input: {chainId:number;strategy:string;mintPriceWei?:bigint;quantity:number;walletScope?:readonly string[];contract:string;reviewedProtocol?:{registryDigest:string;descriptorDigest:string}}, registry: VerifiedReviewedErc721Registry): (import('@mint-bot/engine').TurnkeyPolicySelection & {provider:'turnkey';reviewedProtocol:{family:'erc721-reviewed-public-v1';registryDigest:string;descriptorDigest:string}})|undefined {
 assertReviewedRegistryCurrent(registry);
 const selected=input.reviewedProtocol;if(input.strategy!=='erc721-reviewed-public-v1'||input.chainId!==registry.chainId||input.mintPriceWei!==0n||!selected||selected.registryDigest!==registry.digest||!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>(input.chainId===8453?4:10)||!input.walletScope?.length)return undefined;
 const descriptor=registry.descriptors.find(value=>reviewedErc721DescriptorDigest(value)===selected.descriptorDigest);if(!descriptor||descriptor.binding==='deployment'&&descriptor.contract.toLowerCase()!==input.contract.toLowerCase())return undefined;
 const matches=records.filter(record=>{const policy=record.enforcementPolicy;const family=policy.family;return record.environment===registry.environment&&record.providerIdentity.organizationId===registry.organizationId&&record.providerIdentity.userId===registry.userId&&family?.kind==='erc721-reviewed-public-v1'&&policy.transaction.chainId===input.chainId&&family.registryDigest===registry.digest&&family.descriptorDigests.includes(selected.descriptorDigest)&&family.maxQuantity>=input.quantity&&input.walletScope!.every(wallet=>policy.transaction.from.some(value=>value.toLowerCase()===wallet.toLowerCase()));});
 if(matches.length!==1)return undefined;
 return {...turnkeyPolicySelection(matches[0]!),provider:'turnkey',reviewedProtocol:{family:'erc721-reviewed-public-v1',...selected}};
}

/** Offline review input only. Installation still requires the existing signed record/bundle workflow. */
export function reviewedProtocolFamilyPolicy(registry:VerifiedReviewedErc721Registry,input:{policyId:string;wallets:readonly {keyId:string;address:Address}[];gasLimitMax?:bigint;maxFeePerGasMax?:bigint;maxPriorityFeePerGasMax?:bigint}):import('@mint-bot/engine').TurnkeyPolicyAst{
 assertReviewedRegistryCurrent(registry);if(input.wallets.length<1||input.wallets.length>30)throw new Error('ERC721_WALLET_SCOPE_INVALID');
 return validateTurnkeyPolicyAst({version:1,effect:'allow',scope:{provider:'turnkey',environment:registry.environment,organizationId:registry.organizationId,userId:registry.userId,policyId:input.policyId,keyIds:input.wallets.map(wallet=>wallet.keyId)},transaction:{chainId:registry.chainId,from:input.wallets.map(wallet=>wallet.address),to:'0x0000000000000000000000000000000000000000',valueWei:'0',data:'0xa0712d68',gasLimitMax:String(input.gasLimitMax??500000n),maxFeePerGasMax:String(input.maxFeePerGasMax??200000000n),maxPriorityFeePerGasMax:String(input.maxPriorityFeePerGasMax??100000000n),accessList:[]},family:{kind:'erc721-reviewed-public-v1',maxQuantity:registry.chainId===8453?4:10,registryDigest:registry.digest,descriptorDigests:registry.descriptors.map(reviewedErc721DescriptorDigest)}});
}
