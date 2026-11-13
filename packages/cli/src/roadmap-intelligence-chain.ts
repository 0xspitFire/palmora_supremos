import { BaseFinalityObserver, IndependentBaseFinalityObserver, RobinhoodFinalityObserver, baseReceiptFees, readBaseOperatorFee } from '@mint-bot/engine';
import { parseAbi, type Hash } from 'viem';
import type { ExecutionChainId, ExternalAnalyticsChainPort } from '@mint-bot/backend';
import { createExternalAnalyticsChainPort, type ExternalAnalyticsChainOptions } from './external-analytics-chain.js';
import { createNitroFinalitySources } from './robinhood-readonly.js';
import { createSourcifyIntelligenceReaders } from './advanced-intelligence-sourcify.js';
import type { RoadmapReader } from './roadmap-intelligence.js';
/** Canonical 1.6 deployments: https://github.com/ProjectOpenSea/seaport/blob/main/docs/Deployments.md.
 * Address alone never authorizes decoding economics. Version, exact source and both runtime views must match. */
export const ROADMAP_SEAPORT_16='0x0000000000000068f116a894984e2db1123eb395';
const INFORMATION=parseAbi(['function information() view returns (string version,bytes32 domainSeparator,address conduitController)']);
export async function observeRoadmapFinality(input:Parameters<NonNullable<ExternalAnalyticsChainOptions['finality']>>[0]):Promise<boolean>{
 if(input.readers.length<2)return false;const anchors={txHash:input.transactionHash as Hash,txBlockNumber:input.blockNumber};
 if(input.chainId===8453){const observers=input.readers.slice(0,2).map(({client})=>new BaseFinalityObserver({chainId:8453,expectedBlockHash:input.blockHash as Hash,currentBlockNumber:()=>client.getBlockNumber(),receiptBlockHash:async hash=>(await client.getTransactionReceipt({hash})).blockHash,canonicalBlockHash:async blockNumber=>(await client.getBlock({blockNumber})).hash,safeBlockNumber:async()=>(await client.getBlock({blockTag:'safe'})).number,finalizedBlockNumber:async()=>(await client.getBlock({blockTag:'finalized'})).number}));const result=await new IndependentBaseFinalityObserver(observers[0]!,observers[1]!).observe(anchors);return result.ready&&result.canonical===true&&result.stage==='ethereum_final';}
 if(input.chainId===4663){const observed=await Promise.all(input.readers.slice(0,2).map(async({client})=>{const sources=createNitroFinalitySources(client);if(!await sources.isPosted(anchors.txHash,anchors.txBlockNumber))return {ready:false,canonical:null,stage:'soft'};return new RobinhoodFinalityObserver({...sources,expectedBlockHash:input.blockHash as Hash},1).observe(anchors);}));return observed.every(row=>row.ready&&row.canonical===true&&row.stage==='ethereum_final');}
 return input.chainId===1;
}
export function createRoadmapChainPorts(options:{clients(chainId:ExecutionChainId):Promise<readonly RoadmapReader[]>;now?:()=>Date;sourceVerifier?:ReturnType<typeof createSourcifyIntelligenceReaders>}){
 const now=options.now??(()=>new Date());const verified=new Map<number,{at:number;allowed:boolean}>();
 const source=options.sourceVerifier??createSourcifyIntelligenceReaders({clients:async chainId=>(await options.clients(chainId)).map(reader=>reader.client),expectedContractName:'Seaport'});
 const protocol=async(chainId:ExecutionChainId,readers:readonly RoadmapReader[]):Promise<boolean>=>{
  const previous=verified.get(chainId);if(previous&&+now()-previous.at>=0&&+now()-previous.at<60000)return previous.allowed;
  let allowed=false;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  try{let calls=0;const evidence=await source.sourceVerified?.({chainId,contract:ROADMAP_SEAPORT_16,now:now(),signal:controller.signal,consumeRpc(count=1){calls+=count;if(calls>16)throw new Error('ROADMAP_PROTOCOL_READ_BUDGET');}});
   if(evidence?.value===true){const heads=await Promise.all(readers.slice(0,2).map(reader=>reader.client.getBlockNumber()));const common=(heads[0]!<heads[1]!?heads[0]!:heads[1]!)-2n;
    const info=await Promise.all(readers.slice(0,2).map(async({client})=>{const [block,data]=await Promise.all([client.getBlock({blockNumber:common}),client.readContract({address:ROADMAP_SEAPORT_16,abi:INFORMATION,functionName:'information',blockNumber:common})]);return {hash:block.hash,data};}));
    allowed=!controller.signal.aborted&&info.every(view=>!!view.hash&&Array.isArray(view.data)&&view.data[0]==='1.6')&&JSON.stringify(info[0])===JSON.stringify(info[1]);
   }
  }catch{/* Missing source/protocol proof leaves economic amounts unknown. */}finally{controller.abort();clearTimeout(timer);}
  verified.set(chainId,{at:+now(),allowed});return allowed;
 };
 return async(chainId:ExecutionChainId):Promise<ExternalAnalyticsChainPort>=>{
  const readers=await options.clients(chainId);if(readers.length<2||readers[0]!.identity===readers[1]!.identity)throw new Error('EXTERNAL_ANALYTICS_INDEPENDENT_READERS_REQUIRED');
  const allowed=await protocol(chainId,readers);const oracleFees=new Map<string,bigint>();
  return createExternalAnalyticsChainPort({chainId,readers,seaportAddresses:allowed?[ROADMAP_SEAPORT_16]:[],...(chainId===1?{wethAddress:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'}:chainId===8453?{wethAddress:'0x4200000000000000000000000000000000000006'}:{}),finality:async input=>{const ready=await observeRoadmapFinality(input);if(ready&&input.chainId===8453){try{const fees=await Promise.all(input.readers.slice(0,2).map(async({client})=>{const receipt=await client.getTransactionReceipt({hash:input.transactionHash as Hash});if(receipt.blockHash.toLowerCase()!==input.blockHash.toLowerCase()||receipt.blockNumber!==input.blockNumber)throw new Error('EXTERNAL_ANALYTICS_REORGED');return readBaseOperatorFee(client,receipt.gasUsed,input.blockNumber);}));if(fees[0]===fees[1]){oracleFees.set(input.transactionHash.toLowerCase(),fees[0]!);if(oracleFees.size>20)oracleFees.delete(oracleFees.keys().next().value!);}}catch(error){if(error instanceof Error&&error.message==='EXTERNAL_ANALYTICS_REORGED')throw error;/* Fees remain unknown without independent oracle agreement. */}}return ready;},totalFeeWei(id,receipt){const execution=receipt.gasUsed*receipt.effectiveGasPrice;if(id===4663)return execution;if(id!==8453)return execution;try{const fees=baseReceiptFees({l1Fee:receipt.l1Fee,operatorFee:receipt.operatorFee},receipt.gasUsed,oracleFees.get(receipt.transactionHash.toLowerCase()));return execution+fees.l1DataFeeWei+fees.operatorFeeWei;}catch{return null;}}});
 };
}
