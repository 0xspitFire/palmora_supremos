import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({commands:[] as string[],connects:0,disconnects:0,fail:false}));
vi.mock('node:inspector',()=>({Session:class {
 connect(){state.connects++;}
 disconnect(){state.disconnects++;}
 post(method:string,_params:unknown,callback:(error:Error|null,result:unknown)=>void){state.commands.push(method);callback(state.fail?new Error('private-runtime-detail'):null,method==='Profiler.stop'?{profile:{nodes:[{id:1,callFrame:{functionName:'private-frame',url:'file:///opt/mint-bot/current/packages/backend/dist/canonical-store.js'}}],samples:[1],startTime:0,endTime:1}}:{});}
}}));
afterEach(()=>vi.useRealTimers());
it('uses only fixed local Profiler commands, emits aggregate metadata and attempts once',async()=>{
 vi.useFakeTimers();vi.resetModules();state.commands=[];state.connects=0;state.disconnects=0;state.fail=false;
 const {sampleCpuAreas}=await import('./cpu-attribution.js');const result=sampleCpuAreas();await vi.advanceTimersByTimeAsync(10000);
 expect(await result).toMatchObject({event:'discovery_cpu_sample',samples:1,areas:{canonical_store:1},elapsedMs:expect.any(Number)});
 expect(state.commands).toEqual(['Profiler.enable','Profiler.setSamplingInterval','Profiler.start','Profiler.stop']);expect(state.connects).toBe(1);expect(state.disconnects).toBe(1);
 await expect(sampleCpuAreas()).rejects.toThrow('CPU_SAMPLE_ALREADY_ATTEMPTED');
});
it('disconnects and returns only a fixed error when inspector setup fails',async()=>{
 vi.resetModules();state.fail=true;state.disconnects=0;const {sampleCpuAreas}=await import('./cpu-attribution.js');
 await expect(sampleCpuAreas()).rejects.toThrow('CPU_SAMPLE_UNAVAILABLE');expect(state.disconnects).toBe(1);state.fail=false;
});
