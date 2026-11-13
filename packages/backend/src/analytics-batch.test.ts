import { describe, expect, it } from 'vitest';
import { buildAnalyticsReport, type AnalyticsActivity } from './analytics.js';
import { ingestExternalAnalytics, readExternalAnalyticsActivities, validateExternalTransactionEvidence, type ExternalAnalyticsOptions, type ExternalTransactionEvidence } from './external-analytics.js';
import { DurableStore } from './store.js';
import { CanonicalStoreBridge } from './canonical-store.js';
import { fixture, close, ETHEREUM } from './canonical-fixtures.js';
const wallet = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, collection = `0x${'3'.repeat(40)}`;
const hash = `0x${'4'.repeat(64)}`, blockHash = `0x${'5'.repeat(64)}`;
const now = new Date('2026-11-13T12:00:00Z');
const acquire = (subIndex: number): AnalyticsActivity => ({ id: `acquire:${subIndex}`, sourceReference: 'synthetic:batch', kind: 'acquisition', chainId: 1, collection, tokenId: '7', quantity: '1', wallet, status: 'confirmed', transactionHash: hash, blockHash, blockNumber: '98', transactionIndex: 0, logIndex: 2, subIndex, at: '2026-11-13T11:00:00Z', costWei: String(100 + subIndex), gasWei: '0' });
function evidence(): ExternalTransactionEvidence { return { chainId: 1, transactionHash: hash, blockHash, blockNumber: '98', transactionIndex: 0, at: '2026-11-13T11:00:00Z', from: wallet, valueWei: '0', transactionFeeWei: '11', finality: 'finalized', readerIdentities: ['one.example', 'two.example'], transfers: [0, 1, 2].map(subIndex => ({ collection, tokenId: String(subIndex + 1), quantity: String(subIndex + 2), from: wallet, to: recipient, logIndex: 2, subIndex, batch: true as const })), settlements: [], issues: [] }; }
async function setup() { const store = new DurableStore(); await store.open(); const value = evidence(); const options: ExternalAnalyticsOptions = { store, wallets: async () => [{ chainId: 1, address: wallet }, { chainId: 1, address: recipient }], candidatePort: { page: async () => ({ candidates: [{ transactionHash: hash }], coverage: 'partial', code: 'INDEX_PARTIAL' }) }, chainPort: async () => ({ observe: async () => value }), now: () => now }; return { store, value, options }; }
describe('batch item identity, fee allocation and FIFO', () => {
  it('normalizes omitted legacy subIndex and explicit0 without false conflict', () => {
    const explicit = acquire(0); const legacy = { ...explicit, id: 'legacy-copy' }; delete legacy.subIndex;
    const result = buildAnalyticsReport({ activities: [explicit, legacy], now }); expect(result.coverage).toMatchObject({ confirmedActivities: 1, duplicatesIgnored: 1, conflictingIdentities: 0 }); expect(result.holdings).toHaveLength(1);
  });
  it('orders duplicate token-ID items by subIndex for exact FIFO basis', () => {
    const first = acquire(0), second = acquire(1); const sale: AnalyticsActivity = { ...acquire(0), id: 'sale', transactionHash: `0x${'6'.repeat(64)}`, blockNumber: '99', kind: 'sale', grossProceedsWei: '200', marketplaceFeesWei: '0', gasWei: '0' };
    const report = buildAnalyticsReport({ activities: [second, sale, first], now }); expect(report.coverage.conflictingIdentities).toBe(0); expect(report.dispositions[0]?.basisWei).toBe('100'); expect(report.holdings[0]?.basisWei).toBe('101');
  });
  it('reorgs and conflicting revisions affect only the exact batch subIndex', () => {
    const zero = acquire(0), one = acquire(1); const reorg = { ...zero, id: 'reorg-marker', status: 'reorged' as const };
    const result = buildAnalyticsReport({ activities: [zero, one, reorg], now }); expect(result.coverage).toMatchObject({ confirmedActivities: 1, reorgedExcluded: 1 }); expect(result.holdings[0]?.basisWei).toBe('101');
    const conflict = buildAnalyticsReport({ activities: [zero, one, { ...one, id: 'conflict', costWei: '999' } as AnalyticsActivity], now }); expect(conflict.coverage.conflictingIdentities).toBe(1); expect(conflict.holdings[0]?.basisWei).toBe('100');
  });
  it.each([-1, 1.5, 1000, Number.NaN])('rejects invalid subIndex%s without using the fact', subIndex => {
    expect(buildAnalyticsReport({ activities: [{ ...acquire(0), subIndex }], now }).coverage.confirmedActivities).toBe(0);
  });
  it('emits every item with source subIndex and conserves odd fees exactly once on internal fleet transfers', async () => {
    const f = await setup(); await ingestExternalAnalytics(f.options); const read = readExternalAnalyticsActivities(f.store.snapshot().events);
    expect(read.activities.map(row => [row.logIndex, row.subIndex, row.gasWei])).toEqual([[2, 0, '3'], [2, 1, '4'], [2, 2, '4']]); expect(new Set(read.activities.map(row => row.id)).size).toBe(3);
    expect(read.activities.every(row => row.kind === 'transfer')).toBe(true); expect(read.coverage).toMatchObject({ status: 'partial', historyComplete: false });
    const acquisitions = [0, 1, 2].map(index => ({ ...acquire(index), tokenId: String(index + 1), quantity: String(index + 2), transactionHash: `0x${'7'.repeat(64)}`, blockNumber: '97' }));
    const report = buildAnalyticsReport({ activities: [...read.activities, ...acquisitions], now }); expect(report.totals.transferGasExpenseWei).toBe('11'); expect(report.totals.transactionAndMarketplaceFeesWei).toBe('11'); expect(report.holdings.map(row => [row.wallet, row.basisWei])).toEqual([[recipient, '100'], [recipient, '101'], [recipient, '102']]);
    await ingestExternalAnalytics(f.options); expect(f.store.snapshot().events.filter(event => event.type === 'analytics_external_observation')).toHaveLength(1);
  });
  it('retains independent batch items through cold SQLite restore', async () => {
    const f = await setup(); const sql = await fixture(ETHEREUM);
    try { f.options.store = sql.store; await ingestExternalAnalytics(f.options); const cold = new CanonicalStoreBridge(sql.db); await cold.open(); f.options.store = cold; await ingestExternalAnalytics(f.options); const read = readExternalAnalyticsActivities(cold.eventSnapshot()); expect(read.activities.map(row => row.subIndex)).toEqual([0, 1, 2]); expect(cold.eventSnapshot().filter(event => event.type === 'analytics_external_observation')).toHaveLength(1); }
    finally { await close(sql); }
  });
  it('keeps unsupported batch purchase/bundle costs unknown and rejects an invented single-asset settlement', async () => {
    const f = await setup(); f.value.transfers = f.value.transfers.map(row => ({ ...row, from: `0x${'8'.repeat(40)}`, to: wallet })); await ingestExternalAnalytics(f.options);
    expect(readExternalAnalyticsActivities(f.store.snapshot().events).activities.every(row => row.kind === 'acquisition' && row.costWei === null)).toBe(true);
    f.value.transfers = [f.value.transfers[0]!]; f.value.settlements = [{ protocol: 'seaport-single-nft-v1', transferLogIndex: 2, seller: f.value.transfers[0]!.from, buyer: wallet, currency: 'ETH', grossWei: '100', feesWei: '1' }];
    expect(() => validateExternalTransactionEvidence(f.value, 1, hash, now)).toThrow('SETTLEMENT_INVALID');
  });
  it('rejects duplicate (log,subIndex) evidence rather than overwriting fee allocations', () => {
    const value = evidence(); value.transfers = [{ ...value.transfers[0]!, subIndex: undefined }, value.transfers[0]!]; expect(() => validateExternalTransactionEvidence(value, 1, hash, now)).toThrow('TRANSFER_INVALID');
  });
});
