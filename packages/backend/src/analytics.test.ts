import { describe, expect, it } from 'vitest';
import { buildAnalyticsReport, buildCanonicalAnalyticsReport, evaluateShadowPolicies, type AnalyticsActivity, type AnalyticsFloorQuote, type ReplayOpportunity } from './analytics.js';
import { DurableStore } from './store.js';
import type { Campaign } from './types.js';

const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;
const S = `0x${'4'.repeat(40)}`;
const now = new Date('2026-11-07T10:00:00Z');
const acquisition = (id: string, overrides: Partial<AnalyticsActivity> = {}): AnalyticsActivity => ({ id, sourceReference: `fact:${id}`, kind: 'acquisition', chainId: 1, collection: C, tokenId: '42', quantity: '1', wallet: A, status: 'confirmed', transactionHash: `0x${Number(id.replace(/\D/g, '') || '1').toString(16).padStart(64, '0')}`, blockHash: `0x${'a'.repeat(64)}`, blockNumber: id.replace(/\D/g, '') || '1', transactionIndex: 0, logIndex: 0, at: '2026-11-06T10:00:00Z', costWei: '100', gasWei: '10', campaignId: 'cmp:1', sourceWallet: S, mintType: 'public', ...overrides } as AnalyticsActivity);
const sale = (id: string, overrides: Partial<AnalyticsActivity> = {}): AnalyticsActivity => ({ ...acquisition(id), kind: 'sale', grossProceedsWei: '200', marketplaceFeesWei: '10', gasWei: '10', ...overrides } as AnalyticsActivity);
const quote = (overrides: Partial<AnalyticsFloorQuote> = {}): AnalyticsFloorQuote => ({ chainId: 1, collection: C, floorWei: '150', observedAt: '2026-11-07T09:00:00Z', expiresAt: '2026-11-07T11:00:00Z', sourceReference: 'floor:1', ...overrides });
const report = (activities: AnalyticsActivity[], floorQuotes: AnalyticsFloorQuote[] = []) => buildAnalyticsReport({ activities, floorQuotes, now });

