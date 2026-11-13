import { describe, expect, it } from 'vitest';
import { Phase2ReadModelService } from './read-model-v1.js';
import type { BackendState, Campaign } from './types.js';

const NOW = new Date('2026-09-18T00:00:00.000Z');
const WALLET = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0x2222222222222222222222222222222222222222';

function emptyState(): BackendState {
  return {
    schemaVersion: 1,
    campaigns: [],
    runs: [],
    intents: [],
    attempts: [],
    receipts: [],
    reconciliations: [],
    reservations: [],
    events: [],
    notificationOutbox: [],
    chainEvidence: [],
    simulations: [],
    readiness: [],
    jobs: [],
    runtime: { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'secret-store-value', storePath: '/sensitive/store.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW.toISOString(), observedAt: NOW.toISOString(), expiresAt: '2026-09-18T00:10:00.000Z' } },
    killed: false,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    state: 'Armed',
    chainId: 4663,
    contract: CONTRACT,
    strategy: 'seadrop-v1-public',
    quantity: 1,
    dryRun: false,
    spendPolicy: { maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 40n },
    chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, evidenceId: 'evidence-1', checkedAt: '2026-09-17T23:00:00.000Z', sourceBlock: 100n, endpointReference: 'RH_RPC_REFERENCE' },
    mintPriceWei: 0n,
    feePolicy: { kind: 'free', configuredPriorityFeeWei: 2n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 16n },
    createdAt: '2026-09-17T22:00:00.000Z',
    updatedAt: '2026-09-17T23:00:00.000Z',
    broadcastMode: 'sequencer',
    ...overrides,
  };
}

function evidence(overrides: Partial<BackendState['chainEvidence'][number]> = {}): BackendState['chainEvidence'][number] {
  return {
    id: 'evidence-1',
    chainId: 4663,
    status: 'accepted',
    executionEnabled: false,
    seaDropCompatible: true,
    positiveLivePath: true,
    archiveForkPassed: true,
    negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true },
    reconciliationPassed: true,
    finalityPassed: true,
    endpointIdentity: 'RH_RPC_REFERENCE',
    strategyVersion: 'seadrop-v1-public@1',
    checkedAt: '2026-09-17T23:00:00.000Z',
    expiresAt: '2026-09-18T00:05:00.000Z',
    sourceBlock: 100n,
    sourceBlockHash: '0xblock',
    ...overrides,
  };
}

