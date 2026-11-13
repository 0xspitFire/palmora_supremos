import {recordWalletSimulations,campaignInputDigest,type BackendStore,type Campaign} from '@mint-bot/backend';
import {assertReviewedRegistryCurrent,readTurnkeyApprovedPolicyRecords,turnkeyPolicyRecordDigest,type MintStrategy,type TurnkeyCanonicalPolicyRecord,type VerifiedReviewedErc721Registry} from '@mint-bot/engine';
import type {PublicClient,Address,Hex} from 'viem';
import {loadReviewedProtocolStrategies,selectReviewedProtocolPolicy} from './reviewed-protocol-profile.js';
import {assertReviewedProtocolCampaignReady} from './engine-adapter.js';
import type {MintState} from './fire.js';
export interface ReviewedSimulationProfile {registry:VerifiedReviewedErc721Registry;strategy:MintStrategy;clients:readonly [PublicClient,PublicClient];records:readonly TurnkeyCanonicalPolicyRecord[];}
export interface ReviewedSimulationOptions {store:BackendStore;campaign:Campaign;wallets:readonly string[];secretRoot?:string;load?:()=>Promise<ReviewedSimulationProfile>;now?:()=>Date;}
const safe=(error:unknown)=>error instanceof Error&&/^(?:ERC721_|REVIEWED_|TURNKEY_|MINT_)[A-Z0-9_]{1,90}$/.test(error.message)?error.message:'REVIEWED_PROTOCOL_SIMULATION_UNAVAILABLE';
async function profile(input:ReviewedSimulationOptions):Promise<ReviewedSimulationProfile>{
 if(input.load)return input.load();if(!input.secretRoot)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');
 const [profiles,records]=await Promise.all([loadReviewedProtocolStrategies(input.secretRoot),readTurnkeyApprovedPolicyRecords('mainnet',input.secretRoot)]);const matching=profiles.filter(value=>value.registry.chainId===input.campaign.chainId);if(matching.length!==1)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');return {...matching[0]!,records};
}
function scope(input:ReviewedSimulationOptions,loaded:ReviewedSimulationProfile,clock:()=>Date){
 assertReviewedRegistryCurrent(loaded.registry,clock());assertReviewedProtocolCampaignReady(input.campaign,input.store.snapshot(),clock());
 const current=input.store.snapshot().campaigns.find(value=>value.id===input.campaign.id);if(!current||campaignInputDigest(current)!==campaignInputDigest(input.campaign))throw new Error('REVIEWED_PROTOCOL_CAMPAIGN_CHANGED');
 const selected=selectReviewedProtocolPolicy(loaded.records,{...input.campaign,walletScope:input.wallets,reviewedProtocol:input.campaign.custodyPolicy?.reviewedProtocol},loaded.registry);
 const binding=input.campaign.custodyPolicy;
 if(!binding||!selected||selected.recordDigest!==binding.recordDigest||selected.policyReference!==binding.policyReference||selected.policyDigest!==binding.policyDigest)throw new Error('REVIEWED_PROTOCOL_CUSTODY_REQUIRED');
 const record=loaded.records.find(value=>turnkeyPolicyRecordDigest(value)===selected.recordDigest);if(!record||Date.parse(record.issuedAt)>clock().getTime()||Date.parse(record.expiresAt)<=clock().getTime())throw new Error('REVIEWED_PROTOCOL_CUSTODY_REQUIRED');
 return record;
}
export async function reviewedProtocolCampaignMintState(input:Omit<ReviewedSimulationOptions,'wallets'>&{wallets?:readonly string[]}):Promise<MintState>{
 try{const loaded=await profile({...input,wallets:input.wallets??[]});const wallets=input.wallets??loaded.records.find(value=>turnkeyPolicyRecordDigest(value)===input.campaign.custodyPolicy?.recordDigest)?.enforcementPolicy.transaction.from.slice(0,10)??[];
 scope({...input,wallets},loaded,input.now??(()=>new Date()));const drop=await loaded.strategy.readDrop(loaded.clients[0],input.campaign.contract as Address,input.campaign.chainId);const at=Math.floor((input.now??(()=>new Date()))().getTime()/1000);return at<drop.startTime?'upcoming':at>=drop.endTime||drop.totalMinted+BigInt(input.campaign.quantity)>drop.maxTokenSupply?'ended':'open';}catch{return 'unknown';}
}
/** Own-wallet calls at a pinned agreed block. API pricing/SeaDrop adapters never enter this route. */
export async function simulateReviewedProtocolCampaign(input:ReviewedSimulationOptions):Promise<{ids:string[];recorded:string[];skipped:Array<{wallet:string;why:string}>}>{
 try{
  const clock=input.now??(()=>new Date()),started=clock().getTime();if(input.campaign.strategy!=='erc721-reviewed-public-v1'||!input.wallets.length||input.wallets.length>10||new Set(input.wallets.map(value=>value.toLowerCase())).size!==input.wallets.length||input.wallets.some(value=>!/^0x[0-9a-f]{40}$/i.test(value)))throw new Error('REVIEWED_PROTOCOL_WALLET_SCOPE_INVALID');
  const loaded=await profile(input);const record=scope(input,loaded,clock);const drop=await loaded.strategy.readDrop(loaded.clients[0],input.campaign.contract as Address,input.campaign.chainId);if(drop.extra?.['descriptorDigest']!==input.campaign.custodyPolicy?.reviewedProtocol?.descriptorDigest||drop.mintPrice!==0n)throw new Error('REVIEWED_PROTOCOL_DESCRIPTOR_CHANGED');
  const anchor=drop.extra?.['authorityBlock'],hash=drop.extra?.['authorityHash'];if(typeof anchor!=='string'||!/^\d+$/.test(anchor)||typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('REVIEWED_PROTOCOL_BLOCK_REQUIRED');const blockNumber=BigInt(anchor);const seconds=Math.floor(clock().getTime()/1000);if(seconds<drop.startTime||seconds>=drop.endTime)throw new Error('MINT_NOT_OPEN');
  const passing:Array<{wallet:string;success:true;gasEstimate:bigint}>=[],skipped:Array<{wallet:string;why:string}>=[];
  for(const wallet of input.wallets){try{const data=loaded.strategy.buildCalldata(drop,wallet as Address,input.campaign.quantity);const gasEstimate=await loaded.strategy.estimateGas(loaded.clients[0],drop,wallet as Address,input.campaign.quantity);if(gasEstimate>BigInt(record.enforcementPolicy.transaction.gasLimitMax)||gasEstimate*BigInt(record.enforcementPolicy.transaction.maxFeePerGasMax)>input.campaign.spendPolicy.gasCeilingWei)throw new Error('REVIEWED_PROTOCOL_FEE_CEILING');
   const calls=await Promise.all(loaded.clients.map(client=>client.call({account:wallet as Address,to:input.campaign.contract as Address,data,value:0n,blockNumber})));if(calls[0]?.data!==calls[1]?.data)throw new Error('ERC721_PROVIDER_STATE_DISAGREEMENT');passing.push({wallet:wallet.toLowerCase(),success:true,gasEstimate});
  }catch(error){skipped.push({wallet:wallet.toLowerCase(),why:safe(error)});}}
  const blocks=await Promise.all(loaded.clients.map(async client=>({chain:await client.getChainId(),block:await client.getBlock({blockNumber})})));if(blocks.some(value=>value.chain!==input.campaign.chainId||value.block.hash?.toLowerCase()!==hash.toLowerCase()))throw new Error('REVIEWED_PROTOCOL_BLOCK_REORGED');
  scope(input,await profile(input),clock);const at=clock().getTime();if(at<started||at-started>30000||Math.floor(at/1000)>=drop.endTime)throw new Error('REVIEWED_PROTOCOL_SIMULATION_STALE');
  const ids=await recordWalletSimulations(input.store,input.campaign,passing,{blockNumber,blockHash:hash as Hex},clock);return {ids,recorded:passing.map(value=>value.wallet),skipped};
 }catch(error){throw new Error(safe(error));}
}
