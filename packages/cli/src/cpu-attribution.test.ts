import { expect,it } from 'vitest';
import type { Profiler } from 'node:inspector';
import { summarizeCpuProfile } from './cpu-attribution.js';
function profile(url:string):Profiler.Profile { return {startTime:0,endTime:1,nodes:[{id:1,callFrame:{functionName:'private-value',scriptId:'1',url,lineNumber:0,columnNumber:0}}],samples:[1,1,999],timeDeltas:[1,1,1]}; }
it('emits only fixed area categories and counters, never frame metadata',()=>{
 const p=profile('file:///opt/mint-bot/current/packages/backend/dist/canonical-store.js');
 expect(summarizeCpuProfile(p)).toEqual({event:'discovery_cpu_sample',samples:3,truncated:false,areas:{canonical_store:2,other:1}});
 const rendered=JSON.stringify(summarizeCpuProfile(profile('https://private.invalid/credential')));
 expect(rendered).not.toContain('private');expect(rendered).not.toContain('credential');
});
it('caps processing and marks truncated samples honestly',()=>{
 const p=profile('node:internal/test');p.samples=Array(100001).fill(1);
 const r=summarizeCpuProfile(p);expect(r.samples).toBe(100000);expect(r.truncated).toBe(true);expect(r.areas).toEqual({node_internal:100000});
});
