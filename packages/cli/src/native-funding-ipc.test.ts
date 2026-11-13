import { createTurnkeyFundingRecord } from '@mint-bot/engine';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {describe,expect,it,vi} from 'vitest';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {signTurnkeyFundingRecord,projectTurnkeyFundingPolicy,type NativeFundingReader,type TurnkeyFundingRecord,type TransactionIntent} from '@mint-bot/engine';
import {createFundingAdmission,requestFundingSignature,startFundingIpcServer,verifyFundingAdmission,type FundingAdmission} from './native-funding-ipc.js';
import {startNativeFundingWorker} from './native-funding-worker.js';
import {createFundingBudgetJournal,createPrivateFundingJournal} from './native-funding-worker-journal.js';
const now=new Date('2026-11-13T15:00:00Z');const account=privateKeyToAccount(generatePrivateKey());const recipient=`0x${'2'.repeat(40)}` as const;const digest=`sha256:${'a'.repeat(64)}`;const pair=()=>{const value=generateKeyPairSync('ed25519');return {private:value.privateKey.export({type:'pkcs8',format:'pem'}).toString(),public:value.publicKey.export({type:'spki',format:'pem'}).toString()};};
const broker=pair(),owner=pair();
function record():TurnkeyFundingRecord{return createTurnkeyFundingRecord({version:1,kind:'native-fleet-topup-v1',organizationId:'isolated-funding',mintOrganizationId:'mint-only',userId:'fund-only',keyId:'hub-key',policyId:'fund-policy',chainId:1,hub:account.address,recipients:[recipient],issuedAt:now.toISOString(),expiresAt:new Date(+now+86400000).toISOString(),maxTransferWei:'4100000000000000',rollingPrincipalCapWei:'8500000000000000',rollingFeeCapWei:'200000000000000',maxTransferFeeWei:'20000000000000',hubMaxBalanceWei:'8700000000000000',recipientMaxBalanceWei:'4100000000000000',fleetMaxBalanceWei:'8500000000000000',gasLimitMax:'21000',maxFeePerGas:'200000000',maxPriorityFeePerGas:'100000000'},now);}
const envelope=signTurnkeyFundingRecord(record(),owner.private,now);const policy=projectTurnkeyFundingPolicy(envelope,owner.public,true,now);
const intent:TransactionIntent={chainId:1,from:account.address,to:recipient,value:90n,data:'0x',nonce:0,gasLimit:21000n,maxFeePerGas:200000000n,maxPriorityFeePerGas:100000000n,runId:'hold-one',policyRef:policy.policyReference,evidenceRef:digest};
const admission=(challenge:string,change:Partial<TransactionIntent>={},key=broker.private)=>createFundingAdmission({challenge,intent:{...intent,...change},requestId:'hold-one:wallet',parentHoldId:'hold-one',parentHoldDigest:digest,requestDigest:digest,recordDigest:envelope.recordDigest,key,now});
function reader():NativeFundingReader{return {getChainId:async()=>1,getBlockNumber:async()=>100n,getBlock:async number=>({number,hash:`0x${'b'.repeat(64)}`,timestamp:BigInt(+now/1000)}),getBalance:async address=>address.toLowerCase()===account.address.toLowerCase()?10000000000000n:10n,getCode:async()=> '0x',getPendingNonce:async()=>0,estimateGas:async()=>21000n,simulate:async()=> '0x',feeBounds:async()=>({l1DataFeeBoundWei:0n,operatorFeeBoundWei:0n})};}
describe('isolated funding IPC permits',()=>{
 it('binds challenge, current time, exact intent and root-pinned broker identity',()=>{
 const challenge='c'.repeat(64),permit=admission(challenge);expect(verifyFundingAdmission(permit,challenge,broker.public,now).value).toBe(90n);
 expect(()=>verifyFundingAdmission(permit,'d'.repeat(64),broker.public,now)).toThrow('NATIVE_FUNDING_ADMISSION_INVALID');
 expect(()=>verifyFundingAdmission({...permit,intent:{...permit.intent,value:'91'}},challenge,broker.public,now)).toThrow('NATIVE_FUNDING_ADMISSION_INVALID');
 expect(()=>verifyFundingAdmission(permit,challenge,pair().public,now)).toThrow();expect(()=>verifyFundingAdmission(permit,challenge,broker.public,new Date(+now+20000))).toThrow();
 });
 it('uses an actual separate process and refuses a captured admission on a new connection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'funding-ipc-'));const path=join(directory,'worker.sock');const modulePath=resolve('packages/cli/dist/native-funding-ipc.js');
 const code=`import {startFundingIpcServer} from ${JSON.stringify(`file://${modulePath}`)};const service=await startFundingIpcServer({path:process.env.TEST_SOCKET,workerUid:process.getuid(),brokerPublicKey:process.env.TEST_PUBLIC,now:()=>new Date(${JSON.stringify(now.toISOString())}),sign:async()=> '0x1234'});process.stdout.write('READY\\n');process.on('SIGTERM',()=>{void service.stop().finally(()=>process.exit(0));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH,TEST_SOCKET:path,TEST_PUBLIC:broker.public},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',chunk=>{errors+=chunk.toString();});
 try{await new Promise<void>((resolveReady,reject)=>{child.stdout.on('data',chunk=>{if(chunk.toString().includes('READY'))resolveReady();});child.once('exit',()=>reject(new Error(`worker stopped ${errors}`)));});let captured:FundingAdmission|undefined;
 expect(await requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>{captured=admission(challenge);return captured;}})).toBe('0x1234');
 await expect(requestFundingSignature({path,workerUid:process.getuid!(),permit:async()=>captured!})).rejects.toThrow('NATIVE_FUNDING_IPC_UNAVAILABLE');
 }finally{child.kill('SIGTERM');await new Promise<void>(resolveExit=>{if(child.exitCode!==null)resolveExit();else child.once('exit',()=>resolveExit());});await rm(directory,{recursive:true,force:true});}
 });
 it('worker independently validates current RPC state, approved scope and kill before calling its funding-only signer',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'funding-worker-'));const path=join(directory,'worker.sock');let killed=false;const sign=vi.fn(async(_intent:TransactionIntent,assertCurrent:()=>Promise<void>)=>{await assertCurrent();return account.signTransaction({chainId:_intent.chainId,to:_intent.to,value:_intent.value,data:'0x',nonce:_intent.nonce,gas:_intent.gasLimit,maxFeePerGas:_intent.maxFeePerGas,maxPriorityFeePerGas:_intent.maxPriorityFeePerGas,type:'eip1559',accessList:[]});});const first=reader(),second=reader();
 const journal=await createFundingBudgetJournal({openJournal:authority=>createPrivateFundingJournal(join(directory,'worker-journal.sqlite'),process.getuid!(),authority,'ipc-journal',{profileDigest:digest}),brokerPublicKey:broker.public,currentPolicy:()=>projectTurnkeyFundingPolicy(envelope,owner.public,true,now),receipts:async()=>[],canonicalBlocks:async()=>[],now:()=>now});
 const worker=await startNativeFundingWorker({journal,path,workerUid:process.getuid!(),brokerPublicKey:broker.public,ownerPublicKey:owner.public,catalog:[envelope],now:()=>now,readers:async()=>[{endpoint:'https://first.example',client:first},{endpoint:'https://second.example',client:second}],signer:async()=>({sign}),assertKillClear:async()=>{if(killed)throw new Error('NATIVE_FUNDING_KILLED');}});
 try{expect(await requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>admission(challenge)})).toMatch(/^0x[0-9a-f]+$/);expect(sign).toHaveBeenCalledOnce();
 killed=true;await expect(requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>admission(challenge)})).rejects.toThrow();expect(sign).toHaveBeenCalledOnce();killed=false;
 await expect(requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>admission(challenge,{value:5000000000000000n})})).rejects.toThrow();expect(sign).toHaveBeenCalledOnce();
 second.getPendingNonce=async()=>1;await expect(requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>admission(challenge)})).rejects.toThrow();expect(sign).toHaveBeenCalledOnce();
 }finally{await worker.stop();await rm(directory,{recursive:true,force:true});}
 });
 it('does not expose a signing callback to unauthenticated requests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'funding-refuse-'));const path=join(directory,'worker.sock');const sign=vi.fn(async()=> '0x1234' as const);const worker=await startFundingIpcServer({path,workerUid:process.getuid!(),brokerPublicKey:broker.public,now:()=>now,sign});
 try{await expect(requestFundingSignature({path,workerUid:process.getuid!(),permit:async challenge=>admission(challenge,{},pair().private)})).rejects.toThrow();expect(sign).not.toHaveBeenCalled();}finally{await worker.stop();await rm(directory,{recursive:true,force:true});}
 });
});