describe('Phase 2 read-model projection', () => {
  it('keeps unknown eligibility, stale simulation, and Robinhood blocked separate', () => {
    const state = emptyState();
    state.campaigns.push(campaign());
    state.chainEvidence.push(evidence());
    state.intents.push({ id: 'intent-1', runId: 'run-1', campaignId: 'campaign-1', campaignSnapshot: state.campaigns[0]!, wallets: [WALLET], policy: state.campaigns[0]!.spendPolicy, feePolicy: state.campaigns[0]!.feePolicy, chainVerification: state.campaigns[0]!.chainVerification, simulationIds: ['simulation-1'], evidenceAt: '2026-09-17T23:00:00.000Z', createdAt: '2026-09-17T23:00:00.000Z' });
    state.simulations.push({ id: 'simulation-1', campaignId: 'campaign-1', wallet: WALLET, inputDigest: 'digest', success: true, sourceBlock: 100n, sourceBlockHash: '0xblock', checkedAt: '2026-09-17T22:00:00.000Z', expiresAt: '2026-09-17T23:00:00.000Z', worstCaseFeeWei: 16n });
    const result = new Phase2ReadModelService(() => NOW).readiness(state, 'campaign-1', { requestId: 'request-1', snapshotId: 'snapshot-1', capturedAt: NOW.toISOString() });
    expect(result.contract).toBe('mintbot.read-model');
    expect(result.version).toBe('1');
    expect(result.snapshot).toMatchObject({ id: 'snapshot-1', consistency: 'snapshot' });
    const row = result.data?.[0];
    expect(row?.decision).toBe('blocked');
    expect(row?.checks.find(check => check.code === 'eligible')?.outcome).toBe('unknown');
    expect(row?.checks.find(check => check.code === 'simulated')?.outcome).toBe('stale');
    expect(row?.checks.find(check => check.code === 'chain_verified')?.outcome).toBe('fail');
    expect(row?.state).not.toBe('Minted');
    expect(row?.provenance.some(item => item.sourceBlockNumber === '100')).toBe(true);
  });

  it('maps Robinhood soft, posted, final, and reorg receipts without optimistic success', () => {
    const state = emptyState();
    state.campaigns.push(campaign());
    state.runs.push({ id: 'run-1', intentId: 'intent-1', campaignId: 'campaign-1', mode: 'live', requestDigest: 'digest', state: 'Active', createdAt: '2026-09-17T23:00:00.000Z', updatedAt: NOW.toISOString() });
    state.attempts.push({ id: 'attempt-1', executionId: 'execution-1', runId: 'run-1', wallet: WALLET, nonce: 1, hash: '0xhash', state: 'Submitted', robinhoodFinality: 'soft', createdAt: '2026-09-17T23:01:00.000Z', updatedAt: '2026-09-17T23:01:00.000Z' });
    state.receipts.push({ id: 'receipt-soft', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Confirmed', robinhoodFinality: 'soft', blockNumber: 101n, blockHash: '0xsoft', gasUsed: 21_000n, effectiveGasPrice: 2n, actualSpendWei: 16n, observedAt: '2026-09-17T23:02:00.000Z' });
    state.receipts.push({ id: 'receipt-posted', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Confirmed', robinhoodFinality: 'posted', blockNumber: 101n, blockHash: '0xsoft', actualSpendWei: 16n, observedAt: '2026-09-17T23:03:00.000Z' });
    state.receipts.push({ id: 'receipt-reorg', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Reorged', robinhoodFinality: 'soft', blockNumber: 101n, blockHash: '0xreorg', actualSpendWei: 16n, observedAt: '2026-09-17T23:04:00.000Z' });
    state.reconciliations.push({ id: 'reconciliation-reorg', runId: 'run-1', attemptId: 'attempt-1', result: 'reorged', observedAt: '2026-09-17T23:04:01.000Z', reason: 'canonical block changed' });
    const result = new Phase2ReadModelService(() => NOW).run(state, 'run-1', { requestId: 'request-run' });
    expect(result.data?.receipts.map(receipt => receipt.finality.stage)).toEqual(['soft', 'posted', 'soft']);
    expect(result.data?.receipts[0]?.finality.settlementReached).toBe(false);
    expect(result.data?.receipts[0]?.gasUsed?.value).toBe('21000');
    expect(result.data?.receipts[0]?.effectiveGasPrice?.amount?.value).toBe('2');
    expect(result.data?.receipts[2]?.status).toBe('reorged');
    expect(result.data?.receipts[2]?.finality.settlementReached).toBe(false);
    expect(result.data?.reconciliations[0]?.state).toBe('reorged');
    expect(result.issues.some(item => item.code === 'REORG_RECONCILIATION_REQUIRED')).toBe(true);
    expect(result.data?.run.outcome).toBe('partial');
  });

  it('derives required finality from the current campaign when Ethereum and Robinhood runs share a snapshot', () => {
    const state = emptyState();
    const ethereum = campaign({ id: 'ethereum-campaign', chainId: 1, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, checkedAt: NOW.toISOString(), sourceBlock: 100n, endpointReference: 'ETH_RPC_REFERENCE' } });
    const robinhood = campaign({ id: 'robinhood-campaign', chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, checkedAt: NOW.toISOString(), sourceBlock: 100n, endpointReference: 'RH_RPC_REFERENCE' } });
    state.campaigns.push(ethereum, robinhood);
    state.runs.push(
      { id: 'ethereum-run', intentId: 'ethereum-intent', campaignId: ethereum.id, mode: 'live', requestDigest: 'eth', state: 'Completed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      { id: 'robinhood-run', intentId: 'robinhood-intent', campaignId: robinhood.id, mode: 'live', requestDigest: 'rh', state: 'Completed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    );
    state.attempts.push(
      { id: 'ethereum-attempt', executionId: 'ethereum-execution', runId: 'ethereum-run', wallet: WALLET, nonce: 1, hash: '0xeth', state: 'Confirmed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
      { id: 'robinhood-attempt', executionId: 'robinhood-execution', runId: 'robinhood-run', wallet: WALLET, nonce: 2, hash: '0xrh', state: 'Confirmed', robinhoodFinality: 'posted', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
    );
    state.receipts.push(
      { id: 'ethereum-receipt', executionId: 'ethereum-execution', runId: 'ethereum-run', transactionAttemptId: 'ethereum-attempt', state: 'Confirmed', blockNumber: 101n, blockHash: '0xethblock', observedAt: NOW.toISOString() },
      { id: 'robinhood-receipt', executionId: 'robinhood-execution', runId: 'robinhood-run', transactionAttemptId: 'robinhood-attempt', state: 'Confirmed', robinhoodFinality: 'posted', finalityStage: 'posted', blockNumber: 101n, blockHash: '0xrhblock', observedAt: NOW.toISOString() },
    );
    const service = new Phase2ReadModelService(() => NOW);
    const ethereumResult = service.run(state, 'ethereum-run');
    const robinhoodResult = service.run(state, 'robinhood-run');
    expect(ethereumResult.data?.receipts[0]?.finality).toMatchObject({ requiredStage: 'confirmed', stage: 'unknown', settlementReached: false });
    expect(ethereumResult.data?.run.outcome).toBe('partial');
    expect(robinhoodResult.data?.receipts[0]?.finality).toMatchObject({ requiredStage: 'ethereum_final', stage: 'posted', settlementReached: false });
    expect(robinhoodResult.data?.run.outcome).toBe('partial');
  });

  it('maps an unknown receipt state to pending/unknown and never settlement', () => {
    const state = emptyState();
    const current = campaign({ id: 'unknown-campaign', chainId: 1, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, checkedAt: NOW.toISOString(), sourceBlock: 100n, endpointReference: 'ETH_RPC_REFERENCE' } });
    state.campaigns.push(current);
    state.runs.push({ id: 'unknown-run', intentId: 'unknown-intent', campaignId: current.id, mode: 'live', requestDigest: 'unknown', state: 'Completed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    state.attempts.push({ id: 'unknown-attempt', executionId: 'unknown-execution', runId: 'unknown-run', wallet: WALLET, nonce: 3, hash: '0xunknown', state: 'Confirmed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    state.receipts.push({ id: 'unknown-receipt', executionId: 'unknown-execution', runId: 'unknown-run', transactionAttemptId: 'unknown-attempt', state: 'Unobserved' as unknown as 'Prepared', observedAt: NOW.toISOString() });
    const result = new Phase2ReadModelService(() => NOW).run(state, 'unknown-run');
    expect(result.data?.receipts[0]?.status).toBe('pending');
    expect(result.data?.receipts[0]?.finality).toMatchObject({ stage: 'unknown', settlementReached: false });
    expect(result.data?.run.outcome).toBe('partial');
  });

  it('returns unavailable rather than an empty-success discovery/calendar result', () => {
    const state = emptyState();
    const service = new Phase2ReadModelService(() => NOW);
    const opportunities = service.opportunities(state, { requestId: 'opportunities' });
    const calendar = service.calendar(state, { requestId: 'calendar' });
    expect(opportunities.data).toEqual([]);
    expect(opportunities.availability).toBe('unavailable');
    expect(opportunities.issues[0]?.code).toBe('OPPORTUNITY_SOURCE_UNAVAILABLE');
    expect(calendar.data).toEqual([]);
    expect(calendar.availability).toBe('unavailable');
    expect(calendar.issues[0]?.code).toBe('CALENDAR_SOURCE_UNAVAILABLE');
  });

  it('keeps health blocked when a dependency is false without a runtime blocker', () => {
    const state = emptyState();
    state.runtime.dependencies.backup = false;
    const result = new Phase2ReadModelService(() => NOW).health(state, { requestId: 'health-dependency' });
    expect(result.data?.state).toBe('Not ready');
    expect(result.issues.some(issue => issue.code === 'BACKUP_NOT_READY')).toBe(true);
  });

  it('redacts operational secret/path fields and never exposes a Robinhood live action', () => {
    const state = emptyState();
    state.campaigns.push(campaign());
    const health = new Phase2ReadModelService(() => NOW).health(state, { requestId: 'health' });
    const readiness = new Phase2ReadModelService(() => NOW).readiness(state, 'campaign-1', { requestId: 'readiness' });
    const serializedHealth = JSON.stringify(health);
    expect(serializedHealth).not.toContain('secret-store-value');
    expect(serializedHealth).not.toContain('/sensitive/store.sqlite');
    expect(readiness.data).toEqual([]);
  });
  it.each([[1, 'Ethereum'], [8453, 'Base'], [4663, 'Robinhood']] as const)('preserves chain %s in opportunity, event calendar and campaign projections', (chainId, name) => {
    const state = emptyState();
    const evidenceId = `evidence-${chainId}`;
    state.chainEvidence.push(evidence({ id: evidenceId, chainId, executionEnabled: true }));
    state.campaigns.push(campaign({ id: `campaign-${chainId}`, chainId, chainVerification: { chainId, status: 'verified', seaDropCompatible: true, evidenceId, checkedAt: NOW.toISOString(), sourceBlock: 100n, endpointReference: 'RPC_REFERENCE' } }));
    state.events.push(
      { id: 'opportunity', type: 'opportunity_scored', at: NOW.toISOString(), data: { opportunityId: 'opportunity', chainId, contract: CONTRACT, evidenceId, score: 75, expiresAt: '2026-09-18T00:05:00.000Z' } },
      { id: 'calendar', type: 'calendar_entry', at: NOW.toISOString(), data: { id: 'calendar', chainId, contract: CONTRACT, evidenceId, openingAt: NOW.toISOString(), expiresAt: '2026-09-18T00:05:00.000Z' } },
    );
    const service = new Phase2ReadModelService(() => NOW);
    const opportunity = service.opportunities(state).data?.[0];
    expect(opportunity?.chain).toMatchObject({ id: chainId.toString(), name });
    expect(opportunity?.chain.verification.decision).toBe('permitted');
    const calendar = service.calendar(state).data;
    expect(calendar).toHaveLength(2);
    for (const entry of calendar ?? []) {
      expect(entry.chain).toEqual({ id: chainId.toString(), name });
      expect(entry.verification.decision).toBe('permitted');
    }
  });

  it.each([undefined, null, 'not-a-chain', -1, 10, 1.5])('never treats invalid or unsupported chain %s as Ethereum', (chainId) => {
    const state = emptyState();
    state.chainEvidence.push(evidence({ chainId: 1, executionEnabled: true }));
    state.events.push(
      { id: 'opportunity', type: 'opportunity_scored', at: NOW.toISOString(), data: { chainId, evidenceId: 'evidence-1' } },
      { id: 'calendar', type: 'calendar_entry', at: NOW.toISOString(), data: { chainId, evidenceId: 'evidence-1', openingAt: NOW.toISOString() } },
    );
    const service = new Phase2ReadModelService(() => NOW);
    expect(service.opportunities(state).data?.[0]?.chain.name).toBe('Unknown');
    expect(service.opportunities(state).data?.[0]?.gate.decision).toBe('blocked');
    expect(service.calendar(state).data?.[0]?.chain.name).toBe('Unknown');
    expect(service.calendar(state).data?.[0]?.verification.decision).toBe('blocked');
  });

  it('blocks cross-chain evidence references even when the other chain evidence is accepted', () => {
    const state = emptyState();
    state.chainEvidence.push(evidence({ id: 'ethereum-evidence', chainId: 1, executionEnabled: true }));
    state.events.push(
      { id: 'opportunity', type: 'opportunity_scored', at: NOW.toISOString(), data: { chainId: 8453, evidenceId: 'ethereum-evidence' } },
      { id: 'calendar', type: 'calendar_entry', at: NOW.toISOString(), data: { chainId: 8453, evidenceId: 'ethereum-evidence', openingAt: NOW.toISOString() } },
    );
    const service = new Phase2ReadModelService(() => NOW);
    expect(service.opportunities(state).data?.[0]?.gate.blockers[0]?.code).toBe('CHAIN_EVIDENCE_MISMATCH');
    expect(service.calendar(state).data?.[0]?.verification.blockers[0]?.code).toBe('CHAIN_EVIDENCE_MISMATCH');
  });

  it.each([1, 8453, 4663] as const)('never projects disabled chain %s as permitted', (chainId) => {
    const state = emptyState();
    state.chainEvidence.push(evidence({ chainId, executionEnabled: false }));
    state.events.push({ id: 'calendar', type: 'calendar_entry', at: NOW.toISOString(), data: { chainId, openingAt: NOW.toISOString() } });
    const entry = new Phase2ReadModelService(() => NOW).calendar(state).data?.[0];
    expect(entry?.verification.decision).toBe('blocked');
  });

});

describe('bounded read-only analytics projection', () => {
  it('keeps absent sale, basis and floor coverage unknown instead of zero or a recommendation', () => {
    const state = emptyState();
    const before = structuredClone(state);
    const result = new Phase2ReadModelService(() => NOW).analytics(state);
    expect(result.availability).toBe('partial');
    expect(result.data).toMatchObject({ mode: 'shadow-only', method: 'FIFO', currency: 'ETH', coverage: { canonicalExecutions: 0, confirmedActivities: 0, acquisitionHistory: 'no_samples', providerCoverageAsserted: false, externalTransfersAndSalesComplete: false }, totals: { recordedCanonicalCostWei: null, realizedPnlWei: null, realizedRoiBps: null, unrealizedPnlWei: null, transactionAndMarketplaceFeesWei: null }, groups: [], shadow: [] });
    expect(result.issues.map(issue => issue.code)).toContain('ANALYTICS_COVERAGE_LIMITED');
    expect(state).toEqual(before);
  });

  it('reports settled canonical costs without inventing sales, limits attribution and keeps raw facts out of the wire response', () => {
    const state = emptyState();
    const current = campaign({ id: 'accounting-campaign', chainId: 1 });
    state.campaigns.push(current);
    state.runs.push({ id: 'accounting-run', intentId: 'accounting-intent', campaignId: current.id, mode: 'live', requestDigest: 'digest', state: 'Completed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    state.intents.push({ id: 'accounting-intent', runId: 'accounting-run', campaignId: current.id, campaignSnapshot: current, wallets: [], policy: current.spendPolicy, feePolicy: current.feePolicy, chainVerification: current.chainVerification, simulationIds: [], evidenceAt: NOW.toISOString(), createdAt: NOW.toISOString() });
    for (let index = 0; index < 25; index += 1) {
      const wallet = `0x${index.toString(16).padStart(40, '0')}`;
      const executionId = `execution-${index}`;
      const attemptId = `attempt-${index}`;
      state.attempts.push({ id: attemptId, executionId, runId: 'accounting-run', wallet, hash: `0x${'a'.repeat(64)}`, state: 'Confirmed', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
      state.receipts.push({ id: `receipt-${index}`, executionId, runId: 'accounting-run', transactionAttemptId: attemptId, state: 'Confirmed', actualSpendWei: 16n, observedAt: NOW.toISOString() });
      state.reservations.push({ id: `reservation-${index}`, runId: 'accounting-run', campaignId: current.id, chainId: 1, wallet, amountWei: 100n, actualAmountWei: 16n, status: 'settled', accountingDate: '2026-09-18', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    }
    const result = new Phase2ReadModelService(() => NOW).analytics(state);
    expect(result.data?.totals.recordedCanonicalCostWei).toBe('400');
    expect(result.data?.totals.realizedPnlWei).toBeNull();
    expect(result.data?.coverage).toMatchObject({ canonicalExecutions: 25, completeCosts: 25, groupsOmitted: 7 });
    expect(result.data?.groups).toHaveLength(20);
    expect(result.data?.groups.every(group => group.realizedPnlWei === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
    expect(result.issues.some(issue => issue.code === 'ANALYTICS_GROUP_LIMIT')).toBe(true);
  });
});
