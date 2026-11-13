import { describe, expect, it, vi } from 'vitest';
import { buildAnalyticsReport } from './analytics.js';
import { CanonicalStoreBridge } from './canonical-store.js';
import { ETHEREUM, fixture, close } from './canonical-fixtures.js';
import { DurableStore } from './store.js';
import { ingestExternalAnalytics, readExternalAnalyticsActivities, startExternalAnalyticsIngestion, type ExternalAnalyticsCandidatePort, type ExternalAnalyticsOptions, type ExternalTransactionEvidence } from './external-analytics.js';

const wallet = `0x${'1'.repeat(40)}`; const other = `0x${'2'.repeat(40)}`; const nft = `0x${'3'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`; const block = `0x${'b'.repeat(64)}`; const now = new Date('2026-11-13T12:00:00Z');
function evidence(input: Partial<ExternalTransactionEvidence> = {}): ExternalTransactionEvidence {
  return { chainId: 1, transactionHash: hash, blockHash: block, blockNumber: '10', transactionIndex: 0, at: '2026-11-13T11:00:00.000Z', from: other, valueWei: '100', transactionFeeWei: '10', finality: 'finalized', readerIdentities: ['one.example', 'two.example'], transfers: [{ collection: nft, from: other, to: wallet, tokenId: '1', quantity: '1', logIndex: 2 }], settlements: [{ protocol: 'seaport-single-nft-v1', transferLogIndex: 2, seller: other, buyer: wallet, currency: 'ETH', grossWei: '100', feesWei: '5' }], issues: [], ...input };
}
async function setup() {
  const store = new DurableStore(); await store.open();
  const page = vi.fn(async (_input: Parameters<ExternalAnalyticsCandidatePort['page']>[0]) => ({ candidates: [{ transactionHash: hash }], coverage: 'partial' as const, code: 'INDEX_PARTIAL' }));
  const observe = vi.fn(async (_hash: string) => evidence());
  const options: ExternalAnalyticsOptions = { store, wallets: async () => [{ chainId: 1, address: wallet }], candidatePort: { page }, chainPort: async () => ({ observe }), now: () => now };
  return { store, page, observe, options };
}

