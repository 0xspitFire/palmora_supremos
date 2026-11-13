import { describe, expect, it } from 'vitest';
import { scoreOpportunity, type ScoringInput } from './scoring.js';
import { readAdvancedFeatures, createHistoricalQualityPort, type AdvancedIntelligenceSnapshot, type SourcedFact } from './advanced-scoring.js';
const now=new Date('2026-11-13T12:00:00Z'); const contract=`0x${'1'.repeat(40)}`; const wallet=`0x${'2'.repeat(40)}`;
const context={chainId:1 as const,contract,watchedWallets:[wallet],now};
const fact=<T>(value:T):SourcedFact<T>=>({chainId:1,contract,observedAt:now.toISOString(),expiresAt:new Date(+now+60_000).toISOString(),sourceReference:'verified-test-evidence',value});
const advanced:AdvancedIntelligenceSnapshot={version:'advanced-facts-v1',chainId:1,contract,floor:fact({floorWei:'1000',feePerNftWei:'10'}),sourceVerified:fact(true),contractCreatedAt:fact('2025-01-01T00:00:00Z'),demand:fact({distinctPayers:30,mintCount:40})};
const input:ScoringInput={chainId:1,contract,watchedMinters:3,watchingConfigured:true,priceWei:0n,budgetPerNftWei:1n,knownSeaDropPattern:true,hasCode:true,mintsLastHour:40,discoveredAt:now,now};
describe('validated advanced scoring',()=>{
 it('uses fresh measured source, age, floor margin and independent payer demand while leaving unknown history unknown',()=>{
 const result=scoreOpportunity({...input,advanced});
 for(const code of ['floor_margin','verified_source','contract_age','demand'])expect(result.factors.find(f=>f.code===code)?.status).toBe('available');
 expect(result.factors.find(f=>f.code==='track_record')?.status).toBe('unavailable');expect(result.confidence).toBeGreaterThan(scoreOpportunity(input).confidence);
 });
 it.each(['expired','future','other-chain','other-contract','invalid-value','url-source'] as const)('does not turn %s data into evidence',kind=>{
 const value=structuredClone(advanced);const f=value.floor!;
 if(kind==='expired')f.expiresAt=now.toISOString();if(kind==='future')f.observedAt=new Date(+now+1000).toISOString();if(kind==='other-chain')f.chainId=8453;if(kind==='other-contract')f.contract=wallet;if(kind==='invalid-value')f.value.floorWei='NaN';if(kind==='url-source')f.sourceReference='https://untrusted.invalid/';
 expect(readAdvancedFeatures(context,value).floor).toBeUndefined();
 });
 it('derives reputation only from fully costed confirmed same-chain outcomes, excluding reorged and unmeasured rows',()=>{
 const row={id:'real-1',sourceReference:'receipt:1',chainId:1 as const,collection:contract,sourceWallet:wallet,decisionAt:'2026-11-01T00:00:00Z',outcomeAt:'2026-11-02T00:00:00Z',status:'confirmed' as const,synthetic:false,costBasisWei:'10',grossProceedsWei:'30',dispositionFeesWei:'5',realizedPnlWei:'15'};
 const history=createHistoricalQualityPort(()=>[row,{...row,id:'incomplete',sourceReference:'receipt:2',costBasisWei:null},{...row,id:'base',sourceReference:'receipt:3',chainId:8453}]);
 expect(history.snapshot(context)?.walletQuality?.value).toMatchObject({samples:1,profitable:1});
 expect(createHistoricalQualityPort(()=>[row,{...row,status:'reorged'}]).snapshot(context)?.walletQuality).toBeUndefined();
 });
 it('bounds adaptive movement and rejects cross-chain models without bypassing blocking price risks',()=>{
 const model={version:'adaptive-model-v1' as const,epochId:'epoch_test',policyDigest:`sha256:${'a'.repeat(64)}`,chainId:1 as const,issuedAt:now.toISOString(),expiresAt:new Date(+now+10000).toISOString(),maxScoreChange:10,weightsBps:{price:12000,demand:8000}};
 const result=scoreOpportunity({...input,advanced,adaptiveModel:model});expect(Math.abs(result.score-result.baseScore!)).toBeLessThanOrEqual(10);expect(result.modelEpochId).toBe('epoch_test');
 expect(scoreOpportunity({...input,advanced,adaptiveModel:{...model,chainId:8453}}).modelEpochId).toBeUndefined();
 expect(scoreOpportunity({...input,advanced,adaptiveModel:model,priceWei:100n}).blocked).toBe(true);
 });
});
