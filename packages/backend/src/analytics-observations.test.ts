import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';
import { ingestExternalAnalytics, type ExternalTransactionEvidence } from './external-analytics.js';
import { measuredAnalyticsOutcomes, personalAnalyticsActivities, readAnalyticsWalletScope, readAnalyticsFloorQuotes } from './analytics-observations.js';
import type { AnalyticsActivity } from './analytics.js';
import type { EventRecord } from './types.js';
const wallet=`0x${'1'.repeat(40)}`,other=`0x${'2'.repeat(40)}`,collection=`0x${'3'.repeat(40)}`;
const purchase=`0x${'a'.repeat(64)}`,sale=`0x${'b'.repeat(64)}`,block=`0x${'c'.repeat(64)}`;
const now=new Date('2026-11-13T12:00:00Z');
function evidence(hash:string,cost='100'):ExternalTransactionEvidence{const sold=hash===sale;return {chainId:1,transactionHash:hash,blockHash:block,blockNumber:sold?'11':'10',transactionIndex:0,at:`2026-11-13T${sold?'11':'10'}:00:00.000Z`,from:wallet,valueWei:sold?'0':cost,transactionFeeWei:'10',finality:'finalized',readerIdentities:['one.example','two.example'],transfers:[{collection,tokenId:'42',quantity:'1',from:sold?wallet:other,to:sold?other:wallet,logIndex:1}],settlements:[{protocol:'seaport-single-nft-v1',transferLogIndex:1,seller:sold?wallet:other,buyer:sold?other:wallet,currency:'ETH',grossWei:sold?'200':cost,feesWei:'10'}],issues:[]};}
describe('shared observed analytics',()=>{
 it('costs actual retained acquisitions and sales; changed verified costs change model lineage',async()=>{
 const store=new DurableStore();await store.open();let cost='100';
 const options={store,wallets:async()=>[{chainId:1 as const,address:wallet}],candidatePort:{page:async()=>({candidates:[{transactionHash:purchase},{transactionHash:sale}],coverage:'partial' as const,code:'INDEX_PARTIAL'})},chainPort:async()=>({observe:async(hash:string)=>evidence(hash,cost)}),now:()=>now};
 await ingestExternalAnalytics(options);const before=measuredAnalyticsOutcomes(store.snapshot().events,now);expect(before).toHaveLength(1);expect(before[0]).toMatchObject({costBasisWei:'110',grossProceedsWei:'200',dispositionFeesWei:'20',realizedPnlWei:'70',synthetic:false});
 cost='120';await ingestExternalAnalytics(options);const after=measuredAnalyticsOutcomes(store.snapshot().events,now);expect(after[0]?.realizedPnlWei).toBe('50');expect(after[0]?.sourceReference).not.toBe(before[0]?.sourceReference);
 });
 it('excludes watched holdings from personal accounting and never invents incoming transfer basis',()=>{
 const row={id:'fact-one',sourceReference:'fact:one',kind:'transfer',chainId:1,collection,tokenId:'42',quantity:'1',wallet:other,toWallet:wallet,gasWei:'10'} as AnalyticsActivity;
 expect(personalAnalyticsActivities([row],[{chainId:1,address:wallet}])).toMatchObject([{kind:'acquisition',wallet,costWei:null,gasWei:'0'}]);
 expect(personalAnalyticsActivities([row],[{chainId:8453,address:wallet}])).toEqual([]);
 });
 it('fails closed for invalid latest personal fleet scope instead of reverting to all watched wallets',()=>{
 const rows:EventRecord[]=[{id:'scope-one',type:'analytics_wallet_scope',at:now.toISOString(),data:{revision:1,wallets:[{chainId:1,address:wallet}]}},{id:'scope-bad',type:'analytics_wallet_scope',at:now.toISOString(),data:{revision:2,wallets:[{chainId:999,address:wallet}]}}];
 expect(readAnalyticsWalletScope(rows)).toEqual([]);expect(readAnalyticsWalletScope([])).toBeUndefined();
 });
 it('preserves original floor times and contradictory prices; expired quotes are not refreshed',()=>{
 const quote={chainId:1,collection,floorWei:'150',observedAt:'2026-11-13T11:00:00Z',expiresAt:'2026-11-13T11:05:00Z',sourceReference:'opensea:floor'};
 const rows=[{id:'floor-one',type:'analytics_floor_quote',at:now.toISOString(),data:{quote}},{id:'floor-two',type:'analytics_floor_quote',at:now.toISOString(),data:{quote:{...quote,floorWei:'160'}}}];
 expect(readAnalyticsFloorQuotes(rows,now)).toHaveLength(2);expect(readAnalyticsFloorQuotes(rows,now)[0]?.expiresAt).toBe(quote.expiresAt);
 });
});
