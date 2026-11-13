import { describe, expect, it, vi } from 'vitest';
import { createAdvancedIntelligenceProvider } from './advanced-intelligence.js';
import { createSourcifyIntelligenceReaders, type SourcifyRpcClient } from './advanced-intelligence-sourcify.js';
const NOW = new Date('2026-11-13T12:00:00Z');
const contract = `0x${'1'.repeat(40)}`;
const context = { chainId: 1 as const, contract, watchedWallets: [], now: NOW };
const fact = (value: boolean) => ({ chainId: 1 as const, contract, observedAt: NOW.toISOString(), expiresAt: new Date(+NOW+60_000).toISOString(), sourceReference: 'verified-common-block', value });
const hash = `0x${'a'.repeat(64)}`;
function client(overrides: Partial<SourcifyRpcClient> = {}): SourcifyRpcClient {
 return { getChainId: async()=>1,getBlockNumber:async()=>100n,getCode:async()=> '0x1234',getBlock:async()=>({hash,timestamp:BigInt(+NOW/1000-20)}),getTransaction:async()=>({hash,to:null,blockNumber:98n,blockHash:hash}),getTransactionReceipt:async()=>({transactionHash:hash,status:'success',contractAddress:contract,blockNumber:98n,blockHash:hash}), ...overrides };
}
const record = {chainId:'1',address:contract,runtimeMatch:'exact_match',runtimeBytecode:{onchainBytecode:'0x1234'},deployment:{transactionHash:hash}};
const response = (value: unknown) => ({ok:true,status:200,text:async()=>JSON.stringify(value)});
describe('bounded advanced intelligence sources',()=>{
 it('keeps discovery request and snapshot network-free; refreshes separately and preserves conflict as unknown',async()=>{
 const read=vi.fn(async()=>fact(true));
 const provider=createAdvancedIntelligenceProvider({now:()=>NOW,readers:[{trustedOrigin:'approved-rpc',sourceVerified:read}]});
 provider.request(context); expect(read).not.toHaveBeenCalled();expect(provider.snapshot(context)).toBeUndefined();
 await provider.tick();expect(read).toHaveBeenCalledOnce();expect(provider.snapshot(context)?.sourceVerified?.value).toBe(true);
 provider.request(context);await provider.tick();expect(read).toHaveBeenCalledOnce();await provider.stop();
 const conflicting=createAdvancedIntelligenceProvider({now:()=>NOW,readers:[{trustedOrigin:'approved-rpc',sourceVerified:async()=>fact(true)},{trustedOrigin:'approved-rpc',sourceVerified:async()=>fact(false)},{trustedOrigin:'approved-rpc',sourceVerified:async()=>fact(true)}]});
 conflicting.request(context);await conflicting.tick();expect(conflicting.snapshot(context)?.sourceVerified).toBeUndefined();await conflicting.stop();
 });
 it('does not publish late timeout results and enforces RPC budgets',async()=>{
 const provider=createAdvancedIntelligenceProvider({now:()=>NOW,timeoutMs:50,rpcBudget:1,readers:[{trustedOrigin:'approved-rpc',sourceVerified:async c=>{c.consumeRpc(2);return fact(true);}}]});
 provider.request(context);await provider.tick();expect(provider.snapshot(context)?.sourceVerified).toBeUndefined();await provider.stop();
 const late=createAdvancedIntelligenceProvider({now:()=>NOW,timeoutMs:50,readers:[{trustedOrigin:'approved-rpc',sourceVerified:async()=>{await new Promise(r=>setTimeout(r,70));return fact(true);}}]});late.request(context);await late.tick();await new Promise(r=>setTimeout(r,30));expect(late.snapshot(context)).toBeUndefined();await late.stop();
 });
 it('verifies exact Sourcify identity, common-block bytecode, and actual direct creation',async()=>{
 const fetcher=vi.fn(async(_url: string)=>response(record));let calls=0;
 const readers=createSourcifyIntelligenceReaders({clients:async()=>[client(),client()],fetcher});
 const ctx={...context,signal:new AbortController().signal,consumeRpc:(n=1)=>{calls+=n;}};
 expect((await readers.sourceVerified!(ctx))?.value).toBe(true);
 expect((await readers.contractCreatedAt!(ctx))?.value).toBe(new Date(+NOW-20_000).toISOString());
 expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0]?.[0]).toMatch(/^https:\/\/sourcify.dev\/server\/v2\/contract\/1\//);expect(calls).toBe(16);
 });
 it.each(['wrong-chain','wrong-address','metadata-only-match','code-disagreement','block-disagreement','stale-block','factory-creation'] as const)('keeps %s unknown',async kind=>{
 const data=structuredClone(record);let second=client();
 if(kind==='wrong-chain')data.chainId='8453';if(kind==='wrong-address')data.address=`0x${'2'.repeat(40)}`;if(kind==='metadata-only-match')data.runtimeMatch='match';
 if(kind==='code-disagreement')second=client({getCode:async()=> '0x5678'});
 if(kind==='block-disagreement')second=client({getBlock:async()=>({hash:`0x${'b'.repeat(64)}`,timestamp:BigInt(+NOW/1000-20)})});
 if(kind==='stale-block')second=client({getBlock:async()=>({hash,timestamp:1n})});
 if(kind==='factory-creation')second=client({getTransaction:async()=>({hash,to:contract,blockNumber:98n,blockHash:hash})});
 const readers=createSourcifyIntelligenceReaders({clients:async()=>[client(),second],fetcher:async()=>response(data)});
 const ctx={...context,signal:new AbortController().signal,consumeRpc:()=>{}};
 if(kind==='factory-creation')expect(await readers.contractCreatedAt!(ctx)).toBeUndefined();else expect(await readers.sourceVerified!(ctx)).toBeUndefined();
 });
});
