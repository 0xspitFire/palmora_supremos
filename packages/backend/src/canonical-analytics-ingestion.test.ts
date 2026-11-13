import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from './store.js';
import type { Campaign } from './types.js';
import { buildCanonicalAnalyticsReport } from './analytics.js';
import { CanonicalStoreBridge } from './canonical-store.js';
import { fixture, close, ETHEREUM } from './canonical-fixtures.js';
import { ingestCanonicalAnalytics, readCanonicalAnalyticsActivities, type CanonicalAnalyticsPort, type AnalyticsChainReceipt, type AnalyticsChainLog } from './canonical-analytics-ingestion.js';
const wallet = `0x${'1'.repeat(40)}`;
const nft = `0x${'2'.repeat(40)}`;
const target = `0x${'3'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`;
const blockHash = `0x${'b'.repeat(64)}`;
const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const now = new Date('2026-11-13T10:00:00Z');
const at = '2026-11-12T10:00:00Z';
async function setup(chainId: 1 | 8453 | 4663 = 1) {
  const store = new DurableStore(); await store.open();
  const campaign: Campaign = { id: 'cmp:1', chainId, contract: nft, strategy: 'seadrop-v1-public', state: 'Completed', quantity: 2, dryRun: false, mintPriceWei: 100n, feePolicy: { kind: 'paid', configuredPriorityFeeWei: 1n }, spendPolicy: { maxRunWei: 300n, dailyCapWei: 300n, gasCeilingWei: 100n }, chainVerification: { chainId, status: 'verified', seaDropCompatible: true, endpointReference: 'configured' }, createdAt: at, updatedAt: at };
  await store.transaction(state => {
    state.campaigns.push(campaign);
    state.runs.push({ id: 'run:1', intentId: 'intent:1', campaignId: campaign.id, mode: 'live', requestDigest: 'digest', state: 'Completed', createdAt: at, updatedAt: at });
    state.intents.push({ id: 'intent:1', runId: 'run:1', campaignId: campaign.id, campaignSnapshot: campaign, wallets: [wallet], policy: campaign.spendPolicy, feePolicy: campaign.feePolicy, chainVerification: campaign.chainVerification, simulationIds: [], evidenceAt: at, createdAt: at });
    state.attempts.push({ id: 'attempt:1', executionId: 'exec:1', runId: 'run:1', wallet, hash, state: 'Confirmed', createdAt: at, updatedAt: at });
    state.receipts.push({ id: 'receipt:1', executionId: 'exec:1', runId: 'run:1', transactionAttemptId: 'attempt:1', state: 'Confirmed', blockNumber: 10n, blockHash, actualSpendWei: 211n, observedAt: at, ...(chainId === 1 ? {} : { finalityStage: 'ethereum_final' as const }) });
    state.reservations.push({ id: 'reserve:1', runId: 'run:1', campaignId: campaign.id, chainId, wallet, amountWei: 300n, actualAmountWei: 211n, status: 'settled', accountingDate: '2026-11-12', createdAt: at, updatedAt: at });
    state.events.push({ id: 'prepared:1', type: 'replication_prepared', at, data: { campaignId: campaign.id, sourceWallet: target } });
  });
  const logs: AnalyticsChainLog[] = [42, 43].map((tokenId, logIndex) => ({ address: nft, topics: [topic, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${wallet.slice(2)}`, `0x${tokenId.toString(16).padStart(64, '0')}`], data: '0x', logIndex, transactionHash: hash, blockNumber: 10n, blockHash }));
  const receipt: AnalyticsChainReceipt = { transactionHash: hash, from: wallet, to: target, status: 'success', blockNumber: 10n, blockHash, transactionIndex: 1, logs };
  const client = { expectedTarget: target, chainId: vi.fn(async () => chainId), transaction: vi.fn(async () => ({ hash, from: wallet, to: target, value: 200n, blockNumber: 10n, blockHash })), receipt: vi.fn(async () => receipt), block: vi.fn(async () => ({ number: 10n, hash: blockHash, timestamp: BigInt(Date.parse(at) / 1000) })) } satisfies CanonicalAnalyticsPort;
  const run = (limit?: number) => ingestCanonicalAnalytics({ store, port: async () => client, now: () => now, ...(limit ? { maxReceipts: limit } : {}) });
  return { store, client, receipt, logs, run };
}
describe('canonical finalized acquisition ingestion', () => {
  it('retains real ingestion payload digests through SQLite serialization, cold restore and same-time revisions', async () => {
    const s = await setup(); await s.run();
    const sql = await fixture(ETHEREUM);
    try {
      const persisted = s.store.snapshot().events.filter(event => event.type === 'analytics_canonical_observation');
      await sql.store.transaction(state => { state.events.push(...persisted); });
      const cold = new CanonicalStoreBridge(sql.db); await cold.open();
      const positive = readCanonicalAnalyticsActivities(cold.eventSnapshot());
      expect(positive.coverage.confirmed).toBe(1);
      expect(positive.activities.map(activity => activity.tokenId)).toEqual(['42', '43']);
      expect(positive.activities.map(activity => activity.gasWei)).toEqual(['5', '6']);
      expect(await s.run()).toMatchObject({ written: 0, confirmed: 1 });
      s.client.block.mockResolvedValue({ number: 10n, hash: `0x${'c'.repeat(64)}`, timestamp: BigInt(Date.parse(at) / 1000) });
      await s.run();
      const revision = s.store.snapshot().events.filter(event => event.type === 'analytics_canonical_observation').at(-1)!;
      await sql.store.transaction(state => { state.events.push(revision); });
      const restored = new CanonicalStoreBridge(sql.db); await restored.open();
      expect(readCanonicalAnalyticsActivities(restored.eventSnapshot()).activities.every(activity => activity.status === 'reorged')).toBe(true);
      expect(readCanonicalAnalyticsActivities(restored.eventSnapshot()).coverage.reorged).toBe(1);
    } finally { await close(sql); }
  });
  it('extracts token IDs, exact gas remainder and source attribution; persists JSON and is idempotent', async () => {
    const s = await setup();
    expect(await s.run()).toMatchObject({ checked: 1, written: 1, confirmed: 1 });
    const inputs = readCanonicalAnalyticsActivities(s.store.snapshot().events);
    expect(inputs.coverage).toMatchObject({ confirmed: 1, externalTransfersAndSalesComplete: false });
    expect(inputs.activities.map(a => a.tokenId)).toEqual(['42', '43']);
    expect(inputs.activities.map(a => a.gasWei)).toEqual(['5', '6']);
    const report = buildCanonicalAnalyticsReport(s.store.snapshot(), { activities: inputs.activities, now });
    expect(report.holdings.map(row => row.basisWei)).toEqual(['105', '106']);
    expect(report.totals.realizedPnlWei).toBeNull();
    expect(JSON.stringify(inputs)).not.toContain('undefined');
    expect(await s.run()).toMatchObject({ checked: 1, written: 0, confirmed: 1 });
    expect(s.client.receipt).toHaveBeenCalledTimes(2);
  });
  it.each([8453, 4663] as const)('requires authoritative L2 finality on chain %s', async chainId => {
    const s = await setup(chainId);
    await s.store.transaction(state => { state.receipts[0]!.finalityStage = 'soft'; });
    expect(await s.run()).toMatchObject({ confirmed: 0, unavailable: 1 });
    expect(s.client.receipt).not.toHaveBeenCalled();
  });
  it('does not accept pending accounting, duplicate reservations, ledger mismatch or dry runs', async () => {
    for (const mode of ['pending', 'duplicate', 'mismatch', 'dry'] as const) {
      const s = await setup(); await s.store.transaction(state => {
        if (mode === 'pending') state.reservations[0]!.status = 'reserved';
        if (mode === 'duplicate') state.reservations.push({ ...state.reservations[0]!, id: 'duplicate' });
        if (mode === 'mismatch') state.reservations[0]!.actualAmountWei = 212n;
        if (mode === 'dry') state.runs[0]!.mode = 'dry-run';
      });
      expect(await s.run()).toMatchObject({ confirmed: 0, unavailable: 1 });
      expect(readCanonicalAnalyticsActivities(s.store.snapshot().events).activities).toHaveLength(0);
    }
  });
  it.each(['sender', 'target', 'value', 'status', 'block', 'chain'] as const)('rejects swapped %s observations', async mode => {
    const s = await setup();
    if (mode === 'sender') s.client.transaction.mockResolvedValue({ hash, from: target, to: target, value: 200n, blockNumber: 10n, blockHash });
    if (mode === 'target') s.receipt.to = nft;
    if (mode === 'value') s.client.transaction.mockResolvedValue({ hash, from: wallet, to: target, value: 201n, blockNumber: 10n, blockHash });
    if (mode === 'status') s.receipt.status = 'reverted';
    if (mode === 'block') s.receipt.blockHash = `0x${'c'.repeat(64)}`;
    if (mode === 'chain') s.client.chainId.mockResolvedValue(8453);
    expect(await s.run()).toMatchObject({ confirmed: 0, unavailable: 1 });
  });
  it.each(['gift', 'wrong-token', 'removed', 'missing', 'duplicate', 'wrong-log-block'] as const)('refuses unproved mint quantity: %s', async mode => {
    const s = await setup();
    if (mode === 'gift') s.logs[0]!.topics = [topic, `0x${'0'.repeat(24)}${target.slice(2)}`, s.logs[0]!.topics[2]!, s.logs[0]!.topics[3]!];
    if (mode === 'wrong-token') s.logs[0]!.address = target;
    if (mode === 'removed') s.logs[0]!.removed = true;
    if (mode === 'missing') s.logs.pop();
    if (mode === 'duplicate') s.logs[1]!.topics = [...s.logs[0]!.topics];
    if (mode === 'wrong-log-block') s.logs[0]!.blockNumber = 11n;
    expect(await s.run()).toMatchObject({ confirmed: 0, unavailable: 1 });
  });
  it('rechecks already ingested records and tombstones a proved reorg without deleting history', async () => {
    const s = await setup(); await s.run();
    s.client.block.mockResolvedValue({ number: 10n, hash: `0x${'c'.repeat(64)}`, timestamp: BigInt(Date.parse(at) / 1000) });
    expect(await s.run()).toMatchObject({ reorged: 1, written: 1 });
    expect(readCanonicalAnalyticsActivities(s.store.snapshot().events).activities.every(a => a.status === 'reorged')).toBe(true);
    expect(s.store.snapshot().events.filter(e => e.type === 'analytics_canonical_observation')).toHaveLength(2);
  });
  it('keeps a transport outage unknown, sanitizes output, and can recover later', async () => {
    const s = await setup(); await s.run(); s.client.receipt.mockRejectedValueOnce(new Error('https://credential.invalid/private'));
    expect(await s.run()).toMatchObject({ unavailable: 1 });
    expect(readCanonicalAnalyticsActivities(s.store.snapshot().events).activities).toHaveLength(0);
    expect(JSON.stringify(s.store.snapshot().events)).not.toContain('credential.invalid');
    expect(await s.run()).toMatchObject({ confirmed: 1, written: 1 });
  });
  it('rejects a canonical source changed during RPC, without mutating reservations or execution', async () => {
    const s = await setup();
    s.client.block.mockImplementationOnce(async () => { await s.store.transaction(state => { state.reservations[0]!.status = 'reorged'; }); return { number: 10n, hash: blockHash, timestamp: BigInt(Date.parse(at) / 1000) }; });
    expect(await s.run()).toMatchObject({ unavailable: 1, confirmed: 0 });
    expect(s.store.snapshot().reservations[0]!.status).toBe('reorged');
    expect(s.store.snapshot().runs[0]!.state).toBe('Completed');
  });
  it('bounds work at20 and rotates across history after restart', async () => {
    const s = await setup();
    await s.store.transaction(state => { for (let i = 2; i <= 25; i++) state.receipts.push({ ...state.receipts[0]!, id: `receipt:${i}`, executionId: `exec:${i}`, transactionAttemptId: 'missing' }); });
    expect(await s.run()).toMatchObject({ checked: 20, remaining: 5 });
    const firstIds = new Set(s.store.snapshot().events.filter(e => e.type === 'analytics_canonical_observation').map(e => e.data.executionId));
    expect(await s.run()).toMatchObject({ checked: 20 });
    const allIds = new Set(s.store.snapshot().events.filter(e => e.type === 'analytics_canonical_observation').map(e => e.data.executionId));
    expect(firstIds.size).toBe(20); expect(allIds.size).toBe(25);
    await expect(ingestCanonicalAnalytics({ store: s.store, port: async () => s.client, maxReceipts: 21 })).rejects.toThrow('ANALYTICS_INGESTION_CONFIG_INVALID');
  });
});
