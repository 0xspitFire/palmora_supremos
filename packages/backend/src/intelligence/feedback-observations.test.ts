import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../types.js';
import type { MeasuredIntelligenceOutcome } from './advanced-scoring.js';
import { feedbackSamplesFromOutcomes } from './feedback-observations.js';
const collection=`0x${'1'.repeat(40)}`,wallet=`0x${'2'.repeat(40)}`,hash=`0x${'3'.repeat(64)}`;
const now=new Date('2026-11-13T12:00:00Z');
const outcome:MeasuredIntelligenceOutcome={id:'outcome:one',sourceReference:'lineage:one',chainId:1,collection,sourceWallet:wallet,decisionAt:'2026-11-13T10:01:00.000Z',outcomeAt:'2026-11-13T11:00:00.000Z',status:'confirmed',synthetic:false,costBasisWei:'100',grossProceedsWei:'200',dispositionFeesWei:'10',realizedPnlWei:'90'};
function events():EventRecord[]{return [
{id:'score',type:'opportunity_notified',at:'2026-11-13T10:00:00.000Z',data:{chainId:1,contract:collection,score:80,priceWei:'0',blocked:false,factors:[{code:'price',status:'available',points:8,max:10},{code:'floor_margin',status:'unavailable',points:0,max:10}]}},
{id:'source',type:'watched_wallet_mint',at:'2026-11-13T09:59:00.000Z',data:{chainId:1,contract:collection,wallet,txHash:hash}},
{id:'prepare',type:'replication_prepared',at:outcome.decisionAt,data:{policyVersion:'free-watched-v1',mintPriceWei:'0',sourceWallet:wallet,scoreEventId:'score',sourceEventId:'source',sourceTxHash:hash}},
];}
describe('measured feedback decision joins',()=>{
 it('uses original pre-outcome static factors and excludes unavailable inputs',()=>{
 const samples=feedbackSamplesFromOutcomes([outcome],events(),now);
 expect(samples).toHaveLength(1);expect(samples[0]).toMatchObject({baselineScore:80,decisionAt:'2026-11-13T10:00:00.000Z',eligibleFreeWatched:true,factors:[{code:'price',points:8,max:10}]});
 });
 it('never rescored historical trades without an actual prepared and watched source decision',()=>{
 expect(feedbackSamplesFromOutcomes([outcome],events().filter(event=>event.id!=='prepare'),now)).toEqual([]);
 expect(feedbackSamplesFromOutcomes([outcome],events().filter(event=>event.id!=='source'),now)).toEqual([]);
 });
 it('rejects cross-chain, paid, blocked, mismatched source and post-outcome scores',()=>{
 for(const mutate of [(rows:EventRecord[])=>{rows[0]!.data.chainId=8453;},(rows:EventRecord[])=>{rows[0]!.data.priceWei='1';},(rows:EventRecord[])=>{rows[0]!.data.blocked=true;},(rows:EventRecord[])=>{rows[1]!.data.wallet=collection;},(rows:EventRecord[])=>{rows[0]!.at='2026-11-13T11:10:00.000Z';}]){const rows=events();mutate(rows);expect(feedbackSamplesFromOutcomes([outcome],rows,now)).toEqual([]);}
 });
 it('never trains on reorged, synthetic, inconsistent or incomplete PnL facts',()=>{
 for(const override of [{status:'reorged' as const},{synthetic:true},{realizedPnlWei:'91'},{costBasisWei:null}])expect(feedbackSamplesFromOutcomes([{...outcome,...override}],events(),now)).toEqual([]);
 });
 it('uses retained static score when the original decision used an adaptive epoch',()=>{
 const rows=events();Object.assign(rows[0]!.data,{score:85,staticScore:80,modelEpochId:'epoch:one'});
 expect(feedbackSamplesFromOutcomes([outcome],rows,now)[0]?.baselineScore).toBe(80);
 rows[0]!.data.staticScore=79;expect(feedbackSamplesFromOutcomes([outcome],rows,now)).toEqual([]);
 });
});
