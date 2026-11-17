import { afterEach, expect, it, vi } from 'vitest';
import { createPublicClient } from 'viem';
import { alchemyFreeRequestSupported, isAlchemyRpcEndpoint } from './alchemy-free-logs.js';
import { failoverTransport } from './rpc-transport.js';
afterEach(()=>vi.unstubAllGlobals());
const body=(fromBlock:string,toBlock:string)=>JSON.stringify({method:'eth_getLogs',params:[{fromBlock,toBlock}]});
it('recognizes only exact Alchemy HTTPS RPC suffix and validates inclusive ten-block ranges',()=>{
 expect(isAlchemyRpcEndpoint('https://eth-mainnet.g.alchemy.com/v2/synthetic')).toBe(true);
 for(const url of ['https://eth-mainnet.g.alchemy.com.attacker.invalid','http://eth-mainnet.g.alchemy.com','https://attacker.invalid/g.alchemy.com'])expect(isAlchemyRpcEndpoint(url)).toBe(false);
 expect(alchemyFreeRequestSupported(body('0x1','0xa'))).toBe(true);
 for(const value of [body('0x1','0xb'),body('0xa','0x1'),body('latest','latest'),'x'.repeat(131073),'[]'])expect(alchemyFreeRequestSupported(value)).toBe(false);
 expect(alchemyFreeRequestSupported(JSON.stringify({method:'eth_getBalance',params:[]}))).toBe(true);
});
it('does not send oversized logs to Alchemy and preserves the exact filter on fallback',async()=>{
 const calls:Array<{url:string;body:string}>=[];
 vi.stubGlobal('fetch',vi.fn(async(input:unknown,init:RequestInit)=>{const raw=String(init.body);calls.push({url:String(input),body:raw});const request=JSON.parse(raw);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:[]}),{headers:{'content-type':'application/json'}});}));
 const client=createPublicClient({transport:failoverTransport(['https://eth-mainnet.g.alchemy.com/v2/synthetic','https://fallback.example.invalid'],{signal:new AbortController().signal,completeResponseTimeoutMs:1000,alchemyFreeTier:true})});
 const filter: {fromBlock:'0x1';toBlock:'0x64';topics:`0x${string}`[]}={fromBlock:'0x1',toBlock:'0x64',topics:['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']};
 await client.request({method:'eth_getLogs',params:[filter]});
 expect(calls).toHaveLength(1);expect(calls[0]?.url).toBe('https://fallback.example.invalid/');expect(JSON.parse(calls[0]!.body).params).toEqual([filter]);
});
it('allows a ten-block query, fails closed with only incompatible endpoints and preserves cancellation',async()=>{
 const fetcher=vi.fn(async(_input:unknown,init:RequestInit)=>{const r=JSON.parse(String(init.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result:[]}),{headers:{'content-type':'application/json'}});});vi.stubGlobal('fetch',fetcher);
 const controller=new AbortController();const client=createPublicClient({transport:failoverTransport(['https://eth-mainnet.g.alchemy.com/v2/synthetic'],{signal:controller.signal,completeResponseTimeoutMs:1000,alchemyFreeTier:true})});
 await client.request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0xa'}]});expect(fetcher).toHaveBeenCalledTimes(1);
 await expect(client.request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0xb'}]})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 controller.abort();await expect(client.request({method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0xa'}]})).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 expect(()=>failoverTransport(['https://x.invalid'],{alchemyFreeTier:true})).toThrow('RPC_FREE_TIER_REQUIRES_SCOPED_READ');
});
