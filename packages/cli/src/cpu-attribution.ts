import { Session, type Profiler } from 'node:inspector';
const MAX_ROWS = 100_000;
const AREAS = new Map([
 ['canonical-store.js','canonical_store'], ['read-model-v1.js','read_models'],
 ['alerts.js','alerts'], ['discovery.js','discovery'], ['readiness.js','readiness'],
 ['rpc-transport.js','rpc_transport'], ['orchestrator.js','orchestrator'],
]);
/** CPU metadata only. No URL, function name, source text, stack or raw profile leaves this boundary. */
export function summarizeCpuProfile(profile: Profiler.Profile) {
 const categories = new Map<number,string>();
 for (const node of profile.nodes.slice(0, MAX_ROWS)) {
  const frame = node.callFrame;
  const area = frame.functionName === '(garbage collector)' ? 'garbage_collection'
   : frame.url.startsWith('node:') ? 'node_internal'
   : AREAS.get(frame.url.split('/').at(-1) ?? '') ?? 'other';
  categories.set(node.id,area);
 }
 const counts: Record<string,number> = {};
 const samples = (profile.samples ?? []).slice(0,MAX_ROWS);
 for (const id of samples) { const area=categories.get(id)??'other';counts[area]=(counts[area]??0)+1; }
 return { event:'discovery_cpu_sample', samples:samples.length, truncated:profile.nodes.length>MAX_ROWS || (profile.samples?.length??0)>MAX_ROWS, areas:counts };
}
let attempted = false;
/** Opt-in one-shot local session; connect() opens no TCP debugger listener. */
export async function sampleCpuAreas(): Promise<ReturnType<typeof summarizeCpuProfile> & { elapsedMs: number }> {
 if(attempted)throw new Error('CPU_SAMPLE_ALREADY_ATTEMPTED');
 attempted=true;
 const session=new Session();
 const post=<T>(method:string,params?:Record<string,unknown>)=>new Promise<T>((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(new Error('CPU_SAMPLE_UNAVAILABLE')):resolve(result as T)));
 try {
  session.connect();
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval',{interval:10_000});
  await post('Profiler.start');
  const started = performance.now();
  await new Promise<void>(resolve=>{const timer=setTimeout(resolve,10_000);timer.unref();});
  const result=await post<{profile:Profiler.Profile}>('Profiler.stop');
  return { ...summarizeCpuProfile(result.profile), elapsedMs: Math.round(performance.now() - started) };
 } catch { throw new Error('CPU_SAMPLE_UNAVAILABLE'); }
 finally { try { session.disconnect(); } catch { /* Never expose inspector errors. */ } }
}
