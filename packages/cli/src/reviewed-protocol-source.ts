import { decodeEventLog, decodeFunctionData, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { type ObservedMintTransaction, type VerifiedReviewedErc721Registry, assertReviewedRegistryCurrent } from '@mint-bot/engine';
import { createReviewedProtocolStrategy } from './reviewed-protocol-profile.js';
import type { QualifiedSource } from './replication-source.js';
const MINT=parseAbi(['function mint(uint256 quantity) payable']);
const TRANSFER=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const normalized=(value:unknown):string=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():typeof item==='string'?item.toLowerCase():item);

/** Watched input is a candidate only. The two configured readers establish a successful self mint. */
export async function readReviewedProtocolSource(input:{registry:VerifiedReviewedErc721Registry;clients:readonly [PublicClient,PublicClient];contract:Address;hash:Hex;watchedWallets:readonly string[];targetWallets:readonly Address[];now?:()=>Date}):Promise<QualifiedSource>{
 try {
 const clock=input.now??(()=>new Date());assertReviewedRegistryCurrent(input.registry,clock());
 if(input.clients[0]===input.clients[1] || !input.targetWallets.length || input.targetWallets.length>10 || new Set(input.targetWallets.map(value=>value.toLowerCase())).size!==input.targetWallets.length)throw new Error('REVIEWED_SOURCE_SCOPE_INVALID');
 const read=async(client:PublicClient)=>{
  const [tx,receipt,head,chain]=await Promise.all([client.getTransaction({hash:input.hash}),client.getTransactionReceipt({hash:input.hash}),client.getBlockNumber(),client.getChainId()]);
  if(chain!==input.registry.chainId || tx.hash.toLowerCase()!==input.hash.toLowerCase() || receipt.transactionHash.toLowerCase()!==input.hash.toLowerCase() || !Array.isArray(receipt.logs) || receipt.logs.length>1000 || receipt.status!=='success' || tx.to?.toLowerCase()!==input.contract.toLowerCase() || receipt.to?.toLowerCase()!==input.contract.toLowerCase() || receipt.from.toLowerCase()!==tx.from.toLowerCase() || tx.value!==0n || typeof tx.input!=='string' || tx.input.length!==74 || !input.watchedWallets.some(wallet=>wallet.toLowerCase()===tx.from.toLowerCase()) || tx.blockHash!==receipt.blockHash || tx.blockNumber!==receipt.blockNumber || head<receipt.blockNumber+2n)throw new Error('REVIEWED_WATCHED_MINT_NOT_VERIFIED');
  const block=await client.getBlock({blockNumber:receipt.blockNumber});if(block.hash!==receipt.blockHash)throw new Error('REVIEWED_SOURCE_REORGED');
  return {tx,receipt,block,canonical:normalized({chain,tx:{hash:tx.hash,from:tx.from,to:tx.to,value:tx.value,input:tx.input,blockHash:tx.blockHash,blockNumber:tx.blockNumber},receipt:{status:receipt.status,transactionHash:receipt.transactionHash,from:receipt.from,to:receipt.to,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber,logs:receipt.logs.map(log=>({address:log.address,data:log.data,topics:log.topics,logIndex:log.logIndex,removed:log.removed,blockHash:log.blockHash,transactionHash:log.transactionHash}))},block:{hash:block.hash,timestamp:block.timestamp}})};
 };
 const views=await Promise.all(input.clients.map(read));if(views[0]!.canonical!==views[1]!.canonical)throw new Error('REVIEWED_SOURCE_RPC_DISAGREEMENT');
 const {tx,receipt,block}=views[0]!;
 let quantity:number;try{const decoded=decodeFunctionData({abi:MINT,data:tx.input});quantity=Number(decoded.args[0]);if(!Number.isSafeInteger(quantity)||quantity<1||encodeFunctionData({abi:MINT,functionName:'mint',args:[BigInt(quantity)]}).toLowerCase()!==tx.input.toLowerCase())throw new Error();}catch{throw new Error('REVIEWED_SOURCE_CALLDATA_INVALID');}
 const minted=new Set<string>();
 for(const log of receipt.logs){if(log.address.toLowerCase()!==input.contract.toLowerCase())continue;try{const decoded=decodeEventLog({abi:TRANSFER,data:log.data,topics:log.topics,strict:true});if(decoded.eventName!=='Transfer')continue;if(log.removed || log.blockHash!==receipt.blockHash || log.transactionHash.toLowerCase()!==input.hash.toLowerCase() || log.logIndex===null || decoded.args.from!==zeroAddress || decoded.args.to.toLowerCase()!==tx.from.toLowerCase() || minted.has(decoded.args.tokenId.toString()))throw new Error('REVIEWED_SOURCE_MINT_LOG_INVALID');minted.add(decoded.args.tokenId.toString());}catch(error){if(error instanceof Error&&error.message==='REVIEWED_SOURCE_MINT_LOG_INVALID')throw error;}}
 if(minted.size!==quantity)throw new Error('REVIEWED_SOURCE_MINT_QUANTITY_INVALID');
 const strategy=createReviewedProtocolStrategy(input.registry,input.clients,clock);const drop=await strategy.readDrop(input.clients[0],input.contract,input.registry.chainId);
 const ownQuantity=Math.min(quantity,drop.maxTotalMintableByWallet);
 const targets=[];for(const wallet of input.targetWallets){
  try{const proof=await strategy.signingAuthority!(input.clients[0],drop,wallet,ownQuantity);targets.push({wallet,to:input.contract,value:0n,data:proof.data,quantity:ownQuantity});}
  catch(error){
   // Only explicit per-wallet on-chain ineligibility is isolated. Provider,
   // registry, code or stage errors invalidate the whole qualification.
   const at=Math.floor(clock().getTime()/1000);
   if(!(error instanceof Error)||error.message!=='ERC721_WALLET_NOT_ELIGIBLE'||at<drop.startTime||at>=drop.endTime)throw error;
  }
 }
 if(!targets.length)throw new Error('REVIEWED_SOURCE_NO_ELIGIBLE_WALLETS');
 if(Math.floor(clock().getTime()/1000)<drop.startTime||Math.floor(clock().getTime()/1000)>=drop.endTime)throw new Error('REVIEWED_SOURCE_STALE');
 const age=clock().getTime()-Number(block.timestamp)*1000;assertReviewedRegistryCurrent(input.registry,clock());if(!Number.isFinite(age)||age<0||age>15*60000)throw new Error('REVIEWED_SOURCE_STALE');
 const observed:ObservedMintTransaction={chainId:input.registry.chainId,hash:input.hash,from:tx.from,to:input.contract,value:0n,data:tx.input,blockNumber:receipt.blockNumber,observedAt:new Date(Number(block.timestamp)*1000).toISOString()};
 const descriptorDigest=String(drop.extra?.['descriptorDigest']);
 return {sourceBlockHash:receipt.blockHash,observed,drop,mintedAt:observed.observedAt!,reviewedProtocol:{family:'erc721-reviewed-public-v1',registryDigest:input.registry.digest,descriptorDigest},plan:{version:'replication-plan-v1',verdict:'replicable',strategy:'erc721-reviewed-public-v1',source:{hash:input.hash,from:tx.from,chainId:input.registry.chainId,blockNumber:receipt.blockNumber,observedAt:observed.observedAt},observed:{nftContract:input.contract,quantity},checklist:{knownStrategy:true,chainMatches:true,targetMatches:true,selectorDecoded:true,contractMatches:true,feeRecipientMatches:true,walletIndependent:false,valueMatches:true,quantityWithinDrop:true,simulationRequired:true,operatorApprovalRequired:true},reasons:[],targets,operatorApprovalRequired:true,simulationRequired:true}};
 }catch(error){throw new Error(error instanceof Error&&/^(?:ERC721_|REVIEWED_)[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'REVIEWED_SOURCE_AUTHORITY_UNAVAILABLE');}
}