describe('durable external analytics pipeline', () => {
  it('discovers, verifies and accounts for a purchased NFT; repeated verification is idempotent', async () => {
    const s = await setup(); await ingestExternalAnalytics(s.options);
    const first = readExternalAnalyticsActivities(s.store.eventSnapshot());
    expect(first.activities).toMatchObject([{ kind: 'acquisition', costWei: '100', gasWei: '0' }]);
    expect(first.coverage).toMatchObject({ status: 'partial', historyComplete: false, completeTransactions: 1 });
    expect(buildAnalyticsReport({ activities: first.activities, now }).holdings[0]!.basisWei).toBe('100');
    await ingestExternalAnalytics(s.options);
    expect(s.observe).toHaveBeenCalledTimes(2);
    expect(s.store.eventSnapshot().filter(event => event.type === 'analytics_external_observation')).toHaveLength(1);
  });
  it('binds seller net proceeds and actual seller gas into FIFO, without double subtracting fees', async () => {
    const s = await setup();
    s.observe.mockResolvedValue(evidence({ from: wallet, transfers: [{ collection: nft, from: wallet, to: other, tokenId: '1', quantity: '1', logIndex: 2 }], settlements: [{ protocol: 'seaport-single-nft-v1', seller: wallet, buyer: other, currency: 'WETH', transferLogIndex: 2, grossWei: '100', feesWei: '5' }] }));
    await ingestExternalAnalytics(s.options);
    const sale = readExternalAnalyticsActivities(s.store.eventSnapshot()).activities[0]!;
    expect(sale).toMatchObject({ kind: 'sale', grossProceedsWei: '100', marketplaceFeesWei: '5', gasWei: '10' });
    const acquisition = { ...sale, id: 'prior', kind: 'acquisition' as const, costWei: '50', gasWei: '2', transactionHash: `0x${'c'.repeat(64)}`, blockNumber: '1', logIndex: 1 };
    const report = buildAnalyticsReport({ activities: [sale, acquisition], now });
    expect(report.totals.realizedPnlWei).toBe('33');
  });
  it('keeps unknown fees, unsupported economics and incoming basis unknown', async () => {
    const s = await setup(); s.observe.mockResolvedValue(evidence({ from: wallet, transactionFeeWei: null, settlements: [] }));
    await ingestExternalAnalytics(s.options);
    const read = readExternalAnalyticsActivities(s.store.eventSnapshot());
    expect(read.activities).toMatchObject([{ kind: 'acquisition', costWei: null }]);
    expect(read.coverage.issues).toContain('EXTERNAL_TRANSACTION_FEES_UNKNOWN');
    expect(buildAnalyticsReport({ activities: read.activities, now }).holdings[0]!.basisWei).toBeNull();
  });
  it('preserves basis across an internal fleet transfer and allocates exact gas once', async () => {
    const s = await setup(); s.options.wallets = async () => [{ chainId: 1, address: wallet }, { chainId: 1, address: other }];
    s.observe.mockResolvedValue(evidence({ from: wallet, transfers: [{ collection: nft, tokenId: '1', quantity: '1', from: wallet, to: other, logIndex: 2 }], settlements: [] }));
    await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toMatchObject([{ kind: 'transfer', wallet, toWallet: other, gasWei: '10' }]);
  });
  it('cold SQLite restore retains page candidates and resumes the same frozen page window', async () => {
    const s = await setup(); const sql = await fixture(ETHEREUM);
    try {
      s.options.store = sql.store;
      s.page.mockResolvedValueOnce({ candidates: [{ transactionHash: hash }], next: 'page2', coverage: 'partial', code: 'INDEX_PARTIAL' } as never);
      s.page.mockResolvedValueOnce({ candidates: [{ transactionHash: hash }], next: 'page3', coverage: 'partial', code: 'INDEX_PARTIAL' } as never);
      await ingestExternalAnalytics(s.options);
      const cold = new CanonicalStoreBridge(sql.db); await cold.open(); s.options.store = cold;
      const before = readExternalAnalyticsActivities(cold.eventSnapshot());
      expect(before.activities).toHaveLength(1);
      await ingestExternalAnalytics(s.options);
      expect(s.page.mock.calls.at(-1)).toMatchObject([{ cursor: 'page2', before: now.getTime() / 1000, after: 0 }]);
      const sameTimeCold = new CanonicalStoreBridge(sql.db); await sameTimeCold.open(); s.options.store = sameTimeCold;
      await ingestExternalAnalytics(s.options);
      expect(s.page.mock.calls.at(-1)).toMatchObject([{ cursor: 'page3', before: now.getTime() / 1000, after: 0 }]);
      expect(cold.eventSnapshot().filter(event => event.type === 'analytics_external_candidate')).toHaveLength(1);
      expect(cold.eventSnapshot().filter(event => event.type === 'analytics_external_observation')).toHaveLength(1);
    } finally { await close(sql); }
  });
  it('invalidates previously accepted facts on reorg/unknown authority, then admits independently reverified inclusion', async () => {
    const s = await setup(); await ingestExternalAnalytics(s.options);
    s.observe.mockRejectedValueOnce(new Error('EXTERNAL_ANALYTICS_REORGED'));
    await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toHaveLength(0);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).coverage.unavailableTransactions).toBe(1);
    s.observe.mockResolvedValueOnce(evidence({ blockHash: `0x${'c'.repeat(64)}` }));
    await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities[0]!.blockHash).toBe(`0x${'c'.repeat(64)}`);
    expect(s.store.eventSnapshot().filter(event => event.type === 'analytics_external_observation')).toHaveLength(3);
  });
  it.each(['chain', 'hash', 'readers', 'future', 'transfer', 'settlement'] as const)('refuses swapped/unproved %s evidence', async mode => {
    const s = await setup(); const row = evidence();
    if (mode === 'chain') row.chainId = 8453;
    if (mode === 'hash') row.transactionHash = `0x${'c'.repeat(64)}`;
    if (mode === 'readers') row.readerIdentities = ['same.example', 'same.example'];
    if (mode === 'future') row.at = '2027-01-01T00:00:00Z';
    if (mode === 'transfer') row.transfers = [{ ...row.transfers[0]!, quantity: '0' }];
    if (mode === 'settlement') row.settlements = [{ ...row.settlements[0]!, seller: wallet }];
    s.observe.mockResolvedValue(row); await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toHaveLength(0);
    expect(s.store.snapshot().reservations).toHaveLength(0);
  });
  it('records sanitized discovery failures and retains cursor/candidates for retry', async () => {
    const s = await setup(); s.page.mockRejectedValueOnce(new Error('https://secret.invalid/key'));
    await ingestExternalAnalytics(s.options);
    const read = readExternalAnalyticsActivities(s.store.eventSnapshot());
    expect(read.coverage).toMatchObject({ unknownDiscoveryScopes: 1, transactions: 0 });
    expect(JSON.stringify(s.store.eventSnapshot())).not.toContain('secret.invalid');
    expect(s.store.eventSnapshot().some(event => event.type === 'analytics_external_cursor')).toBe(false);
    await ingestExternalAnalytics(s.options); expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toHaveLength(1);
  });
  it('persists all candidates before advancing a page and round-robins a bounded verification batch', async () => {
    const s = await setup(); s.options.maxTransactions = 1;
    const hashes = ['a', 'b', 'c'].map(char => `0x${char.repeat(64)}`);
    s.page.mockResolvedValue({ candidates: hashes.map(transactionHash => ({ transactionHash })), coverage: 'partial', code: 'INDEX_PARTIAL' });
    s.observe.mockImplementation(async hash => evidence({ transactionHash: hash }));
    for (let i = 0; i < 3; i++) await ingestExternalAnalytics(s.options);
    expect(s.observe.mock.calls.map(row => row[0])).toEqual(hashes);
    expect(s.store.eventSnapshot().filter(event => event.type === 'analytics_external_candidate')).toHaveLength(3);
  });
  it('accepts a bounded441 owned-and-watched chain-wallet scope while discovering only two wallets per pass', async () => {
    const s = await setup();
    s.options.wallets = async () => Array.from({ length: 441 }, (_, index) => ({ chainId: ([1, 8453, 4663] as const)[Math.floor(index / 147)]!, address: `0x${(index % 147 + 1).toString(16).padStart(40, '0')}` }));
    s.options.maxTransactions = 1;
    await ingestExternalAnalytics(s.options); expect(s.page).toHaveBeenCalledTimes(2); expect(s.observe).toHaveBeenCalledTimes(1);
    await ingestExternalAnalytics(s.options); expect(s.page).toHaveBeenCalledTimes(4); expect(new Set(s.page.mock.calls.map(row => row[0].wallet)).size).toBe(4); expect(s.observe).toHaveBeenCalledTimes(2);
  });
  it('does not double ingest canonical mint logs', async () => {
    const s = await setup(); s.observe.mockResolvedValue(evidence({ transfers: [{ ...evidence().transfers[0]!, from: `0x${'0'.repeat(40)}` }], settlements: [] }));
    await s.store.transaction(state => {
      state.runs.push({ id: 'r', intentId: 'i', campaignId: 'c', mode: 'live', state: 'Completed', requestDigest: 'd', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      state.intents.push({ id: 'i', runId: 'r', campaignId: 'c', campaignSnapshot: { chainId: 1 } as never } as never);
      state.attempts.push({ id: 'a', executionId: 'e', runId: 'r', wallet, hash, state: 'Confirmed', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      state.receipts.push({ id: 'rc', executionId: 'e', runId: 'r', transactionAttemptId: 'a', state: 'Confirmed', observedAt: now.toISOString() });
    });
    await ingestExternalAnalytics(s.options); expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toHaveLength(0);
  });
  it('requires full fees for a normalized external mint basis and conserves multi-NFT value and gas', async () => {
    const s = await setup(); const transfers = [1, 2, 3].map(logIndex => ({ collection: nft, from: `0x${'0'.repeat(40)}`, to: wallet, tokenId: String(logIndex), quantity: '1', logIndex }));
    const row = evidence({ from: wallet, valueWei: '15', transactionFeeWei: '11', transfers, settlements: [], mintCost: { protocol: 'seadrop-direct-v1', method: 'mintPublic', collection: nft, minter: wallet, quantity: '3', totalValueWei: '15', transferLogIndices: [1, 2, 3] } });
    s.observe.mockResolvedValue(row); await ingestExternalAnalytics(s.options);
    const known = readExternalAnalyticsActivities(s.store.eventSnapshot()).activities;
    expect(known.map(row => row.gasWei)).toEqual(['3', '4', '4']); expect(known.every(row => row.kind === 'acquisition' && row.costWei === '5' && row.mintType === 'public')).toBe(true);
    s.observe.mockResolvedValue({ ...row, transactionFeeWei: null }); await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities.every(row => row.kind === 'acquisition' && row.costWei === null)).toBe(true);
  });
  it.each(['payer', 'value', 'quantity', 'log-binding'] as const)('refuses unbound normalized mint cost %s', async mode => {
    const s = await setup(); const row = evidence({ from: wallet, transfers: [{ ...evidence().transfers[0]!, from: `0x${'0'.repeat(40)}` }], settlements: [], mintCost: { protocol: 'seadrop-direct-v1', method: 'mintPublic', collection: nft, minter: wallet, quantity: '1', totalValueWei: '100', transferLogIndices: [2] } });
    if (mode === 'payer') row.mintCost!.minter = other;
    if (mode === 'value') row.mintCost!.totalValueWei = '99';
    if (mode === 'quantity') row.mintCost!.quantity = '2';
    if (mode === 'log-binding') row.mintCost!.transferLogIndices = [5];
    s.observe.mockResolvedValue(row); await ingestExternalAnalytics(s.options);
    expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).activities).toHaveLength(0); expect(readExternalAnalyticsActivities(s.store.eventSnapshot()).coverage.issues).toContain('EXTERNAL_ANALYTICS_MINT_COST_INVALID');
  });
  it('drains its active writer on stop and refuses all subsequent ticks', async () => {
    const s = await setup(); let release!: () => void;
    s.observe.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return evidence(); });
    const worker = startExternalAnalyticsIngestion(s.options); const pass = worker.tick();
    for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
    let stopped = false; const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); release(); await pass; await stop;
    await worker.tick(); expect(s.observe).toHaveBeenCalledTimes(1);
  });
});
