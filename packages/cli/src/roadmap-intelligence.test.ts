import {describe,expect,it,vi} from 'vitest';
import {AlertManager,DiscoveryService,DurableStore,type IntelligenceChainPort,type IntelligenceRepositoryPort} from '@mint-bot/backend';
import {createRoadmapIntelligence,openSeaAdvancedReader} from './roadmap-intelligence.js';
import {observeRoadmapFinality} from './roadmap-intelligence-chain.js';
import type {PublicClient} from 'viem';
const now=new Date('2026-11-13T12:00:00Z');const contract=`0x${'1'.repeat(40)}`;const wallet=`0x${'2'.repeat(40)}`;const hash=`0x${'a'.repeat(64)}`;
describe('actual roadmap intelligence composition',()=>{
 it('starts bounded background observations, supplies every chain discovery, separates own scope, and stops',async()=>{
 const store=new DurableStore();const source=vi.fn(async(context:{chainId:1|8453|4663;contract:string})=>({chainId:context.chainId,contract:context.contract,observedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),sourceReference:'source-match',value:true}));
 const roadmap=createRoadmapIntelligence({store,now:()=>now,clients:async()=>{throw new Error('no network in test');},ownedWallets:async()=>[{chainId:1,address:wallet}],watchedWallets:async()=>[{chainId:1,address:`0x${'3'.repeat(40)}`}],advancedReaders:[{trustedOrigin:'approved-rpc',sourceVerified:source}]});
 for(const chainId of [1,8453,4663] as const){
 const port={chainId,safeHead:async()=>1000n,scan:async(from:bigint,to:bigint)=>({ok:true,scan:{fromBlock:from,toBlock:to,dropUpdates:[],watchedMints:[],mints:[{nftContract:contract,minter:wallet,payer:wallet,quantity:1n,unitPriceWei:0n,blockNumber:950n,txHash:hash,logIndex:0}]}}),readDrop:async()=>({nftContract:contract,priceWei:0n,startTime:+now/1000-60,endTime:+now/1000+3600,maxPerWallet:10,maxSupply:100n,totalMinted:1n}),hasCode:async()=>true,readName:async()=>({status:'none'}),balance:async()=>0n,simulateMint:async()=>({outcome:'pass'})} as IntelligenceChainPort;
 const repository={observedAddresses:()=>[{address:wallet}],cursor:()=>undefined,advanceCursor:()=>{}} as IntelligenceRepositoryPort;
 const discovery=new DiscoveryService(store,repository,port,{now:()=>now,budgetPerNftWei:1n,alerts:new AlertManager(store),advanced:roadmap.advanced,history:roadmap.history,adaptive:roadmap.adaptive});await discovery.tick();
 }
 expect(source).not.toHaveBeenCalled();roadmap.start();await roadmap.tick();await new Promise(resolve=>setTimeout(resolve,10));await roadmap.tick();expect(source).toHaveBeenCalledTimes(3);
 expect(store.snapshot().events.find(event=>event.type==='analytics_wallet_scope')?.data.wallets).toEqual([{chainId:1,address:wallet}]);expect(roadmap.adaptive.active(1,now)).toBeUndefined();
 expect(roadmap.advanced.snapshot({chainId:8453,contract,watchedWallets:[],now})?.sourceVerified?.value).toBe(true);
 await roadmap.stop();const calls=source.mock.calls.length;roadmap.advanced.request({chainId:1,contract:`0x${'4'.repeat(40)}`,watchedWallets:[],now});await roadmap.tick();expect(source).toHaveBeenCalledTimes(calls);expect(roadmap.diagnostics().stopped).toBe(true);
 });
 it('uses original quote freshness and conservative known fee allowance, never inventing missing quotes',async()=>{
 const quote={collection:'sample',floorEth:0.001,chainId:1,contract,observedAt:new Date(+now-1000).toISOString(),expiresAt:new Date(+now+60000).toISOString(),sourceReference:'opensea-v2-collection-stats' as const,currency:'ETH' as const,estimate:true as const};
 const reader=openSeaAdvancedReader({floor:async()=>quote,quote:async()=>quote});const context={chainId:1 as const,contract,now,signal:new AbortController().signal,consumeRpc:()=>{}};
 expect(await reader.floor!(context)).toMatchObject({observedAt:quote.observedAt,value:{floorWei:'1000000000000000',feePerNftWei:'400000000000000'}});
 expect(await openSeaAdvancedReader({floor:async()=>quote}).floor!(context)).toBeUndefined();expect(await reader.floor!({...context,now:new Date(+now+120000)})).toBeUndefined();
 });
 it('anchors Base and Robinhood finality in actual receipts and rejects missing posting/canonical proof',async()=>{
 const client=(options:{posted?:boolean;receiptHash?:string}={})=>({getBlockNumber:async()=>100n,getTransactionReceipt:async()=>({blockHash:options.receiptHash??hash}),getBlock:async()=>({number:100n,hash}),call:async()=>{if(options.posted===false)throw new Error('not posted');return {data:'0x'};}} as unknown as PublicClient);
 const input={transactionHash:hash,blockNumber:90n,blockHash:hash,readers:[{identity:'first.example',client:client()},{identity:'second.example',client:client()}]};
 expect(await observeRoadmapFinality({...input,chainId:8453})).toBe(true);expect(await observeRoadmapFinality({...input,chainId:4663})).toBe(true);
 expect(await observeRoadmapFinality({...input,chainId:4663,readers:[{identity:'first.example',client:client({posted:false})},input.readers[1]!]})).toBe(false);
 expect(await observeRoadmapFinality({...input,chainId:4663,readers:[input.readers[0]!,{identity:'second.example',client:client({receiptHash:`0x${'b'.repeat(64)}`})}]})).toBe(false);
 await expect(observeRoadmapFinality({...input,chainId:8453,readers:[input.readers[0]!,{identity:'second.example',client:client({receiptHash:`0x${'b'.repeat(64)}`})}]})).rejects.toThrow('BASE_PROVIDER_FINALITY_DISAGREEMENT');
 });
});
