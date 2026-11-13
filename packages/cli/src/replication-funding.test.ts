import { DurableStore, type Campaign, type FundingCostObservation } from '@mint-bot/backend';
import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { QualifiedSource } from './replication-source.js';
import { buildReplicationPlan, buildSeaDropPublicMintCalldata, SEADROP_V1_ADDRESS, type DropConfig } from '@mint-bot/engine';
import { createReplicationAutoFunding, fundedReplicationWallets, replicationFundingRequirement } from './replication-prepare.js';
const wallet = `0x${'1'.repeat(40)}` as Address;
const other = `0x${'2'.repeat(40)}` as Address;
function source(chainId: 1 | 8453 | 4663): QualifiedSource {
  const drop: DropConfig = { chainId, mintPrice: 0n, maxTotalMintableByWallet: 10, nftContract: other, feePayer: wallet, strategyName: 'seadrop-v1-public', maxTokenSupply: 100n, totalMinted: 0n, startTime: 1, endTime: 2_000_000_000 };
  const observed = { chainId, from: wallet, to: SEADROP_V1_ADDRESS, value: 0n, data: buildSeaDropPublicMintCalldata(other, wallet, 2) };
  return { drop, observed, mintedAt: '2026-11-07T00:00:00Z', plan: buildReplicationPlan({ observed, drop, targetWallets: [wallet, other] }) };
}
describe('funding before a one-shot replication claim', () => {
  it.each([[1, 400_000_000_000_000n], [8453, 200_000_000_000_000n], [4663, 200_000_000_000_000n]] as const)('keeps chain %s reserve arithmetic in wei', (chainId, reserve) => {
    expect(replicationFundingRequirement(source(chainId), 10)).toBe(reserve);
  });
  it('keeps only target wallets with independently readable sufficient balance', async () => {
    const read = vi.fn(async (address: Address) => address === wallet ? 200_000_000_000_000n : 0n);
    expect(await fundedReplicationWallets(source(4663), [wallet, other], 10, read)).toEqual([wallet]);
    read.mockRejectedValue(new Error('untrusted RPC response'));
    await expect(fundedReplicationWallets(source(4663), [wallet, other], 10, read)).rejects.toThrow('REPLICATION_BALANCE_UNAVAILABLE');
  });
  it('does not confuse a zero balance with unavailable RPC authority or read unrelated wallets', async () => {
    const read = vi.fn(async () => 0n);
    expect(await fundedReplicationWallets(source(8453), [wallet], 10, read)).toEqual([]);
    const irrelevant = `0x${'3'.repeat(40)}` as Address;
    read.mockClear();
    expect(await fundedReplicationWallets(source(8453), [irrelevant], 10, read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});


describe('prefunded replication fast path',()=>{
 async function setup(){
  const store=new DurableStore();await store.open();
  const input=source(4663);input.observed={...input.observed,hash:`0x${'a'.repeat(64)}`};
  const now=new Date(input.mintedAt);
  const campaign:Campaign={id:'fast:campaign',chainId:4663,contract:other,strategy:input.drop.strategyName,state:'Draft',quantity:1,dryRun:false,mintPriceWei:0n,feePolicy:{kind:'free',configuredPriorityFeeWei:1n},spendPolicy:{maxRunWei:10n,dailyCapWei:10n,gasCeilingWei:10n},chainVerification:{chainId:4663,status:'verified',seaDropCompatible:true,endpointReference:'synthetic'},createdAt:now.toISOString(),updatedAt:now.toISOString()};
  const sourceEvent={id:'fast:source',type:'watched_wallet_mint',at:now.toISOString(),data:{}};
  const score={id:'fast:score',type:'opportunity_scored',at:now.toISOString(),data:{score:70}};
  let costs:FundingCostObservation[]=[];Object.assign(store,{fundingExpenseSnapshot:()=>costs});
  const prepare=vi.fn(async(_source:QualifiedSource,wallets:readonly Address[])=>{await store.transaction(state=>state.campaigns.push(campaign));return {campaign,wallets:[...wallets],maxFeeGwei:0.2};});
  const coordinator={prepareFunding:vi.fn(async(_input:{idempotencyKey:string})=>{throw new Error('STRICT_FUNDING_PATH');}),fundHold:vi.fn(async()=>{throw new Error('UNEXPECTED_FUND');}),reconcileFunding:vi.fn(async()=>[])};
  const funded=vi.fn(async()=>[wallet]);
  const helper=createReplicationAutoFunding({store,coordinator,prepare,funded,now:()=>now});
  return {store,input,campaign,sourceEvent,score,prepare,coordinator,funded,helper,setCosts:(rows:FundingCostObservation[])=>{costs=rows;}};
 }
 it('prepares only the already-funded subset without creating any funding hold or calling the hub',async()=>{
  const s=await setup();const result=await s.helper.ensure(s.input,[wallet,other],s.sourceEvent,s.score);
  expect(result?.[0]?.wallets).toEqual([wallet]);expect(s.prepare).toHaveBeenCalledWith(s.input,[wallet]);
  expect(s.coordinator.prepareFunding).not.toHaveBeenCalled();expect(s.coordinator.fundHold).not.toHaveBeenCalled();
  expect(s.store.snapshot().events.some(row=>row.type==='replication_funding_prepared')).toBe(false);
 });
 it('does not treat a visible sufficient balance as finality for unresolved canonical funding',async()=>{
  const s=await setup();s.setCosts([{status:'unknown',reference:'funding:pending',operationId:'op',holdId:'held',campaignId:'held:campaign',chainId:4663,wallet}]);
  await expect(s.helper.ensure(s.input,[wallet],s.sourceEvent,s.score)).rejects.toThrow('STRICT_FUNDING_PATH');
  expect(s.coordinator.prepareFunding).toHaveBeenCalledOnce();expect(s.store.snapshot().events.some(row=>row.type==='replication_funding_prepared')).toBe(true);
 });
 it('resumes an existing durable hold even after its balance becomes sufficient',async()=>{
  const s=await setup();s.funded.mockResolvedValueOnce([]);
  await expect(s.helper.ensure(s.input,[wallet],s.sourceEvent,s.score)).rejects.toThrow('STRICT_FUNDING_PATH');
  const key=s.coordinator.prepareFunding.mock.calls[0]![0].idempotencyKey;
  s.coordinator.prepareFunding.mockClear();
  await expect(s.helper.ensure(s.input,[wallet,other],s.sourceEvent,s.score)).rejects.toThrow('STRICT_FUNDING_PATH');
  expect(s.coordinator.prepareFunding).toHaveBeenLastCalledWith(expect.objectContaining({idempotencyKey:key}));
  expect(s.prepare).toHaveBeenCalledOnce();expect(s.funded).toHaveBeenCalledOnce();expect(s.coordinator.prepareFunding).toHaveBeenCalledOnce();
 });
 it('requires canonical exposure metadata and does not mistake another chain funding for current-chain exposure',async()=>{
  const s=await setup();s.setCosts([{status:'unknown',reference:'funding:other-chain',operationId:'op',holdId:'held',campaignId:'held:campaign',chainId:1,wallet}]);
  expect((await s.helper.ensure(s.input,[wallet],s.sourceEvent,s.score))?.[0]?.wallets).toEqual([wallet]);
  const missing=await setup();delete (missing.store as Partial<import('@mint-bot/backend').BackendStore>).fundingExpenseSnapshot;
  await expect(missing.helper.ensure(missing.input,[wallet],missing.sourceEvent,missing.score)).rejects.toThrow('STRICT_FUNDING_PATH');
  expect(missing.funded).not.toHaveBeenCalled();
 });
});
