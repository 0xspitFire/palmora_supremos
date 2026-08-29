import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from './store.js';
import { SpendLedger } from './spend-ledger.js';
import { ReadinessService } from './readiness.js';
import { NotificationDispatcher } from './notifications.js';
import { normalizeError } from './errors.js';
import { BackendApplication } from './application.js';
import { ExecutionCoordinator } from './coordinator.js';
import { ReadModelService } from './read-model.js';
import { normalizeTotalFeeBudget } from './fees.js';
import { resolveWalletPath } from './keystore-path.js';
import { ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, ROBINHOOD_FREE_PER_WALLET_CAP_WEI } from './policy.js';
import { EvidenceService, campaignInputDigest } from './evidence.js';
import { HealthService } from './health.js';
import { RuntimeReadinessService } from './runtime-readiness.js';
import type { Campaign, ChainEvidenceRecord, EngineAdapter } from './types.js';

class ReadyStore extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }

const emptyResult = { executionIds: [], attempts: [], receipts: [], state: 'Prepared' as const };
const unknownUpdate = { result: 'unknown' as const, attempts: [], receipts: [] };
const engine = (overrides: Partial<EngineAdapter> = {}): EngineAdapter => ({ prepare: async () => emptyResult, execute: async () => emptyResult, reconcile: async () => unknownUpdate, ...overrides });
const feePolicy = { kind: 'free' as const, configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n };
const operational = { secretStoreReference: 'TEST_BOT', storePath: 'state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified' as const, lastReconciliationAt: '2026-08-28T00:00:00.000Z', observedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
const verification = (status: 'unverified' | 'verified' = 'verified') => ({ chainId: 4663 as const, status, seaDropCompatible: status === 'verified', evidenceId: 'evidence-1', checkedAt: '2026-08-28T00:00:00.000Z', sourceBlock: 1n, endpointReference: 'ROBINHOOD_RPC_REFERENCE' });
const submittedEvidence = (overrides: Partial<ChainEvidenceRecord> = {}): ChainEvidenceRecord => ({ id: 'evidence-1', chainId: 4663, status: 'pending', executionEnabled: false, seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true }, reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'ROBINHOOD_RPC_REFERENCE', strategyVersion: 'seadrop-v1-public@1', checkedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', sourceBlock: 1n, sourceBlockHash: '0xblock', ...overrides });
async function installAcceptedEvidence(store: DurableStore, overrides: Partial<ChainEvidenceRecord> = {}): Promise<EvidenceService> { const service = new EvidenceService(store, () => new Date(), { verify: (_record, approval) => approval.verifierId === 'engineering-lead' && approval.proof === 'approval-proof' }); await service.recordChainEvidence(submittedEvidence(overrides)); await service.acceptChainEvidence('evidence-1', { verifierId: 'engineering-lead', proof: 'approval-proof', acceptedAt: '2026-08-28T00:01:00.000Z' }); return service; }

async function createRobinhoodCampaign(store: DurableStore, status: 'unverified' | 'verified' = 'verified'): Promise<Campaign> {
  return new BackendApplication(store, undefined as never).createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, maxRunWei: 100n, dailyCapWei: 200n, gasCeilingWei: 40n, broadcastMode: 'sequencer', chainVerification: verification(status), feePolicy });
}

