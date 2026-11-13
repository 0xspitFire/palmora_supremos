/** Test tooling only. Fixed local Anvil with zero managed accounts; no credentials or external RPC. */
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setDefaultResultOrder,getDefaultResultOrder} from 'node:dns';
import {createPublicClient,http,type Abi,type Hex,type PublicClient} from 'viem';
export interface ReviewedProtocolLocalChain {directory:string;compilerVersion:string;endpoints:readonly [string,string];clients:readonly [PublicClient,PublicClient];collection:{abi:Abi;bytecode:{object:Hex};deployedBytecode:{object:Hex}};factory:{abi:Abi;bytecode:{object:Hex};deployedBytecode:{object:Hex}};close():Promise<void>;}
export async function startReviewedProtocolLocalChain():Promise<ReviewedProtocolLocalChain>{
 const directory=await mkdtemp(join(tmpdir(),'mintbot-reviewed-local-'));const fixture=resolve('ops/fixtures/reviewed-erc721');
 const compiler=join(homedir(),'.local/share/svm/0.8.36/solc-0.8.36');
 let compilerVersion:string;let artifacts:{abi:Abi;bytecode:{object:Hex};deployedBytecode:{object:Hex}}[];
 try {
  compilerVersion=execFileSync(compiler,['--version'],{encoding:'utf8',timeout:10000});if(!compilerVersion.includes('0.8.36+commit.8a079791'))throw new Error('LOCAL_REHEARSAL_PINNED_COMPILER_REQUIRED');
  execFileSync('forge',['build','--threads','1','--root',fixture,'--use',compiler,'--offline','--out',join(directory,'out'),'--cache-path',join(directory,'cache')],{encoding:'utf8',timeout:30000,stdio:'pipe'});
  artifacts=await Promise.all(['ReviewedFreeMint','ReviewedFreeMintFactory'].map(async name=>JSON.parse(await readFile(join(directory,'out','ReviewedFreeMint.sol',`${name}.json`),'utf8')) as {abi:Abi;bytecode:{object:Hex};deployedBytecode:{object:Hex}}));
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}

 const server=createServer();await new Promise<void>((resolveReady,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveReady);});const address=server.address();if(!address||typeof address==='string')throw new Error('LOCAL_REHEARSAL_PORT_REQUIRED');const port=address.port;await new Promise<void>((resolveClosed,reject)=>server.close(error=>error?reject(error):resolveClosed()));
 const oldOrder=getDefaultResultOrder();setDefaultResultOrder('ipv4first');
 const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','1','--accounts','0','--base-fee','1000000','--block-time','1','--hardfork','cancun','--silent'],{stdio:'ignore'});
 let startupError:unknown;child.once('error',error=>{startupError=error;});
 const endpoints=[`http://127.0.0.1:${port}`,`http://localhost:${port}`] as const;
 const clients=endpoints.map(endpoint=>createPublicClient({cacheTime:0,transport:http(endpoint,{timeout:2000,retryCount:0})})) as unknown as [PublicClient,PublicClient];
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;setDefaultResultOrder(oldOrder);if(child.exitCode===null){const stopped=new Promise<void>(resolveStopped=>child.once('exit',()=>resolveStopped()));child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([stopped,new Promise<void>(resolveStopped=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolveStopped();},3000);})]);if(timer)clearTimeout(timer);}await rm(directory,{recursive:true,force:true});};
 try{let ready=false;for(let i=0;i<30;i++){if(startupError||child.exitCode!==null)throw new Error('LOCAL_REHEARSAL_ANVIL_START_FAILED');try{if(await clients[0].getChainId()===1){ready=true;break;}}catch{/* local startup */}await new Promise(resolveWait=>setTimeout(resolveWait,100));}if(!ready)throw new Error('LOCAL_REHEARSAL_ANVIL_UNAVAILABLE');return {directory,compilerVersion:compilerVersion.trim(),endpoints,clients,collection:artifacts[0]!,factory:artifacts[1]!,close};}catch(error){await close();throw error;}
}
