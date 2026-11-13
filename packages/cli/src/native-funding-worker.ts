import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyFundingWorkerJournal } from '@mint-bot/database';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, type PublicClient, type Hex } from 'viem';
import { NativeFundingEngine, TurnkeyFundingSigner, projectTurnkeyFundingPolicy, verifyTurnkeyFundingRecord, createTurnkeyClient, quoteBaseFeeBound, readTurnkeyFundingCredentials, type NativeFundingReader, type SignedTurnkeyFundingRecord, type TransactionIntent } from '@mint-bot/engine';
import { assertNoSymlinkParents } from './turnkey-files.js';
import { startFundingIpcServer, type FundingAdmission } from './native-funding-ipc.js';
import { createFundingBudgetJournal, createPrivateFundingJournal, assertPrivateFundingJournalPath, type FundingBudgetJournal } from './native-funding-worker-journal.js';
import { nativeFundingReceiptObservations, nativeFundingCanonicalBlocks, type NativeFundingReceiptReader } from './native-funding-receipts.js';
const NITRO=parseAbi(['function gasEstimateComponents(address to,bool contractCreation,bytes data) payable returns (uint64 gasEstimate,uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)']);
const nodeInterface='0x00000000000000000000000000000000000000c8';
export function createNativeFundingRpcReader(client:PublicClient):NativeFundingReader{
 const tx=(intent:TransactionIntent)=>({account:intent.from,to:intent.to,data:intent.data,value:intent.value,nonce:intent.nonce,gas:intent.gasLimit,maxFeePerGas:intent.maxFeePerGas,maxPriorityFeePerGas:intent.maxPriorityFeePerGas});
 return {getChainId:()=>client.getChainId(),getBlockNumber:()=>client.getBlockNumber(),getBlock:async number=>{const row=await client.getBlock({blockNumber:number});if(row.number===null||!row.hash)throw new Error('NATIVE_FUNDING_BLOCK_UNKNOWN');return {number:row.number,hash:row.hash,timestamp:row.timestamp};},getBalance:(address,block)=>client.getBalance({address,...(block==='pending'?{blockTag:'pending' as const}:{blockNumber:block})}),getCode:async(address,block)=>(await client.getCode({address,...(block==='pending'?{blockTag:'pending' as const}:{blockNumber:block})}))??'0x',getPendingNonce:address=>client.getTransactionCount({address,blockTag:'pending'}),estimateGas:(intent,block)=>client.estimateGas({...tx(intent),blockNumber:block}),simulate:async(intent,block)=>(await client.call({...tx(intent),blockNumber:block})).data,async feeBounds(intent,block){
  if(intent.chainId===1)return {l1DataFeeBoundWei:0n,operatorFeeBoundWei:0n};
  if(intent.chainId===8453){const atBlock={...client,readContract:(input:Record<string,unknown>)=>client.readContract({...input,blockNumber:block} as never)} as unknown as PublicClient;const bound=await quoteBaseFeeBound(atBlock,{type:'eip1559',chainId:8453,nonce:intent.nonce,to:intent.to,value:intent.value,data:'0x',gas:intent.gasLimit,maxFeePerGas:intent.maxFeePerGas,maxPriorityFeePerGas:intent.maxPriorityFeePerGas,accessList:[]});return {l1DataFeeBoundWei:bound.l1DataFeeWei,operatorFeeBoundWei:bound.operatorFeeWei};}
  // Nitro total gas includes its L1 data component. Prove that shape rather than
  // invent an absent fee. Primary: OffchainLabs/nitro-contracts NodeInterface.sol.
  const result=await client.call({account:intent.from,to:nodeInterface,data:encodeFunctionData({abi:NITRO,functionName:'gasEstimateComponents',args:[intent.to,false,'0x']}),value:intent.value,blockNumber:block});if(!result.data)throw new Error('NATIVE_FUNDING_NITRO_FEE_UNKNOWN');const [total,l1,baseFee,l1Base]=decodeFunctionResult({abi:NITRO,functionName:'gasEstimateComponents',data:result.data});
  if(total<=0n||l1<0n||l1>total||total>intent.gasLimit||baseFee<=0n||baseFee>intent.maxFeePerGas||l1Base<=0n)throw new Error('NATIVE_FUNDING_NITRO_GAS_BOUND_REQUIRED');return {l1DataFeeBoundWei:0n,operatorFeeBoundWei:0n};
 }};
}
export interface NativeFundingWorkerProfile{version:1;role:'funding-worker';enabled:true;socketPath:string;workerUid:number;brokerUid:number;socketGid:number;brokerPublicKeyPath:string;ownerPublicKeyPath:string;catalogPath:string;credentialPath:string;rpcProfilePath:string;killSwitchPath:string;journalPath:string;journalId:string;}
/** Root-owned public configuration or worker-only credential paths; no mint secret-store fallback. */
export async function readFundingRootFile(path:string):Promise<string>{
 if(!isAbsolute(path))throw new Error('NATIVE_FUNDING_PROFILE_PATH_REQUIRED');await assertNoSymlinkParents(path,'NATIVE_FUNDING_PROFILE_PERMISSIONS_REQUIRED');const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const metadata=await handle.stat();if(!metadata.isFile()||metadata.uid!==0||(metadata.mode&0o022)!==0||metadata.size>131072)throw new Error('NATIVE_FUNDING_PROFILE_PERMISSIONS_REQUIRED');const text=await handle.readFile('utf8');if(Buffer.byteLength(text)>131072)throw new Error('NATIVE_FUNDING_PROFILE_INVALID');return text;}finally{await handle.close();}
}
export async function startNativeFundingWorker(options:{path:string;workerUid:number;socketGid?:number;brokerPublicKey:string;ownerPublicKey:string;catalog:readonly SignedTurnkeyFundingRecord[];readers(chainId:1|8453|4663):Promise<readonly {endpoint:string;client:NativeFundingReader}[]>;signer(chainId:1|8453|4663):Promise<{sign(intent:TransactionIntent,assertCurrent:()=>Promise<void>):Promise<Hex>}>;assertKillClear():Promise<void>;journal:FundingBudgetJournal;now?:()=>Date}){
 const now=options.now??(()=>new Date());
 const assertCurrent=async(admission:FundingAdmission,intent:TransactionIntent,assertPermit:()=>void)=>{
  assertPermit();await options.assertKillClear();const record=options.catalog.find(row=>row.recordDigest===admission.payload.recordDigest);if(!record)throw new Error('NATIVE_FUNDING_RECORD_NOT_APPROVED');const verified=verifyTurnkeyFundingRecord(record,options.ownerPublicKey,now());const policy=projectTurnkeyFundingPolicy(verified,options.ownerPublicKey,true,now());
  if(intent.chainId!==policy.chainId||intent.from.toLowerCase()!==policy.hub.toLowerCase()||intent.policyRef!==policy.policyReference||intent.evidenceRef!==admission.payload.parentHoldDigest||intent.runId!==admission.payload.parentHoldId||intent.data!=='0x'||intent.value<=0n||intent.value>policy.maxTransferWei||intent.gasLimit!==policy.gasLimitMax||intent.maxFeePerGas!==policy.maxFeePerGas||intent.maxPriorityFeePerGas!==policy.maxPriorityFeePerGas||!policy.recipients.some(address=>address.toLowerCase()===intent.to.toLowerCase()))throw new Error('NATIVE_FUNDING_WORKER_INTENT_REFUSED');
  const readers=await options.readers(intent.chainId);if(readers.length!==2)throw new Error('NATIVE_FUNDING_INDEPENDENT_READERS_REQUIRED');const balances=await Promise.all(readers.map(async reader=>{if(await reader.client.getCode(intent.from,'pending')!=='0x')throw new Error('NATIVE_FUNDING_HUB_CODE_REFUSED');return reader.client.getBalance(intent.to,'pending');}));if(balances[0]!==balances[1])throw new Error('NATIVE_FUNDING_RPC_DISAGREEMENT');
  const engine=new NativeFundingEngine({readers,signer:{address:intent.from,sign:async()=>{throw new Error('NATIVE_FUNDING_WORKER_INTERNAL_ONLY');}},broadcast:async()=>{throw new Error('NATIVE_FUNDING_WORKER_NEVER_BROADCASTS');},now});
  const preparation=await engine.prepare({id:admission.payload.requestId,parentRunId:admission.payload.parentHoldId,parentHoldId:admission.payload.parentHoldId,parentHoldDigest:admission.payload.parentHoldDigest,chainId:intent.chainId,recipient:intent.to,requiredBalanceWei:balances[0]!+intent.value,expiresAt:admission.payload.expiresAt},policy);
  const fee=preparation.gasLimit*preparation.maxFeePerGas+preparation.l1DataFeeBoundWei+preparation.operatorFeeBoundWei;
  if(preparation.nonce!==intent.nonce||preparation.valueWei!==intent.value||preparation.hubBalanceWei>policy.hubMaxBalanceWei||preparation.recipientBalanceWei+intent.value>policy.recipientMaxBalanceWei||preparation.fleetBalanceWei+intent.value>policy.fleetMaxBalanceWei||fee>policy.maxTransferFeeWei||preparation.hubBalanceWei<intent.value+fee+policy.hubReserveWei)throw new Error('NATIVE_FUNDING_WORKER_ENVELOPE_REFUSED');
  assertPermit();await options.assertKillClear();verifyTurnkeyFundingRecord(record,options.ownerPublicKey,now());
  return {policy,preparation};
 };
 const active=new Set<Promise<Hex>>();let stopping=false;
 const ipc=await startFundingIpcServer({path:options.path,workerUid:options.workerUid,socketGid:options.socketGid,brokerPublicKey:options.brokerPublicKey,now,sign:(admission,intent,assertPermit)=>{
  if(stopping)throw new Error('NATIVE_FUNDING_WORKER_STOPPING');
  const operation=(async()=>{const current=await assertCurrent(admission,intent,assertPermit);const signer=await options.signer(intent.chainId);return options.journal.sign({admission,intent,...current},reconfirm=>signer.sign(intent,reconfirm),async()=>{await assertCurrent(admission,intent,assertPermit);});})();
  active.add(operation);void operation.finally(()=>active.delete(operation)).catch(()=>undefined);return operation;
 }});
 let timer:ReturnType<typeof setTimeout>|undefined;let reconciliation:Promise<void>|undefined;
 const schedule=()=>{if(!stopping){timer=setTimeout(()=>{reconciliation=options.journal.reconcile();void reconciliation.catch(()=>undefined).finally(()=>{reconciliation=undefined;schedule();});},30000);timer.unref();}};schedule();
 return {server:ipc.server,async stop(){stopping=true;if(timer)clearTimeout(timer);await ipc.stop();await Promise.allSettled([...active]);await options.journal.close();await reconciliation;}};
}
async function loadNativeFundingWorkerFromProfile(path:string){
 process.umask(0o077);const profileText=await readFundingRootFile(path);const profile=JSON.parse(profileText) as NativeFundingWorkerProfile;if(profile.version!==1||profile.role!=='funding-worker'||profile.enabled!==true||!Number.isSafeInteger(profile.workerUid)||profile.workerUid<=0||!Number.isSafeInteger(profile.brokerUid)||profile.brokerUid<=0||profile.brokerUid===profile.workerUid||process.geteuid?.()!==profile.workerUid||!Number.isSafeInteger(profile.socketGid)||profile.socketGid<=0)throw new Error('NATIVE_FUNDING_WORKER_IDENTITY_REQUIRED');
 const catalogText=await readFundingRootFile(profile.catalogPath);const catalog=JSON.parse(catalogText) as SignedTurnkeyFundingRecord[];const ownerPublicKey=await readFundingRootFile(profile.ownerPublicKeyPath);const brokerPublicKey=await readFundingRootFile(profile.brokerPublicKeyPath);if(!Array.isArray(catalog)||catalog.length<1||catalog.length>3)throw new Error('NATIVE_FUNDING_CATALOG_INVALID');catalog.forEach(record=>verifyTurnkeyFundingRecord(record,ownerPublicKey));
 await assertPrivateFundingJournalPath(profile.journalPath,profile.workerUid);if(verifyFundingWorkerJournal(profile.journalPath,profile.journalId).state!=='ready')throw new Error('NATIVE_FUNDING_JOURNAL_RECOVERY_REQUIRED');
 const credentials=await readTurnkeyFundingCredentials(profile.credentialPath);if(catalog.some(record=>record.record.organizationId!==credentials.organizationId||record.record.userId!==credentials.userId))throw new Error('NATIVE_FUNDING_WORKER_IDENTITY_REQUIRED');
 const rpc=JSON.parse(await readFundingRootFile(profile.rpcProfilePath)) as Array<{chainId:1|8453|4663;endpoints:string[]}>;const readerMap=new Map<number,Array<{endpoint:string;client:NativeFundingReader}>>();
 for(const row of rpc){if(!catalog.some(record=>record.record.chainId===row.chainId)||!Array.isArray(row.endpoints)||row.endpoints.length!==2)throw new Error('NATIVE_FUNDING_RPC_PROFILE_INVALID');const hosts=row.endpoints.map(endpoint=>{const url=new URL(endpoint);if(url.protocol!=='https:')throw new Error('NATIVE_FUNDING_RPC_PROFILE_INVALID');return url.hostname.toLowerCase();});if(hosts[0]===hosts[1])throw new Error('NATIVE_FUNDING_INDEPENDENT_READERS_REQUIRED');readerMap.set(row.chainId,row.endpoints.map(endpoint=>({endpoint,client:createNativeFundingRpcReader(createPublicClient({transport:http(endpoint,{timeout:5000,retryCount:0})}))})));}
 const receiptReaders=new Map<number,NativeFundingReceiptReader[]>();
 for(const row of rpc)receiptReaders.set(row.chainId,row.endpoints.map(endpoint=>({endpoint,client:createPublicClient({transport:http(endpoint,{timeout:5000,retryCount:0})})})));
 await assertPrivateFundingJournalPath(profile.journalPath,profile.workerUid);
 const journal=await createFundingBudgetJournal({openJournal:authority=>createPrivateFundingJournal(profile.journalPath,profile.workerUid,authority,profile.journalId),brokerPublicKey,currentPolicy:recordDigest=>{const record=catalog.find(row=>row.recordDigest===recordDigest);if(!record)throw new Error('NATIVE_FUNDING_RECORD_NOT_APPROVED');return projectTurnkeyFundingPolicy(record,ownerPublicKey,true);},receipts:record=>nativeFundingReceiptObservations(record,receiptReaders.get(record.request.chainId)??[]),canonicalBlocks:record=>nativeFundingCanonicalBlocks(record,receiptReaders.get(record.request.chainId)??[])});
 const client=createTurnkeyClient(credentials.organizationId,credentials.apiPublicKey,credentials.apiPrivateKey);
 try{return await startNativeFundingWorker({path:profile.socketPath,workerUid:profile.workerUid,socketGid:profile.socketGid,brokerPublicKey,ownerPublicKey,catalog,journal,readers:async chainId=>{const pair=readerMap.get(chainId);if(!pair)throw new Error('NATIVE_FUNDING_CHAIN_NOT_APPROVED');return pair;},signer:async chainId=>new TurnkeyFundingSigner({catalog,publicKey:ownerPublicKey,chainId,client}),assertKillClear:async()=>{await assertPrivateFundingJournalPath(profile.journalPath,profile.workerUid);if(await readFundingRootFile(path)!==profileText||await readFundingRootFile(profile.catalogPath)!==catalogText||await readFundingRootFile(profile.ownerPublicKeyPath)!==ownerPublicKey||await readFundingRootFile(profile.brokerPublicKeyPath)!==brokerPublicKey)throw new Error('NATIVE_FUNDING_PROFILE_CHANGED');try{const {lstat}=await import('node:fs/promises');await lstat(profile.killSwitchPath);throw new Error('NATIVE_FUNDING_KILLED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('NATIVE_FUNDING_KILLED');}}});}catch(error){await journal.close();throw error;}
}

export async function startNativeFundingWorkerFromProfile(path:string){try{return await loadNativeFundingWorkerFromProfile(path);}catch(error){throw new Error(error instanceof Error&&/^(?:NATIVE_FUNDING|TURNKEY_FUNDING)_[A-Z_]{1,80}$/.test(error.message)?error.message:'NATIVE_FUNDING_WORKER_CONFIGURATION_INVALID');}}

/** Public profile path only; no credential or secret value is accepted in argv. */
export function nativeFundingWorkerProfilePath(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
 const path=args.length===0?environment.MINT_BOT_FUNDING_WORKER_PROFILE_PATH:args.length===2&&args[0]==='--profile'?args[1]:undefined;
 if(!path||!isAbsolute(path))throw new Error('NATIVE_FUNDING_WORKER_PROFILE_ARGUMENT_REQUIRED');return path;
}
async function nativeFundingWorkerMain():Promise<void>{
 const args=process.argv.slice(2);
 if(args.includes('--initialize-journal')){
  if(args.length!==5||args[0]!=='--profile'||args[2]!=='--initialize-journal'||args[3]!=='--confirm')throw new Error('NATIVE_FUNDING_WORKER_PROFILE_ARGUMENT_REQUIRED');
  const text=await readFundingRootFile(args[1]!);const profile=JSON.parse(text) as NativeFundingWorkerProfile;
  const digest='sha256:'+createHash('sha256').update(text).digest('hex');
  if(args[4]!==`INITIALIZE FUNDING JOURNAL ${digest}`||profile.version!==1||profile.role!=='funding-worker'||profile.enabled!==true||!Number.isSafeInteger(profile.brokerUid)||profile.brokerUid<=0||profile.brokerUid===profile.workerUid||profile.workerUid!==process.geteuid?.())throw new Error('NATIVE_FUNDING_JOURNAL_INITIALIZATION_REFUSED');
  const journal=await createPrivateFundingJournal(profile.journalPath,profile.workerUid,{assertCurrent(){throw new Error('NATIVE_FUNDING_JOURNAL_OFFLINE_INITIALIZER');}},profile.journalId,{profileDigest:digest});journal.close();return;
 }
 const service=await startNativeFundingWorkerFromProfile(nativeFundingWorkerProfilePath(process.argv.slice(2)));
 await new Promise<void>((done,reject)=>{let stopping=false;const stop=()=>{if(stopping)return;stopping=true;process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);void service.stop().then(done,reject);};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void nativeFundingWorkerMain().catch(error=>{const code=error instanceof Error&&/^(?:NATIVE_FUNDING|TURNKEY_FUNDING)_[A-Z_]{1,80}$/.test(error.message)?error.message:'NATIVE_FUNDING_WORKER_CONFIGURATION_INVALID';process.stderr.write(code+'\n');process.exitCode=1;});
