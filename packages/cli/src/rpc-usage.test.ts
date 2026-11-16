import { expect, it } from 'vitest';
import { rpcUsageReporter } from './rpc-usage.js';
it('aggregates fixed fields per chain/window and never spreads caller metadata', () => {
 let now=0; const rows: Record<string,unknown>[]=[]; const report=rpcUsageReporter(1,row=>rows.push(row),()=>now);
 const value={endpointIndex:0,method:'eth_getLogs' as const,outcome:'rate_limited' as const,durationMs:12,privateMetadata:'synthetic-only'};
 report(value);report(value);expect(rows).toHaveLength(0);now=60000;report(value);
 expect(rows).toEqual([{event:'intelligence_rpc_usage',chainId:1,windowMs:60000,endpointIndex:0,method:'eth_getLogs',outcome:'rate_limited',count:2,totalDurationMs:24,maxDurationMs:12}]);
 expect(JSON.stringify(rows)).not.toContain('synthetic-only');
});
it('rejects invalid endpoint or duration and tolerates logging failure', () => {
 let now=0;let calls=0;const report=rpcUsageReporter(8453,()=>{calls++;throw new Error('log down');},()=>now);
 const row={endpointIndex:0,method:'eth_call' as const,outcome:'timeout' as const,durationMs:10};
 report({...row,endpointIndex:32});report({...row,durationMs:NaN});now=60000;report(row);expect(calls).toBe(0);now=120000;expect(()=>report(row)).not.toThrow();expect(calls).toBe(1);
});
