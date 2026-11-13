import { describe, expect, it, vi } from 'vitest';
import { DurableStore, type Campaign, type EventRecord } from '@mint-bot/backend';
import { buildReplicationPlan, SEADROP_V1_ADDRESS, buildSeaDropPublicMintCalldata, type DropConfig } from '@mint-bot/engine';
import type { Address } from 'viem';
import { createReplicationAutomation } from './replication-automation.js';

const now = new Date('2026-11-04T12:00:00Z');
const nft = '0x1111111111111111111111111111111111111111' as Address;
const whale = '0x2222222222222222222222222222222222222222' as Address;
const wallet = '0x3333333333333333333333333333333333333333' as Address;
async function setup(price = 0n, score = 70) {
  const store = new DurableStore();
  await store.open();
  const drop: DropConfig = { chainId: 1, nftContract: nft, feePayer: whale, strategyName: 'seadrop-v1-public', mintPrice: price, maxTotalMintableByWallet: 4, maxTokenSupply: 100n, totalMinted: 0n, startTime: 1, endTime: 2_000_000_000 };
  const observed = { chainId: 1 as const, from: whale, to: SEADROP_V1_ADDRESS, data: buildSeaDropPublicMintCalldata(nft, whale, 1), value: price };
  const campaign: Campaign = { id: 'cmp-test', chainId: 1, contract: nft, state: 'Draft', strategy: drop.strategyName, quantity: 1, dryRun: false, mintPriceWei: price, feePolicy: { kind: price ? 'paid' : 'free', configuredPriorityFeeWei: 1n, l2ExecutionGasBudgetWei: 99n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 100n }, spendPolicy: { maxRunWei: 10_000n, dailyCapWei: 10_000n, gasCeilingWei: 100n }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'test-rpc' }, createdAt: now.toISOString(), updatedAt: now.toISOString() };
  const source: EventRecord = { id: 'source', type: 'watched_wallet_mint', at: now.toISOString(), data: { contract: nft, chainId: 1, wallet: whale, txHash: `0x${'a'.repeat(64)}` } };
  await store.transaction((state) => state.events.push(source, { id: 'score', type: 'opportunity_notified', at: now.toISOString(), data: { contract: nft, chainId: 1, score, blocked: false, expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString() } }));
  const qualify = vi.fn(async () => ({ observed, drop, plan: buildReplicationPlan({ observed, drop, targetWallets: [wallet] }), mintedAt: now.toISOString() }));
  const prepare = vi.fn(async () => { await store.transaction((state) => state.campaigns.push(campaign)); return { campaign, wallets: [wallet], maxFeeGwei: 0.2 }; });
  const fireAutonomous = vi.fn(async () => ({ requestId: 'request', wallets: [wallet], skipped: [] }));
  const notify = vi.fn(async () => undefined);
  const assertUnattendedReady = vi.fn(async () => undefined);
  const killSwitchOn = vi.fn(() => false);
  const deps = { store, watchedWallets: () => [whale], wallets: async () => [wallet], qualify, prepare, fireAutonomous, assertUnattendedReady, notify, now: () => now,
    fire: { now: () => now, campaign: () => campaign, killSwitchOn, conflict: () => undefined, recordSimulations: async () => ({ recorded: [wallet], skipped: [] }), createRequest: async () => ({ requestId: 'request' }), kick: () => undefined },
  };
  return { ...deps, campaign, automation: createReplicationAutomation(deps) };
}