describe('ETH FIFO analytics', () => {
  it('accounts acquisition gas, net sales, exact bigint PnL and ROI with source attribution', () => {
    const result = report([acquisition('1'), sale('2')]);
    expect(result.totals).toMatchObject({ realizedPnlWei: '70', knownBasisSoldWei: '110', realizedRoiBps: '6363', transactionAndMarketplaceFeesWei: '30' });
    expect(result.attribution.signalSources[0]).toMatchObject({ key: `1:${S}`, knownPnlWei: '70', unknownBasisQuantity: '0' });
    expect(result.mode).toBe('shadow-only'); expect(result.coverage.providerCoverageAsserted).toBe(false);
  });
  it('retains every wei across partial FIFO lots and transfers; transfer fees do not rewrite basis', () => {
    const result = report([
      acquisition('1', { quantity: '3', costWei: '100', gasWei: '1' }),
      { ...acquisition('2'), kind: 'transfer', quantity: '2', toWallet: B, gasWei: '3' } as AnalyticsActivity,
      sale('3', { wallet: B, grossProceedsWei: '60', marketplaceFeesWei: '0', gasWei: '0' }),
      sale('4', { wallet: B, grossProceedsWei: '60', marketplaceFeesWei: '0', gasWei: '0' }),
    ]);
    expect(result.dispositions.map(row => row.basisWei)).toEqual(['33', '34']);
    expect(result.holdings[0]).toMatchObject({ wallet: A, quantity: '1', basisWei: '34' });
    expect(result.totals).toMatchObject({ realizedPnlWei: '53', transferGasExpenseWei: '3' });
  });
  it('consumes older lots first in canonical block order, preserves FIFO order after a transfer', () => {
    const result = report([
      acquisition('2', { at: '2026-11-06T08:00:00Z', costWei: '200', gasWei: '0', wallet: B }),
      acquisition('1', { at: '2026-11-06T09:00:00Z', gasWei: '0' }),
      { ...acquisition('3'), kind: 'transfer', toWallet: B, gasWei: '0' } as AnalyticsActivity,
      sale('4', { wallet: B }),
    ]);
    expect(result.dispositions[0]?.basisWei).toBe('100');
    expect(result.holdings[0]?.basisWei).toBe('200');
  });
  it('never borrows inventory or prices across wallets, token IDs or chains', () => {
    const result = report([acquisition('1'), acquisition('2', { chainId: 8453 }), sale('3', { chainId: 4663 }), sale('4', { tokenId: '43' }), sale('5', { wallet: B })], [quote()]);
    expect(result.totals.realizedPnlWei).toBeNull();
    expect(result.dispositions.every(row => row.basisWei === null)).toBe(true);
    expect(result.holdings.find(row => row.chainId === 8453)?.priceStatus).toBe('missing');
  });
  it('treats absent acquisition cost and sales without history as unknown, never zero-cost profit', () => {
    const result = report([acquisition('1', { costWei: null }), sale('2', { quantity: '2' })]);
    expect(result.coverage.acquisitionCoverage).toBe('partial');
    expect(result.totals).toMatchObject({ realizedPnlWei: null, unknownRealizedQuantity: '2', realizedRoiBps: null });
    expect(result.issues).toContainEqual({ code: 'ACQUISITION_HISTORY_MISSING', activityId: '2' });
  });
  it('counts known free lots with gas basis while zero-basis ROI remains undefined', () => {
    expect(report([acquisition('1', { costWei: '0', gasWei: '0' }), sale('2')]).totals).toMatchObject({ realizedPnlWei: '180', realizedRoiBps: null });
    expect(report([acquisition('1', { costWei: '0', gasWei: '10' }), sale('2')]).totals.realizedPnlWei).toBe('170');
  });
  it('ignores exact duplicates and pending records and invalidates reorged acquisitions', () => {
    const input = acquisition('1');
    const result = report([input, { ...input, id: 'duplicate' }, acquisition('2', { status: 'pending' }), acquisition('3'), { ...acquisition('3'), status: 'reorged' }, sale('4', { quantity: '2' })]);
    expect(result.coverage).toMatchObject({ duplicatesIgnored: 2, reorgedExcluded: 1, pendingExcluded: 1 });
    expect(result.totals.unknownRealizedQuantity).toBe('1');
  });
  it('promotes matching pending facts to confirmed and rejects conflicting copies independent of order', () => {
    const row = acquisition('1');
    expect(report([{ ...row, status: 'pending' }, row]).coverage.confirmedActivities).toBe(1);
    const conflict = { ...row, costWei: '101' } as AnalyticsActivity;
    for (const activities of [[row, conflict], [conflict, row]]) {
      const result = report(activities);
      expect(result.coverage.conflictingIdentities).toBe(1); expect(result.holdings).toEqual([]); expect(result.totals.realizedPnlWei).toBeNull();
    }
  });
  it('reports floor-only unrealized estimates, movement and unknown/stale/conflicting quotes honestly', () => {
    const result = report([acquisition('1', { quantity: '2' })], [quote({ observedAt: '2026-11-06T09:00:00Z', floorWei: '120' }), quote()]);
    expect(result.totals.unrealizedPnlWei).toBe('190');
    expect(result.floorMovement[0]?.changeWei).toBe('30');
    expect(report([acquisition('1')], [quote({ expiresAt: now.toISOString() })]).holdings[0]?.priceStatus).toBe('stale');
    const conflict = report([acquisition('1')], [quote(), quote({ floorWei: '170', sourceReference: 'floor:2' })]);
    expect(conflict.totals.unrealizedPnlWei).toBeNull(); expect(conflict.holdings[0]?.priceStatus).toBe('conflict');
  });
  it('uses arbitrary precision beyond Number.MAX_SAFE_INTEGER and admits negative net sales', () => {
    const cost = '90071992547409931234567890';
    expect(report([acquisition('1', { costWei: cost, gasWei: '1' }), sale('2', { grossProceedsWei: cost, marketplaceFeesWei: '0', gasWei: '0' })]).totals.realizedPnlWei).toBe('-1');
    expect(report([acquisition('1', { costWei: '0', gasWei: '0' }), sale('2', { grossProceedsWei: '0' })]).totals.realizedPnlWei).toBe('-20');
  });
  it.each([{ quantity: '0' }, { gasWei: '-1' }, { costWei: '1.1' }, { chainId: 999 }, { wallet: 'not-an-address' }, { at: '2026-11-08T00:00:00Z' }, { sourceReference: 'https://private.example/token' }])('excludes malformed or future transaction facts: %j', overrides => {
    const result = report([acquisition('1', overrides as Partial<AnalyticsActivity>)]);
    expect(result.holdings).toEqual([]); expect(result.issues[0]?.code).toBe('ACTIVITY_INVALID'); expect(result.totals.realizedPnlWei).toBeNull();
  });
  it('reports empty input as no samples, with no fabricated PnL, prices or complete external coverage', () => {
    const result = report([]); expect(result.coverage.acquisitionCoverage).toBe('no_samples'); expect(result.totals.realizedPnlWei).toBeNull(); expect(result.totals.unrealizedPnlWei).toBeNull();
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

describe('shadow-only historical policy evaluation', () => {
  const sample = (id: string, overrides: Partial<ReplayOpportunity> = {}): ReplayOpportunity => ({ id, at: '2026-11-06T00:00:00Z', score: 75, watchedMintVerified: true, free: true, guardsPassed: true, realizedPnlWei: '20', ...overrides });
  const policies = [{ id: 'current-free-watched', minimumScore: 70, requireWatchedMint: true, freeOnly: true }];
  it('compares only eligible historical samples and excludes unknown outcomes from win-rate denominator', () => {
    const rows = [sample('a'), sample('b', { realizedPnlWei: '-10' }), sample('c', { realizedPnlWei: null }), sample('guard-failed', { guardsPassed: false }), sample('paid', { free: false }), sample('unwatched', { watchedMintVerified: false }), sample('low', { score: 69 })];
    const result = evaluateShadowPolicies(rows, policies, now)[0];
    expect(result).toMatchObject({ mode: 'shadow-only', selected: 3, measured: 2, unknownOutcomes: 1, profitable: 1, unprofitable: 1, winRateBps: 5000, knownRealizedPnlWei: '10' });
    expect(evaluateShadowPolicies([...rows].reverse(), policies, now)).toEqual(evaluateShadowPolicies(rows, policies, now));
  });
  it('deduplicates identical samples and rejects conflicting samples without picking a favorable result', () => {
    const row = sample('same'); const conflict = { ...row, realizedPnlWei: '-999' };
    expect(evaluateShadowPolicies([row, { ...row }], policies, now)[0]?.selected).toBe(1);
    expect(evaluateShadowPolicies([row, conflict], policies, now)[0]).toMatchObject({ selected: 0, conflictingSamples: 1, winRateBps: null });
    expect(evaluateShadowPolicies([conflict, row], policies, now)).toEqual(evaluateShadowPolicies([row, conflict], policies, now));
    expect(evaluateShadowPolicies([sample('future', { at: '2026-11-08T00:00:00Z' })], policies, now)[0]?.invalidSamples).toBe(1);
  });
});

describe('canonical receipt accounting adapter', () => {
  function state() {
    const snapshot = new DurableStore().snapshot();
    const campaign: Campaign = { id: 'cmp:1', state: 'Completed', chainId: 1, contract: C, strategy: 'seadrop-v1-public', quantity: 2, dryRun: false, mintPriceWei: 100n, spendPolicy: { maxRunWei: 1000n, dailyCapWei: 1000n, gasCeilingWei: 100n }, feePolicy: { kind: 'paid', configuredPriorityFeeWei: 1n }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'test' }, createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' };
    snapshot.campaigns.push(campaign);
    snapshot.runs.push({ id: 'run:1', intentId: 'intent:1', campaignId: campaign.id, mode: 'live', state: 'Completed', requestDigest: 'test', createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });
    snapshot.intents.push({ id: 'intent:1', runId: 'run:1', campaignId: campaign.id, campaignSnapshot: campaign, wallets: [A], policy: campaign.spendPolicy, feePolicy: campaign.feePolicy, chainVerification: campaign.chainVerification, simulationIds: [], evidenceAt: campaign.createdAt, createdAt: campaign.createdAt });
    snapshot.attempts.push({ id: 'attempt:1', executionId: 'exec:1', runId: 'run:1', wallet: A, hash: `0x${'b'.repeat(64)}`, state: 'Confirmed', createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });
    snapshot.receipts.push({ id: 'receipt:1', executionId: 'exec:1', runId: 'run:1', transactionAttemptId: 'attempt:1', state: 'Confirmed', gasUsed: 2n, effectiveGasPrice: 5n, actualSpendWei: 210n, observedAt: '2026-11-06T00:00:20Z' });
    snapshot.reservations.push({ id: 'reserve:1', campaignId: campaign.id, runId: 'run:1', wallet: A, amountWei: 300n, actualAmountWei: 210n, status: 'settled', accountingDate: '2026-11-06', createdAt: campaign.createdAt, updatedAt: campaign.updatedAt });
    snapshot.events.push({ id: 'prepared:1', type: 'replication_prepared', at: campaign.createdAt, data: { campaignId: campaign.id, sourceWallet: S, sourceEventId: 'watched:1' } });
    return snapshot;
  }
  it('reads settled, linked final costs without fabricating token identities or sales', () => {
    const input = state(); const before = JSON.stringify(input, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    const result = buildCanonicalAnalyticsReport(input, { now });
    expect(result.canonical).toMatchObject({ confirmed: 1, failed: 0, completeCosts: 1, recordedTotalCostWei: '210' });
    expect(result.canonical.executions[0]).toMatchObject({ confirmedIntentQuantity: 2, tokenIds: null, mintCostWei: '200', gasAndChainFeesWei: '10', sourceWallet: S, finalityLatencyMs: 20000 });
    expect(result.canonical.performance.signalSources[0]).toMatchObject({ key: `1:${S}`, confirmed: 1, totalCostWei: '210', realizedPnlWei: null });
    expect(result.holdings).toEqual([]); expect(result.totals.realizedPnlWei).toBeNull();
    expect(JSON.stringify(input, (_, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(before);
  });
  it('keeps missing, unsettled and ledger-mismatched costs unknown, and excludes dry runs', () => {
    for (const transform of [(s: ReturnType<typeof state>) => { s.receipts[0]!.actualSpendWei = undefined; }, (s: ReturnType<typeof state>) => { s.reservations[0]!.status = 'reserved'; }, (s: ReturnType<typeof state>) => { s.reservations[0]!.actualAmountWei = 211n; }]) {
      const input = state(); transform(input); expect(buildCanonicalAnalyticsReport(input, { now }).canonical.executions[0]?.totalCostWei).toBeNull();
    }
    const dry = state(); dry.runs[0]!.mode = 'dry-run'; expect(buildCanonicalAnalyticsReport(dry, { now }).canonical.executions).toEqual([]);
  });
  it('uses the latest reorg/receipt and never promotes an L2 soft receipt to final cost', () => {
    const reorg = state(); reorg.receipts.push({ ...reorg.receipts[0]!, id: 'receipt:2', state: 'Reorged', observedAt: '2026-11-06T00:01:00Z' });
    expect(buildCanonicalAnalyticsReport(reorg, { now }).canonical.confirmed).toBe(0);
    const l2 = state(); l2.intents[0]!.campaignSnapshot.chainId = 4663; l2.receipts[0]!.finalityStage = 'soft';
    expect(buildCanonicalAnalyticsReport(l2, { now }).canonical.executions[0]?.totalCostWei).toBeNull();
    l2.receipts[0]!.finalityStage = 'ethereum_final'; expect(buildCanonicalAnalyticsReport(l2, { now }).canonical.executions[0]?.totalCostWei).toBe('210');
  });
});
