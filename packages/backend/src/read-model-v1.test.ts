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
    state.receipts.push({ id: 'receipt-soft', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Confirmed', robinhoodFinality: 'soft', blockNumber: 101n, blockHash: '0xsoft', actualSpendWei: 16n, observedAt: '2026-09-17T23:02:00.000Z' });
    state.receipts.push({ id: 'receipt-posted', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Confirmed', robinhoodFinality: 'posted', blockNumber: 101n, blockHash: '0xsoft', actualSpendWei: 16n, observedAt: '2026-09-17T23:03:00.000Z' });
    state.receipts.push({ id: 'receipt-reorg', executionId: 'execution-1', runId: 'run-1', transactionAttemptId: 'attempt-1', state: 'Reorged', robinhoodFinality: 'soft', blockNumber: 101n, blockHash: '0xreorg', actualSpendWei: 16n, observedAt: '2026-09-17T23:04:00.000Z' });
    state.reconciliations.push({ id: 'reconciliation-reorg', runId: 'run-1', attemptId: 'attempt-1', result: 'reorged', observedAt: '2026-09-17T23:04:01.000Z', reason: 'canonical block changed' });
    const result = new Phase2ReadModelService(() => NOW).run(state, 'run-1', { requestId: 'request-run' });
    expect(result.data?.receipts.map(receipt => receipt.finality.stage)).toEqual(['soft', 'posted', 'soft']);
    expect(result.data?.receipts[0]?.finality.settlementReached).toBe(false);
    expect(result.data?.receipts[2]?.status).toBe('reorged');
    expect(result.data?.receipts[2]?.finality.settlementReached).toBe(false);
    expect(result.data?.reconciliations[0]?.state).toBe('reorged');
    expect(result.issues.some(item => item.code === 'REORG_RECONCILIATION_REQUIRED')).toBe(true);
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
});
