import type { IntelligenceChainPort } from '@mint-bot/backend';
export interface IntelligenceReadState {chainId:number;operation:string;state:'started'|'completed'|'timed_out'|'capacity';elapsedMs:number;pending:number;}
/** Cancels only external READS. Timed-out work retains its single-flight slot
 * until it settles, so a reader ignoring abort cannot create overlapping retries
 * or publish late values into the discovery writer. */
export function boundedIntelligencePort(port:IntelligenceChainPort,options:{timeoutMs?:number;maxPending?:number;report?:(state:IntelligenceReadState)=>void}={}){
 const timeout=options.timeoutMs??15000,maxPending=options.maxPending??32;
 if(!Number.isSafeInteger(timeout)||timeout<1||!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>100)throw new Error('INTELLIGENCE_READ_BOUNDS_INVALID');
 const pending=new Map<string,{promise:Promise<unknown>;controller:AbortController;expired:boolean;startedAt:number;deadlineAt:number}>();let stopped=false;
 const log=(operation:string,state:IntelligenceReadState['state'],started:number)=>{try{options.report?.({chainId:port.chainId,operation,state,elapsedMs:Date.now()-started,pending:pending.size});}catch{/* Diagnostics never change the read outcome. */}};
 const run=async<T>(operation:string,args:readonly unknown[],fallback:T,work:(reader:IntelligenceChainPort)=>Promise<T>):Promise<T>=>{
  if(stopped)return fallback;
  const key=JSON.stringify([operation,args],(_k,v:unknown)=>typeof v==='bigint'?v.toString():v);let job=pending.get(key);
  if(job?.expired)return fallback;
  if(!job){if(pending.size>=maxPending){log(operation,'capacity',Date.now());return fallback;}
   const controller=new AbortController();const started=Date.now();const scoped=(port as IntelligenceChainPort&{withReadSignal?:(signal:AbortSignal)=>IntelligenceChainPort}).withReadSignal?.(controller.signal)??port;
   const promise=Promise.resolve().then(()=>work(scoped));job={promise,controller,expired:false,startedAt:started,deadlineAt:started+timeout};pending.set(key,job);log(operation,'started',started);
   const owned=job;void promise.finally(()=>{if(pending.get(key)===owned)pending.delete(key);log(operation,'completed',started);}).catch(()=>undefined);
  }
  const owned=job;let timer:ReturnType<typeof setTimeout>|undefined;
  try{const value=await Promise.race([owned.promise as Promise<T>,new Promise<T>(resolve=>{timer=setTimeout(()=>{owned.expired=true;owned.controller.abort();log(operation,'timed_out',Date.now()-timeout);resolve(fallback);},Math.max(0,owned.deadlineAt-Date.now()));timer.unref?.();})]);if(stopped||owned.expired||Date.now()<owned.startedAt||Date.now()>=owned.deadlineAt){owned.expired=true;owned.controller.abort();return fallback;}return value;}
  catch{if(owned.expired||stopped)return fallback;throw new Error('INTELLIGENCE_READ_FAILED');}finally{if(timer)clearTimeout(timer);}
 };
 const bounded:IntelligenceChainPort={chainId:port.chainId,safeHead:()=>run('safe_head',[],null,p=>p.safeHead()),scan:(from,to,watched)=>run('scan',[from,to,watched],{ok:false,reason:'READ_DEADLINE_EXCEEDED'},p=>p.scan(from,to,watched)),hasCode:address=>run('code',[address],null,p=>p.hasCode(address)),readDrop:contract=>run('drop_metadata',[contract],null,p=>p.readDrop(contract)),balance:address=>run('balance',[address],null,p=>p.balance(address)),simulateMint:(wallet,contract,quantity,value)=>run('advisory_simulation',[wallet,contract,quantity,value],{outcome:'unknown',reason:'READ_DEADLINE_EXCEEDED'},p=>p.simulateMint(wallet,contract,quantity,value)),...(port.readName?{readName:(contract:string)=>run('collection_name',[contract],{status:'error'},p=>p.readName!(contract))}:{}),...(port.estimateMintGas?{estimateMintGas:(wallet:string,contract:string,quantity:number,value:bigint)=>run('advisory_estimate',[wallet,contract,quantity,value],null,p=>p.estimateMintGas!(wallet,contract,quantity,value))}:{}),...(port.baseFeePerGasWei?{baseFeePerGasWei:()=>run('base_fee',[],null,p=>p.baseFeePerGasWei!())}:{})};
 return {port:bounded,pending:()=>pending.size,stop:()=>{stopped=true;for(const job of pending.values()){job.expired=true;job.controller.abort();}}};
}