async function readyLiveInput(store: DurableStore) {
  const campaign = await createRobinhoodCampaign(store);
  const evidence = await installAcceptedEvidence(store);
  await evidence.recordSimulation({ id: 'sim-1', campaignId: campaign.id, wallet: 'wallet-1', inputDigest: campaignInputDigest(campaign), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', gasEstimate: 10n, worstCaseFeeWei: 34n });
  await store.transaction(state => { state.runtime = { startupState: 'Ready', reconciliationCompletedAt: new Date().toISOString(), blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational }; });
  return { campaign, wallets: ['wallet-1'], simulationIds: ['sim-1'], evidenceAt: '2026-08-28T00:00:00.000Z' };
}

describe('backend Phase 1 blockers', () => {
  it('atomically enforces run spend exposure', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store);
    await ledger.reserve('run-a', 'campaign-a', 'wallet-1', 70n, 100n);
    await expect(ledger.reserve('run-a', 'campaign-a', 'wallet-2', 31n, 100n)).rejects.toThrow('RUN_ALREADY_RESERVED');
    expect(ledger.available('run-a', 100n)).toBe(30n);
  });

  it('persists bigint reservations across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mint-backend-')); const file = join(dir, 'state.json');
    try { const first = new DurableStore(file); await first.open(); await new SpendLedger(first).reserve('run', 'campaign', 'wallet', 42n, 100n); const second = new DurableStore(file); await second.open(); expect(second.snapshot().reservations[0]?.amountWei).toBe(42n); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('returns field-level readiness blockers', () => {
    const result = new ReadinessService().evaluate({ wallet: 'wallet', funded: true, eligible: false, constructible: true, simulated: false, gasPolicy: true });
    expect(result.state).toBe('Funded'); expect(result.blockingReasons).toEqual(['eligible', 'simulated']);
  });

  it('delivers a canonical event through one durable outbox identity', async () => {
    const sent: string[] = []; const store = new DurableStore(); await store.transaction(state => { state.events.push({ id: 'event-1', type: 'run_started', at: new Date().toISOString(), data: {} }); });
    const dispatcher = new NotificationDispatcher(store, { send: async ({ eventId }) => { sent.push(eventId); } });
    await dispatcher.dispatch('event-1', 'run started'); await dispatcher.dispatch('event-1', 'run started');
    expect(sent).toEqual(['notify_event-1']); expect(store.snapshot().notificationOutbox[0]?.state).toBe('delivered');
  });

  it('redacts sensitive errors and does not retry unknown policy failures', () => {
    const error = normalizeError(new Error('privateKey=secret calldata=0xdeadbeef'));
    expect(error.message).toBe('privateKey=[REDACTED] calldata=[REDACTED]'); expect(error.retryable).toBe(false);
  });

  it('creates one immutable intent for an idempotent dry-run arm', async () => {
    const store = new DurableStore(); const campaign = await new BackendApplication(store, undefined as never).createCampaign({ chainId: 1, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 100n, dailyCapWei: 200n, gasCeilingWei: 40n, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETHEREUM_RPC_REFERENCE' }, feePolicy });
    const coordinator = new ExecutionCoordinator(store, engine()); const input = { campaign, evidenceAt: new Date().toISOString() };
    const first = await coordinator.arm(input, 'dry-run', 'same-request'); const second = await coordinator.arm(input, 'dry-run', 'same-request');
    expect(second.id).toBe(first.id); expect(first.mode).toBe('dry-run'); expect(store.snapshot().intents).toHaveLength(1);
  });

  it('uses prepare and never execute for dry-run', async () => {
    const store = new DurableStore(); const campaign = await new BackendApplication(store, undefined as never).createCampaign({ chainId: 1, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 100n, dailyCapWei: 200n, gasCeilingWei: 40n, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETHEREUM_RPC_REFERENCE' }, feePolicy });
    const execute = vi.fn(async () => emptyResult); const prepare = vi.fn(async () => emptyResult); const coordinator = new ExecutionCoordinator(store, engine({ execute, prepare })); const run = await coordinator.arm({ campaign, evidenceAt: new Date().toISOString() }, 'dry-run');
    await coordinator.execute(run.id, ['wallet']); expect(prepare).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(store.snapshot().runs[0]?.state).toBe('Completed');
  });

  it('rejects caller-asserted verification without authoritative evidence', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store); await store.transaction(state => { state.chainEvidence = []; });
    await expect(new ExecutionCoordinator(store, engine()).arm(input, 'live')).rejects.toThrow('CHAIN_VERIFICATION_EVIDENCE_NOT_FOUND');
  });

  it('rejects incomplete Robinhood negative evidence', async () => {
    const store = new ReadyStore(); const campaign = await createRobinhoodCampaign(store); const evidence = await installAcceptedEvidence(store, { negativeCases: { ...submittedEvidence().negativeCases, sold_out: false } }); await evidence.recordSimulation({ id: 'sim-1', campaignId: campaign.id, wallet: 'wallet-1', inputDigest: campaignInputDigest(campaign), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', worstCaseFeeWei: 20n }); await store.transaction(state => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational }; });
    await expect(new ExecutionCoordinator(store, engine()).arm({ campaign, wallets: ['wallet-1'], simulationIds: ['sim-1'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('ROBINHOOD_NEGATIVE_EVIDENCE_INCOMPLETE');
  });

  it('rejects missing, duplicate, and stale per-wallet simulation evidence', async () => {
    const store = new ReadyStore(); const campaign = await createRobinhoodCampaign(store); const evidence = await installAcceptedEvidence(store); await evidence.recordSimulation({ id: 'stale', campaignId: campaign.id, wallet: 'wallet-1', inputDigest: campaignInputDigest(campaign), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z', worstCaseFeeWei: 20n }); await store.transaction(state => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational }; }); const coordinator = new ExecutionCoordinator(store, engine());
    await expect(coordinator.arm({ campaign, wallets: ['wallet-1'], simulationIds: ['missing'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('WALLET_SIMULATION_NOT_FOUND');
    await expect(coordinator.arm({ campaign, wallets: ['wallet-1'], simulationIds: ['stale'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('WALLET_SIMULATION_STALE');
    await expect(coordinator.arm({ campaign, wallets: ['wallet-1', 'WALLET-1'], simulationIds: ['stale', 'stale'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('DUPLICATE_WALLET');
  });

  it('blocks live arm until startup reconciliation and authoritative store readiness', async () => {
    const store = new DurableStore(); const campaign = await createRobinhoodCampaign(store);
    await expect(new ExecutionCoordinator(store, engine()).arm({ campaign, wallets: ['wallet'], simulationIds: ['sim'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('STARTUP_RECONCILIATION_REQUIRED');
    await store.transaction(state => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational }; });
    await expect(new ExecutionCoordinator(store, engine()).arm({ campaign, wallets: ['wallet'], simulationIds: ['sim'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('DURABLE_STORE_REQUIRED');
  });

  it('binds live intent to canonical stored campaign and fleet evidence', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store); const forged = structuredClone(input.campaign); forged.chainVerification.evidenceId = 'forged';
    const run = await new ExecutionCoordinator(store, engine()).arm({ ...input, campaign: forged }, 'live');
    const intent = store.snapshot().intents.find(item => item.id === run.intentId); expect(intent?.chainVerification.evidenceId).toBe('evidence-1'); expect(intent?.wallets).toEqual(['wallet-1']);
  });

  it('reserves the entire fleet atomically and rolls back cap failure', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store);
    await expect(ledger.reserveBatch('run', 'campaign', ['a', 'b'], 60n, 100n)).rejects.toThrow('SPEND_CAP_EXCEEDED'); expect(store.snapshot().reservations).toHaveLength(0);
  });

  it('serializes concurrent admission for one run', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store); const results = await Promise.allSettled([ledger.reserveBatch('run', 'campaign', ['a'], 60n, 100n), ledger.reserveBatch('run', 'campaign', ['b'], 60n, 100n)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(store.snapshot().reservations).toHaveLength(1);
  });

  it('keeps settled spend inside caps and enforces monotonic settlement', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store); const first = await ledger.reserve('run', 'campaign', 'wallet', 70n, 100n); await ledger.settle(first.id, 60n);
    expect(ledger.available('run', 100n)).toBe(30n); await expect(ledger.release(first.id)).rejects.toThrow('INVALID_RESERVATION_TRANSITION');
  });

  it('normalizes priority against the configured component', () => {
    expect(() => normalizeTotalFeeBudget({ priorityFeeMultiplier: 2 })).toThrow('AMBIGUOUS_TOTAL_FEE_BUDGET');
    expect(normalizeTotalFeeBudget({ gasLimit: 100n, baseFeeWei: 3n, configuredPriorityFeeWei: 2n, dataFeeWei: 5n, priorityFeeMultiplier: 2 })).toBe(705n);
  });

  it('rejects incomplete fee snapshots and nonzero free mint value', async () => {
    const app = new BackendApplication(new DurableStore(), undefined as never);
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 40n, broadcastMode: 'sequencer', chainVerification: verification('unverified'), feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, freeTotalSpendCapWei: 0n, totalFeeBudgetWei: 0n } })).rejects.toThrow('GAS_COMPONENT_BUDGETS_REQUIRED');
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 1n, maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 40n, broadcastMode: 'sequencer', chainVerification: verification('unverified'), feePolicy })).rejects.toThrow('FREE_MINT_VALUE_MUST_BE_ZERO');
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 40n, broadcastMode: 'sequencer', chainVerification: verification('unverified'), feePolicy: { kind: 'free', configuredPriorityFeeWei: 5n, freeTotalSpendCapWei: 10n, l2ExecutionGasBudgetWei: 4n, l1DataGasBudgetWei: 3n, totalFeeBudgetWei: 12n } })).rejects.toThrow('FREE_TOTAL_SPEND_CAP_EXCEEDED');
  });

  it('reports fail-closed readiness for the scaffold store', () => {
    const health = new HealthService(new DurableStore()).check(); expect(health.ready).toBe(false); expect(health.blockingReasons).toContain('DURABLE_STORE_REQUIRED'); expect(health.blockingReasons).toContain('STARTUP_RECONCILIATION_REQUIRED');
  });

  it('requires complete non-secret runtime probe metadata', async () => {
    const store = new DurableStore(); const probes = new RuntimeReadinessService(store, () => new Date('2026-08-29T00:00:00.000Z'));
    await expect(probes.record({ ...operational, secretStoreReference: '' })).rejects.toThrow('RUNTIME_PROBE_INCOMPLETE');
    await probes.record(operational);
    const health = new HealthService(store, () => new Date('2026-08-29T00:00:00.000Z')).check();
    expect(health.operational?.storePath).toBe('state.sqlite'); expect(health.operational?.secretStoreReference).toBe('TEST_BOT');
  });

  it('enforces the final Robinhood FREE reserve caps', async () => {
    const app = new BackendApplication(new DurableStore(), undefined as never);
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI + 1n, dailyCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI + 1n, gasCeilingWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI + 1n, broadcastMode: 'sequencer', chainVerification: verification('unverified'), feePolicy })).rejects.toThrow('ROBINHOOD_PER_WALLET_CAP_EXCEEDED');
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI, dailyCapWei: ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI + 1n, gasCeilingWei: ROBINHOOD_FREE_PER_WALLET_CAP_WEI, broadcastMode: 'sequencer', chainVerification: verification('unverified'), feePolicy })).rejects.toThrow('ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED');
  });

  it('requires explicit execution enablement from the evidence authority', async () => {
    const store = new ReadyStore(); const campaign = await createRobinhoodCampaign(store); const evidence = new EvidenceService(store); await evidence.recordChainEvidence(submittedEvidence()); await evidence.recordSimulation({ id: 'sim-1', campaignId: campaign.id, wallet: 'wallet-1', inputDigest: campaignInputDigest(campaign), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt: '2026-08-28T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', worstCaseFeeWei: 20n }); await store.transaction(state => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational }; });
    await expect(new ExecutionCoordinator(store, engine()).arm({ campaign, wallets: ['wallet-1'], simulationIds: ['sim-1'], evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('CHAIN_VERIFICATION_NOT_ACCEPTED');
  });

  it('allows only one concurrent execution claim', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store); const coordinator = new ExecutionCoordinator(store, engine()); const run = await coordinator.arm(input, 'live');
    const results = await Promise.allSettled([coordinator.execute(run.id, ['wallet-1']), coordinator.execute(run.id, ['wallet-1'])]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(store.snapshot().reservations).toHaveLength(1);
  });

  it('keeps startup blocked while an execution outcome is unknown', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store); const coordinator = new ExecutionCoordinator(store, engine()); await coordinator.arm(input, 'live'); await coordinator.start();
    expect(store.snapshot().runtime.startupState).toBe('Blocked'); expect(store.snapshot().runtime.blockingReasons).toContain('UNRESOLVED_EXECUTIONS');
  });

  it('settles Robinhood only from observed final receipt spend', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store);
    const adapter = engine({
      execute: async request => ({ executionIds: ['execution-1'], attempts: [{ id: 'attempt-1', executionId: 'execution-1', runId: request.runId, wallet: 'wallet-1', nonce: 1, hash: '0xhash', state: 'Pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], receipts: [], state: 'Pending' }),
      reconcile: async run => ({ result: 'final', attempts: [{ id: 'attempt-final', executionId: 'execution-1', runId: run.id, wallet: 'wallet-1', nonce: 1, hash: '0xhash', state: 'Confirmed', robinhoodFinality: 'final', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], receipts: [{ id: 'receipt-final', executionId: 'execution-1', runId: run.id, state: 'Confirmed', robinhoodFinality: 'final', blockNumber: 2n, blockHash: '0xfinal', actualSpendWei: 12n, observedAt: new Date().toISOString() }] }),
    });
    const coordinator = new ExecutionCoordinator(store, adapter); const run = await coordinator.arm(input, 'live'); await coordinator.execute(run.id, ['wallet-1']); expect(store.snapshot().reservations[0]?.status).toBe('reserved'); await coordinator.reconcile(); expect(store.snapshot().reservations[0]).toMatchObject({ status: 'settled', actualAmountWei: 12n }); expect(store.snapshot().runs[0]?.state).toBe('Completed');
  });

  it('downgrades a completed run when later reconciliation observes a reorg', async () => {
    const store = new ReadyStore(); const input = await readyLiveInput(store); let observation = 0;
    const adapter = engine({ execute: async request => ({ executionIds: ['execution-1'], attempts: [{ id: 'attempt-1', executionId: 'execution-1', runId: request.runId, wallet: 'wallet-1', nonce: 1, hash: '0xhash', state: 'Pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], receipts: [], state: 'Pending' }), reconcile: async run => { observation += 1; return observation === 1 ? { result: 'final', attempts: [{ id: 'attempt-final', executionId: 'execution-1', runId: run.id, wallet: 'wallet-1', nonce: 1, hash: '0xhash', state: 'Confirmed', robinhoodFinality: 'final', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], receipts: [{ id: 'receipt-final', executionId: 'execution-1', runId: run.id, state: 'Confirmed', robinhoodFinality: 'final', blockNumber: 2n, blockHash: '0xfinal', actualSpendWei: 12n, observedAt: new Date().toISOString() }] } : { result: 'reorged', attempts: [], receipts: [{ id: 'receipt-reorg', executionId: 'execution-1', runId: run.id, state: 'Reorged', robinhoodFinality: 'soft', blockNumber: 2n, blockHash: '0xreorged', actualSpendWei: 12n, observedAt: new Date().toISOString() }], reason: 'canonical block changed' }; } });
    const coordinator = new ExecutionCoordinator(store, adapter); const run = await coordinator.arm(input, 'live'); await coordinator.execute(run.id, ['wallet-1']); await coordinator.reconcile(); await coordinator.reconcile(); expect(store.snapshot().runs[0]?.state).toBe('Failed');
  });

  it('exposes canonical missing-run errors and confines wallet paths', () => {
    const store = new DurableStore(); expect(() => new ReadModelService(store).getRun('missing')).toThrow('RUN_NOT_FOUND'); const root = join('C:', 'project'); expect(resolveWalletPath(root)).toBe(join(resolveWalletPath(root), '.')); expect(() => resolveWalletPath(root, './Rets/other')).toThrow('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
  });
});