describe('discovery to bounded autonomous request', () => {
  it('keeps an unfunded opportunity unclaimed so funding can arrive without a duplicate spending claim', async () => {
    const s = await setup();
    const fundedWallets = vi.fn(async () => [] as Address[]);
    const automation = createReplicationAutomation({ ...s, fundedWallets });
    await automation.tick();
    expect(s.prepare).not.toHaveBeenCalled();
    expect(s.store.snapshot().events.some(event => event.type === 'replication_claim')).toBe(false);
    expect(s.store.snapshot().events.find(event => event.type === 'replication_decision')?.data.code).toBe('FUNDING_NOT_ARRIVED');
    fundedWallets.mockResolvedValue([wallet]);
    await createReplicationAutomation({ ...s, fundedWallets }).tick();
    expect(s.fireAutonomous).toHaveBeenCalledOnce();
    expect(s.store.snapshot().events.filter(event => event.type === 'replication_claim')).toHaveLength(1);
  });
  it('records sanitized pre-claim failures once and preserves restart dedupe without pretending a claim exists', async () => {
    const s = await setup();
    s.qualify.mockRejectedValue(new Error('SIGNED_MINT_OWN_SIGNATURE_AND_CUSTODY_REQUIRED'));
    await s.automation.tick();
    await s.automation.tick();
    expect(s.qualify).toHaveBeenCalledOnce();
    await createReplicationAutomation(s).tick();
    expect(s.prepare).not.toHaveBeenCalled();
    expect(s.fireAutonomous).not.toHaveBeenCalled();
    const events = s.store.snapshot().events;
    expect(events.filter(e => e.type === 'replication_claim')).toHaveLength(0);
    expect(events.filter(e => e.type === 'replication_decision')).toHaveLength(1);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('wallet-specific server signature'), expect.any(String));
  });
  it('never persists provider error text and reports missing watched authority', async () => {
    const s = await setup();
    s.qualify.mockRejectedValue(new Error('https://private.invalid/credential calldata 0xabcdef'));
    await s.automation.tick();
    expect(JSON.stringify(s.store.snapshot().events)).not.toContain('private.invalid');
    expect(JSON.stringify(s.notify.mock.calls)).not.toContain('credential');
    expect(s.store.snapshot().events.find(e => e.type === 'replication_decision')?.data.code).toBe('REPLICATION_SOURCE_UNAVAILABLE');
    const missing = await setup(); await missing.store.transaction(state => { state.events = state.events.filter(e => e.type !== 'watched_wallet_mint'); });
    await missing.automation.tick();
    expect(missing.qualify).not.toHaveBeenCalled();
    expect(missing.store.snapshot().events.find(e => e.type === 'replication_decision')?.data.code).toBe('WATCHED_MINT_REQUIRED');
  });
  it('runs a free score-70 self-mint through preparation and simulation once across repeats and restart', async () => {
    const s = await setup();
    await Promise.all([s.automation.tick(), s.automation.tick()]);
    await createReplicationAutomation(s).tick();
    expect(s.prepare).toHaveBeenCalledTimes(1);
    expect(s.fireAutonomous).toHaveBeenCalledTimes(1);
    expect(s.qualify.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.store.snapshot().events.some((e) => e.type === 'replication_requested')).toBe(true);
  });
  it('prepares paid mints and sends an actionable final-fire alert; never auto-fires them', async () => {
    const s = await setup(10n);
    await s.automation.tick();
    expect(s.prepare).toHaveBeenCalledOnce();
    expect(s.fireAutonomous).not.toHaveBeenCalled();
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('/fire'), expect.any(String));
  });
  it('refuses low scores, receiver-only evidence, and a newer downgraded score', async () => {
    const low = await setup(0n, 69); await low.automation.tick(); expect(low.prepare).not.toHaveBeenCalled();
    const receiver = await setup(); await receiver.store.transaction((state) => { state.events = state.events.filter((e) => e.id !== 'source'); }); await receiver.automation.tick(); expect(receiver.prepare).not.toHaveBeenCalled();
    const downgrade = await setup(); await downgrade.store.transaction((state) => { state.events.push({ id: 'downgraded', type: 'opportunity_scored', at: now.toISOString(), data: { chainId: 1, contract: nft, score: 30 } }); }); await downgrade.automation.tick(); expect(downgrade.prepare).not.toHaveBeenCalled();
  });
  it('retains a prepared campaign but prevents autonomous fire when final-production evidence is missing', async () => {
    const s = await setup(); s.assertUnattendedReady.mockRejectedValue(new Error('OPS_EVIDENCE_NOT_ACCEPTED'));
    await s.automation.tick();
    expect(s.fireAutonomous).not.toHaveBeenCalled();
    expect(s.notify).toHaveBeenCalledWith(expect.stringContaining('OPS_EVIDENCE_NOT_ACCEPTED'), expect.any(String));
  });
  it('revalidates authority before arm/run and rejects paid or changed campaigns', async () => {
    const s = await setup(); await s.automation.tick();
    const event = s.store.snapshot().events.find((e) => e.type === 'replication_prepared')!;
    await expect(s.automation.assertReady(event.id, { ...s.campaign, mintPriceWei: 1n })).rejects.toThrow('AUTOMATION_AUTHORITY_INVALID');
    await expect(s.automation.assertReady(event.id, s.campaign, [whale], 0.2)).rejects.toThrow('AUTOMATION_REQUEST_SCOPE_INVALID');
    await expect(s.automation.assertReady(event.id, s.campaign, [wallet], 1)).rejects.toThrow('AUTOMATION_REQUEST_SCOPE_INVALID');
    s.qualify.mockRejectedValue(new Error('WATCHED_MINT_STALE_OR_REORGED'));
    await expect(s.automation.assertReady(event.id, s.campaign)).rejects.toThrow('WATCHED_MINT_STALE_OR_REORGED');
  });
});

it('does one fresh event projection and no full state reads on an already claimed opportunity', async () => {
  const s = await setup();
  await s.automation.tick();
  const snapshot = vi.spyOn(s.store, 'snapshot');
  const events = vi.spyOn(s.store, 'eventSnapshot');
  await s.automation.tick();
  expect(events).toHaveBeenCalledTimes(1);
  expect(snapshot).not.toHaveBeenCalled();
  expect(s.prepare).toHaveBeenCalledTimes(1);
});

it('retains the atomic claim check when another worker claims during qualification', async () => {
  const s = await setup();
  const original = s.qualify.getMockImplementation()!;
  s.qualify.mockImplementation(async () => {
    const qualified = await original();
    await s.store.transaction((state) => state.events.push({ id: `replication_claim:1:${nft}`, type: 'replication_claim', at: now.toISOString(), data: {} }));
    return qualified;
  });
  await s.automation.tick();
  expect(s.prepare).not.toHaveBeenCalled();
  expect(s.fireAutonomous).not.toHaveBeenCalled();
});
