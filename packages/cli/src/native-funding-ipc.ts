import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { createConnection, createServer, type Server } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Hex } from 'viem';
import type { TransactionIntent } from '@mint-bot/engine';
export const FUNDING_IPC_MAX_BYTES=16384;
const DOMAIN='mintbot.native-funding-admission-v1\n';const digest=(value:unknown)=>`sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const HASH=/^sha256:[a-f0-9]{64}$/;const REF=/^[A-Za-z0-9_.:-]{1,180}$/;const CHALLENGE=/^[a-f0-9]{64}$/;
export interface FundingWireIntent{chainId:1|8453|4663;from:string;to:string;value:string;data:'0x';nonce:number;gasLimit:string;maxFeePerGas:string;maxPriorityFeePerGas:string;runId:string;policyRef:string;evidenceRef:string;}
export interface FundingAdmissionPayload{version:1;challenge:string;requestId:string;parentHoldId:string;parentHoldDigest:string;requestDigest:string;recordDigest:string;intentDigest:string;issuedAt:string;expiresAt:string;}
export interface FundingAdmission{payload:FundingAdmissionPayload;signature:string;intent:FundingWireIntent;}
const exact=(value:unknown,keys:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
export function fundingWireIntent(intent:TransactionIntent):FundingWireIntent{
 if(intent.data!=='0x'||(intent.accessList?.length??0)!==0||intent.familyContext||!intent.runId||!intent.policyRef||!intent.evidenceRef)throw new Error('NATIVE_FUNDING_IPC_INTENT_INVALID');
 return {chainId:intent.chainId,from:intent.from.toLowerCase(),to:intent.to.toLowerCase(),value:intent.value.toString(),data:'0x',nonce:intent.nonce,gasLimit:intent.gasLimit.toString(),maxFeePerGas:intent.maxFeePerGas.toString(),maxPriorityFeePerGas:intent.maxPriorityFeePerGas.toString(),runId:intent.runId,policyRef:intent.policyRef,evidenceRef:intent.evidenceRef};
}
export function fundingIntentFromWire(value:FundingWireIntent):TransactionIntent{
 if(!exact(value,['chainId','from','to','value','data','nonce','gasLimit','maxFeePerGas','maxPriorityFeePerGas','runId','policyRef','evidenceRef'])||![1,8453,4663].includes(value.chainId)||!/^0x[a-f0-9]{40}$/.test(value.from)||!/^0x[a-f0-9]{40}$/.test(value.to)||value.data!=='0x'||!Number.isSafeInteger(value.nonce)||value.nonce<0||![value.value,value.gasLimit,value.maxFeePerGas,value.maxPriorityFeePerGas].every(entry=>typeof entry==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(entry))||![value.runId,value.policyRef,value.evidenceRef].every(entry=>typeof entry==='string'&&REF.test(entry)))throw new Error('NATIVE_FUNDING_IPC_INTENT_INVALID');
 return {chainId:value.chainId,from:value.from as `0x${string}`,to:value.to as `0x${string}`,value:BigInt(value.value),data:'0x',nonce:value.nonce,gasLimit:BigInt(value.gasLimit),maxFeePerGas:BigInt(value.maxFeePerGas),maxPriorityFeePerGas:BigInt(value.maxPriorityFeePerGas),accessList:[],runId:value.runId,policyRef:value.policyRef,evidenceRef:value.evidenceRef};
}
export function createFundingAdmission(options:{challenge:string;intent:TransactionIntent;requestId:string;parentHoldId:string;parentHoldDigest:string;requestDigest:string;recordDigest:string;key:string;now?:Date}):FundingAdmission{
 const now=options.now??new Date();const intent=fundingWireIntent(options.intent);fundingIntentFromWire(intent);
 const payload:FundingAdmissionPayload={version:1,challenge:options.challenge,requestId:options.requestId,parentHoldId:options.parentHoldId,parentHoldDigest:options.parentHoldDigest,requestDigest:options.requestDigest,recordDigest:options.recordDigest,intentDigest:digest(intent),issuedAt:now.toISOString(),expiresAt:new Date(+now+20000).toISOString()};
 const key=createPrivateKey(options.key);if(key.asymmetricKeyType!=='ed25519')throw new Error('NATIVE_FUNDING_ADMISSION_KEY_INVALID');return {payload,signature:sign(null,Buffer.from(DOMAIN+JSON.stringify(payload)),key).toString('base64'),intent};
}
export function verifyFundingAdmission(value:FundingAdmission,challenge:string,publicKey:string,now=new Date()):TransactionIntent{
 try{if(!exact(value,['payload','signature','intent'])||!exact(value.payload,['version','challenge','requestId','parentHoldId','parentHoldDigest','requestDigest','recordDigest','intentDigest','issuedAt','expiresAt']))throw new Error();const p=value.payload;
 const at=Date.parse(p.issuedAt),expires=Date.parse(p.expiresAt);const key=createPublicKey(publicKey);
 if(p.version!==1||!CHALLENGE.test(challenge)||p.challenge!==challenge||![p.requestId,p.parentHoldId].every(entry=>REF.test(entry))||![p.parentHoldDigest,p.requestDigest,p.recordDigest,p.intentDigest].every(entry=>HASH.test(entry))||![at,expires,+now].every(Number.isFinite)||at>+now||expires<=+now||expires-at!==20000||key.asymmetricKeyType!=='ed25519'||typeof value.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(value.signature)||p.intentDigest!==digest(value.intent)||!verify(null,Buffer.from(DOMAIN+JSON.stringify(p)),key,Buffer.from(value.signature,'base64')))throw new Error();
 const intent=fundingIntentFromWire(value.intent);if(intent.runId!==p.parentHoldId||intent.evidenceRef!==p.parentHoldDigest)throw new Error();return intent;
 }catch{throw new Error('NATIVE_FUNDING_ADMISSION_INVALID');}
}
export async function startFundingIpcServer(options:{path:string;brokerPublicKey:string;workerUid:number;socketGid?:number;sign(request:FundingAdmission,intent:TransactionIntent,assertPermit:()=>void):Promise<Hex>;now?:()=>Date}):Promise<{stop():Promise<void>;server:Server}>{
 if(!isAbsolute(options.path))throw new Error('NATIVE_FUNDING_SOCKET_PATH_INVALID');const directory=await lstat(dirname(options.path));if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o007)!==0||(directory.mode&0o020)!==0||![0,options.workerUid].includes(directory.uid))throw new Error('NATIVE_FUNDING_SOCKET_DIRECTORY_INVALID');
 // Never replace a pre-existing filesystem entry, including another live worker.
 try{await lstat(options.path);throw new Error('NATIVE_FUNDING_SOCKET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 let active=0;const sockets=new Set<import('node:net').Socket>();const now=options.now??(()=>new Date());
 const server=createServer(socket=>{if(active>=4){socket.destroy();return;}active++;sockets.add(socket);socket.setTimeout(20000,()=>socket.destroy());socket.once('close',()=>{active--;sockets.delete(socket);});socket.on('error',()=>socket.destroy());const challenge=randomBytes(32).toString('hex');socket.write(JSON.stringify({version:1,challenge})+'\n');let buffer='';let consumed=false;
 socket.on('data',chunk=>{if(consumed){socket.destroy();return;}buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>FUNDING_IPC_MAX_BYTES){socket.destroy();return;}const end=buffer.indexOf('\n');if(end<0)return;consumed=true;if(buffer.slice(end+1).length){socket.destroy();return;}
 void(async()=>{try{const request=JSON.parse(buffer.slice(0,end)) as FundingAdmission;const assertPermit=()=>{verifyFundingAdmission(request,challenge,options.brokerPublicKey,now());};const intent=verifyFundingAdmission(request,challenge,options.brokerPublicKey,now());buffer='';const raw=await options.sign(request,intent,assertPermit);assertPermit();if(!/^0x[0-9a-f]{2,8192}$/i.test(raw))throw new Error();socket.end(JSON.stringify({ok:true,raw})+'\n');}catch{socket.end(JSON.stringify({ok:false,code:'NATIVE_FUNDING_WORKER_REFUSED'})+'\n');}})();
 });});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.path,()=>{server.removeListener('error',reject);resolve();});});await chmod(options.path,0o660);
 if(options.socketGid!==undefined){const {chown}=await import('node:fs/promises');await chown(options.path,options.workerUid,options.socketGid);}
 return {server,async stop(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));try{await unlink(options.path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}};
}
export async function requestFundingSignature(options:{path:string;workerUid:number;permit(challenge:string):Promise<FundingAdmission>}):Promise<Hex>{
 const metadata=await lstat(options.path);if(!metadata.isSocket()||metadata.isSymbolicLink()||metadata.uid!==options.workerUid||(metadata.mode&0o777)!==0o660)throw new Error('NATIVE_FUNDING_SOCKET_PERMISSIONS_INVALID');
 return new Promise((resolve,reject)=>{const socket=createConnection(options.path);let buffer='';let phase:'challenge'|'result'='challenge';let done=false;const fail=()=>{if(done)return;done=true;socket.destroy();reject(new Error('NATIVE_FUNDING_IPC_UNAVAILABLE'));};socket.setTimeout(20000,fail);socket.on('error',fail);socket.on('close',()=>{if(!done)fail();});socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>FUNDING_IPC_MAX_BYTES){fail();return;}const end=buffer.indexOf('\n');if(end<0)return;const text=buffer.slice(0,end);buffer=buffer.slice(end+1);if(buffer.length){fail();return;}void(async()=>{try{const value=JSON.parse(text) as {version?:number;challenge?:string;ok?:boolean;raw?:string};if(phase==='challenge'){if(value.version!==1||!value.challenge||!CHALLENGE.test(value.challenge))throw new Error();phase='result';const permit=await options.permit(value.challenge);if(done)return;const message=JSON.stringify(permit)+'\n';if(Buffer.byteLength(message)>FUNDING_IPC_MAX_BYTES)throw new Error();socket.write(message);}else{if(value.ok!==true||typeof value.raw!=='string'||!/^0x[0-9a-f]{2,8192}$/i.test(value.raw))throw new Error();done=true;socket.destroy();resolve(value.raw as Hex);}}catch{fail();}})();});});
}
