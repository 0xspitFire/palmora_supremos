import { expect, it } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
import { describeAnalytics } from './analytics-report.js';
it('keeps an empty retained history explicitly unknown rather than inventing a profit or permitting execution', async () => {
  const store = new DurableStore(); await store.open();
  const before = store.snapshot();
  const text = describeAnalytics(before, new Date('2026-11-13T00:00:00Z'));
  expect(text).toContain('shadow only'); expect(text).toContain('Realized PnL: unknown');
  expect(text).toContain('Unrealized PnL: unknown'); expect(text).toContain('does not change live scores or authorize minting');
  expect(store.snapshot()).toEqual(before);
});

it('merges verified external mint/sale observations while excluding watched-wallet profit from personal totals',async()=>{
 const {ingestExternalAnalytics}=await import('@mint-bot/backend');const store=new DurableStore();const now=new Date('2026-11-13T12:00:00Z');
 const own=`0x${'1'.repeat(40)}`,whale=`0x${'2'.repeat(40)}`,buyer=`0x${'3'.repeat(40)}`,collection=`0x${'4'.repeat(40)}`,zero=`0x${'0'.repeat(40)}`;
 await store.transaction(state=>state.events.push({id:'scope',type:'analytics_wallet_scope',at:now.toISOString(),data:{revision:1,wallets:[{chainId:1,address:own}]}}));
 const hashes=['a','b','c','d'].map(letter=>`0x${letter.repeat(64)}`);
 await ingestExternalAnalytics({store,now:()=>now,startAtUnix:0,maxTransactions:4,maxWalletsPerTick:2,wallets:async()=>[{chainId:1,address:own},{chainId:1,address:whale}],candidatePort:{page:async()=>({candidates:hashes.map(transactionHash=>({transactionHash})),coverage:'partial',code:'INDEX_PARTIAL'})},chainPort:async()=>({observe:async hash=>{
 const index=hashes.indexOf(hash),mint=index<2,actor=index%2===0?own:whale;return {chainId:1,transactionHash:hash,blockHash:`0x${'e'.repeat(64)}`,blockNumber:String(100+index),transactionIndex:0,at:new Date(+now-(4-index)*60000).toISOString(),from:mint?actor:buyer,valueWei:'0',finality:'finalized',readerIdentities:['first.example','second.example'],transactionFeeWei:'1000000000000000',transfers:[{collection,tokenId:actor===own?'1':'2',quantity:'1',from:mint?zero:actor,to:mint?actor:buyer,logIndex:0}],settlements:mint?[]:[{protocol:'seaport-single-nft-v1',transferLogIndex:0,seller:actor,buyer,currency:'ETH',grossWei:actor===own?'10000000000000000':'1000000000000000000',feesWei:'1000000000000000'}],...(mint?{mintCost:{protocol:'seadrop-direct-v1',method:'mintPublic',collection,minter:actor,quantity:'1',totalValueWei:'0',transferLogIndices:[0]}}:{}),issues:[]};}})});
 const text=describeAnalytics(store.snapshot(),now);expect(text).toContain('Realized PnL: 0.008 ETH');expect(text).not.toContain('0.998 ETH');
});
