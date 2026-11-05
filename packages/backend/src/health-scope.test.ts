import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from './store.js';
import { HealthService, requiresLiveRuntimeProbe } from './health.js';
import { Phase2ReadModelService } from './read-model-v1.js';
import { ExecutionCoordinator } from './coordinator.js';
import { BackendApplication } from './application.js';
import { COMPENSATING_ASSURANCE_KIND, computeWalletSetDigest, type CompensatingAssuranceConfig } from './compensating-controls.js';
import type { BackendState, Campaign, EngineAdapter, OperationalReadiness, RunRecord, ScheduledJobRecord } from './types.js';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const at = NOW.toISOString();
class Store extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }
const campaign = (dryRun = false): Campaign => ({
  id: 'campaign', state: 'Ready', chainId: 1, contract: `0x${'11'.repeat(20)}`, strategy: 'seadrop-v1-public', quantity: 1,
  dryRun, spendPolicy: { maxRunWei: 100n, dailyCapWei: 100n, gasCeilingWei: 100n }, createdAt: at, updatedAt: at,
  broadcastMode: 'public', chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'test', evidenceId: 'evidence', checkedAt: at, sourceBlock: 1n },
  mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n, freeTotalSpendCapWei: 100n, totalFeeBudgetWei: 100n },
});
const run = (state: RunRecord['state'] = 'Armed', mode: RunRecord['mode'] = 'live'): RunRecord => ({
  id: 'run', intentId: 'intent', campaignId: 'campaign', mode, requestDigest: 'digest', state, createdAt: at, updatedAt: at,
});
const job = (): ScheduledJobRecord => ({
  id: 'job', kind: 'execute', campaignId: 'campaign', runId: 'run', state: 'scheduled', scheduledAt: at,
  tMinusMs: 0, chainTimeOffsetMs: 0, idempotencyKey: 'job', requestDigest: 'digest', payload: {}, attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at,
});
const probe = (): OperationalReadiness => ({
  secretStoreReference: 'configured', storePath: 'state.sqlite', signerReady: true, killSwitchEngaged: false, notificationReady: true,
  chainVerification: 'verified', lastReconciliationAt: '2026-11-05T11:59:00.000Z', observedAt: '2026-11-05T11:59:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  custody: { provider: 'turnkey', providerIdentity: 'organization', policyReference: 'turnkey-policy', policyDigest: `0x${'1'.repeat(64)}`, policyStatus: 'approved', healthStatus: 'healthy', attestationStatus: 'verified', evidenceId: 'custody', observedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
});
async function setup(mutate?: (state: BackendState) => void) {
  const store = new Store();
  await store.transaction(state => {
    state.runtime = { startupState: 'Ready', reconciliationCompletedAt: at, blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } };
    mutate?.(state);
  });
  return store;
}
function reports(store: Store) {
  return { health: new HealthService(store, () => NOW).check(), model: new Phase2ReadModelService(() => NOW).health(store.snapshot()) };
}

describe('idle service health versus campaign execution readiness', () => {
  it('reports a healthy idle service without fabricating operational evidence or live permission', async () => {
    const store = await setup();
    const { health, model } = reports(store);
    expect(health).toMatchObject({ ready: true, state: 'Ready', blockingReasons: [], liveReadiness: { required: false, state: 'NotChecked' } });
    expect(health.operational).toBeUndefined();
    expect(health.liveReadiness.message).toContain('does not authorize a mint');
    expect(model.data).toMatchObject({ state: 'Ready', killSwitch: 'clear', dependencies: { reconciliation: 'clear' }, liveReadiness: { required: false, state: 'NotChecked' } });
    expect(model.freshness.status).toBe('unknown');
    expect(model.issues).toContainEqual(expect.objectContaining({ code: 'LIVE_READINESS_DEFERRED', severity: 'info' }));
  });

  it('does not turn a historical campaign probe into a current idle-service blocker', async () => {
    const store = await setup(state => { state.runtime.operational = { ...probe(), observedAt: '1999-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:00.000Z', signerReady: false, killSwitchEngaged: true, notificationReady: false }; });
    const { health, model } = reports(store);
    expect(health.ready).toBe(true); expect(model.data?.state).toBe('Ready');
    expect(model.data?.killSwitch).toBe('clear');
    expect(health.operational?.expiresAt).toBe('2000-01-01T00:00:00.000Z');
    expect(health.liveReadiness.state).toBe('NotChecked');
    expect(model.freshness.status).toBe('stale');
  });

  it.each(['notifications', 'backup', 'engine', 'chain'] as const)('keeps current %s dependency failure blocking while idle', async dependency => {
    const store = await setup(state => { state.runtime.dependencies[dependency] = false; });
    const { health, model } = reports(store);
    expect(health.ready).toBe(false); expect(model.data?.state).toBe('Not ready');
    expect(health.blockingReasons).toContain(`${dependency.toUpperCase()}_NOT_READY`);
  });

  it('requires an actual completed startup reconciliation, even when startup claims Ready', async () => {
    const store = await setup(state => { delete state.runtime.reconciliationCompletedAt; });
    const { health, model } = reports(store);
    expect(health.blockingReasons).toContain('STARTUP_RECONCILIATION_REQUIRED');
    expect(model.issues).toContainEqual(expect.objectContaining({ code: 'STARTUP_RECONCILIATION_REQUIRED', severity: 'blocking' }));
    expect(model.data?.dependencies.reconciliation).toBe('required');
  });

  it('does not let an unexpired but obsolete campaign observation override current idle facts', async () => {
    const store = await setup(state => { state.runtime.operational = { ...probe(), killSwitchEngaged: true, notificationReady: false }; });
    expect(reports(store).health.ready).toBe(true); expect(reports(store).model.data?.state).toBe('Ready');
    expect(reports(store).model.data?.killSwitch).toBe('clear');
    expect(reports(store).health.liveReadiness.state).toBe('NotChecked');
    await store.transaction(state => { state.killed = true; });
    expect(reports(store).health.state).toBe('Killed'); expect(reports(store).model.data?.state).toBe('Killed');
    await store.transaction(state => { state.killed = false; state.runtime.dependencies.notifications = false; });
    expect(reports(store).health.blockingReasons).toContain('NOTIFICATIONS_NOT_READY');
    expect(reports(store).model.data?.state).toBe('Not ready');
  });

  it('still enforces probe kill and notification facts for an armed live context', async () => {
    const store = await setup(state => { state.campaigns.push(campaign()); state.runs.push(run()); state.runtime.operational = { ...probe(), killSwitchEngaged: true }; });
    expect(reports(store).health.state).toBe('Killed'); expect(reports(store).model.data?.state).toBe('Killed');
    await store.transaction(state => { state.runtime.operational = { ...probe(), notificationReady: false }; });
    expect(reports(store).health.blockingReasons).toContain('NOTIFICATION_NOT_READY');
    expect(reports(store).model.data?.state).toBe('Not ready');
    expect(reports(store).health.liveReadiness).toMatchObject({ required: true, state: 'NotReady' });
  });

  it('preserves current kill state and explicit runtime safety blocks without a probe', async () => {
    const store = await setup(state => { state.killed = true; state.runtime.blockingReasons = ['UNRESOLVED_EXECUTIONS']; });
    const { health, model } = reports(store);
    expect(health.state).toBe('Killed'); expect(model.data?.state).toBe('Killed');
    expect(health.blockingReasons).toContain('UNRESOLVED_EXECUTIONS');
    expect(health.liveReadiness.state).toBe('NotChecked');
  });

  it('ignores disabled expired chain history while still blocking an enabled expired grant', async () => {
    const store = await setup(state => {
      const evidence = {
        chainId: 1 as const, status: 'accepted' as const, seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true,
        negativeCases: { revert: true, sold_out: true, price_drift: true, insufficient_funds: true, quantity_limit: true, stale_phase: true, fee_recipient: true, kill: true, cap: true },
        reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'configured', strategyVersion: 'seadrop-v1-public@1',
        checkedAt: '1999-01-01T00:00:00.000Z', sourceBlock: 1n, sourceBlockHash: `0x${'1'.repeat(64)}`,
      };
      state.chainEvidence.push(
        { ...evidence, id: 'historical-disabled', executionEnabled: false, expiresAt: '2000-01-01T00:00:00.000Z' },
        { ...evidence, id: 'current-permanent', executionEnabled: true, expiresAt: '2099-01-01T00:00:00.000Z' },
      );
    });
    expect(reports(store).health.ready).toBe(true); expect(reports(store).model.data?.state).toBe('Ready');
    await store.transaction(state => { state.chainEvidence[0]!.executionEnabled = true; });
    expect(reports(store).health.blockingReasons).toContain('STALE_CHAIN_EVIDENCE');
    expect(reports(store).model.issues).toContainEqual(expect.objectContaining({ code: 'STALE_CHAIN_EVIDENCE', severity: 'blocking' }));
    expect(reports(store).model.data?.state).toBe('Not ready');
  });

  it.each(['Armed', 'Active', 'Paused'] as const)('requires a fresh probe for a %s live run', async state => {
    const store = await setup(data => { data.campaigns.push(campaign()); data.runs.push(run(state)); });
    const { health, model } = reports(store);
    expect(health.ready).toBe(false); expect(health.blockingReasons).toContain('RUNTIME_PROBE_REQUIRED');
    expect(health.liveReadiness).toMatchObject({ required: true, state: 'NotReady' });
    expect(model.data?.state).toBe('Not ready');
    expect(model.issues).toContainEqual(expect.objectContaining({ code: 'RUNTIME_PROBE_REQUIRED', severity: 'blocking' }));
  });

  it('retains strict probe requirements for live scheduled work or an unknown execute-job context', async () => {
    const store = await setup(state => { state.jobs.push(job()); });
    expect(reports(store).health.blockingReasons).toContain('RUNTIME_PROBE_REQUIRED');
    await store.transaction(state => { state.campaigns.push(campaign()); });
    expect(reports(store).health.blockingReasons).toContain('RUNTIME_PROBE_REQUIRED');
  });

  it('does not require a live probe for known practice-only work', async () => {
    const store = await setup(state => { state.campaigns.push(campaign(true)); state.runs.push(run('Armed', 'dry-run')); state.jobs.push(job()); });
    expect(reports(store).health).toMatchObject({ ready: true, liveReadiness: { required: false } });
  });

  it('requires evidence for unsettled live exposure but not released or settled historical reservations', async () => {
    const store = await setup(state => {
      state.campaigns.push(campaign()); state.runs.push(run('Completed'));
      state.reservations.push({ id: 'reservation', runId: 'run', campaignId: 'campaign', wallet: 'wallet', amountWei: 1n, status: 'reserved', accountingDate: '2026-11-05', createdAt: at, updatedAt: at });
    });
    expect(reports(store).health.blockingReasons).toContain('RUNTIME_PROBE_REQUIRED');
    for (const status of ['released', 'settled'] as const) {
      await store.transaction(state => { state.reservations[0]!.status = status; });
      expect(reports(store).health).toMatchObject({ ready: true, liveReadiness: { required: false } });
    }
  });

  it('blocks an active context with stale or incomplete evidence and accepts a fresh valid probe', async () => {
    const store = await setup(state => { state.campaigns.push(campaign()); state.runs.push(run()); state.runtime.operational = probe(); });
    expect(reports(store).health.ready).toBe(true); expect(reports(store).model.data?.state).toBe('Ready');
    await store.transaction(state => { state.runtime.operational!.expiresAt = '2000-01-01T00:00:00.000Z'; });
    expect(reports(store).health.blockingReasons).toContain('RUNTIME_PROBE_STALE'); expect(reports(store).model.data?.state).toBe('Not ready');
    await store.transaction(state => { state.runtime.operational = { ...probe(), custody: undefined }; });
    expect(reports(store).health.blockingReasons).toContain('CUSTODY_EVIDENCE_REQUIRED'); expect(reports(store).model.data?.state).toBe('Not ready');
  });
});

describe('service readiness never replaces live admission gates', () => {
  it.each(['absent', 'stale'] as const)('refuses arm and execution with %s evidence before any engine call', async kind => {
    const store = await setup(state => { state.campaigns.push(campaign()); if (kind === 'stale') state.runtime.operational = { ...probe(), expiresAt: '2000-01-01T00:00:00.000Z' }; });
    expect(reports(store).health.ready).toBe(true);
    const prepare = vi.fn(); const execute = vi.fn();
    const engine = { prepare, execute, reconcile: vi.fn() } as unknown as EngineAdapter;
    const coordinator = new ExecutionCoordinator(store, engine);
    const error = kind === 'absent' ? 'RUNTIME_READINESS_REQUIRED' : 'RUNTIME_PROBE_STALE';
    await expect(coordinator.arm({ campaign: campaign(), wallets: ['wallet'], evidenceAt: at }, 'live')).rejects.toThrow(error);
    await store.transaction(state => {
      const current = campaign(); state.runs.push(run());
      state.intents.push({ id: 'intent', runId: 'run', campaignId: current.id, campaignSnapshot: current, wallets: ['wallet'], policy: current.spendPolicy, feePolicy: current.feePolicy, chainVerification: current.chainVerification, simulationIds: [], evidenceAt: at, createdAt: at });
    });
    await expect(coordinator.execute('run', ['wallet'])).rejects.toThrow(error);
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(store.snapshot().reservations).toHaveLength(0);
    expect(requiresLiveRuntimeProbe(store.snapshot())).toBe(true);
  });
});

describe('compensated production custody assessment requires trusted context', () => {
  const wallet = `0x${'11'.repeat(20)}`;
  const recordDigest = `sha256:${'a'.repeat(64)}`;
  const lockfileDigest = `sha256:${'c'.repeat(64)}`;
  const walletSetDigest = computeWalletSetDigest([wallet]);
  const time = (offset: number) => new Date(NOW.getTime() + offset).toISOString();
  const expected = { provider: 'turnkey' as const, providerIdentity: 'organization', policyReference: 'turnkey-production', policyDigest: `0x${'1'.repeat(64)}`, recordDigest };
  const config: CompensatingAssuranceConfig = { ceilings: { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n } }, expected: { recordDigest, lockfileDigest, walletSetDigest } };
  const compensated = (): OperationalReadiness => ({ ...probe(), observedAt: time(-60_000), expiresAt: time(300_000),
    custody: { ...probe().custody!, ...expected, assuranceKind: COMPENSATING_ASSURANCE_KIND, attestationStatus: 'unknown', observedAt: time(-60_000), expiresAt: time(300_000),
      compensatingControls: { version: 1, chainId: 1, recordDigest, lockfileDigest, walletSetDigest,
        balances: { observedAt: time(-60_000), expiresAt: time(300_000), wallets: [{ address: wallet, balanceWei: '300000000000000' }] },
        policyRecord: { digest: recordDigest, issuedAt: time(-2 * 86_400_000), expiresAt: time(5 * 86_400_000) },
        providerProbe: { observedAt: time(-60_000), status: 'ok', policyRecordDigest: recordDigest },
        signatureChecks: { transactionMatch: true, signerRecovery: true },
        rehearsal: { recordedAt: time(-86_400_000), policyRecordDigest: recordDigest, lockfileDigest, walletSetDigest, broadcastAttempted: false },
        driftResponse: { killSwitchOnDrift: true } } } });
  const production = () => setup(state => { state.campaigns.push(campaign()); state.runs.push(run()); state.runtime.operational = compensated(); });

  it('reports active generic health and readmodel custody as NotChecked instead of inventing policy context or a rejection', async () => {
    const store = await production();
    const { health, model } = reports(store);
    expect(health.ready).toBe(true);
    expect(health.liveReadiness).toMatchObject({ required: true, state: 'NotChecked' });
    expect(health.liveReadiness.message).toContain('without trusted policy');
    expect(health.blockingReasons).not.toContain('CUSTODY_EXPECTED_POLICY_REQUIRED');
    expect(model.data).toMatchObject({ state: 'Ready', liveReadiness: { required: true, state: 'NotChecked' } });
    expect(model.issues).toContainEqual(expect.objectContaining({ code: 'CUSTODY_AUTHORIZATION_NOT_ASSESSED', severity: 'info' }));
    // Application.health uses the same context-free path as the actual Telegram bridge.
    // Its real wall clock differs from the fixed fixture, so use current observations.
    const delta = Date.now() - NOW.getTime();
    await store.transaction(state => {
      const value = state.runtime.operational!;
      const shift = (date: string) => new Date(Date.parse(date) + delta).toISOString();
      value.observedAt = shift(value.observedAt); value.expiresAt = shift(value.expiresAt); value.lastReconciliationAt = shift(value.lastReconciliationAt);
      value.custody!.observedAt = shift(value.custody!.observedAt); value.custody!.expiresAt = shift(value.custody!.expiresAt);
      const controls = value.custody!.compensatingControls!;
      controls.balances!.observedAt = shift(controls.balances!.observedAt); controls.balances!.expiresAt = shift(controls.balances!.expiresAt);
      controls.policyRecord!.issuedAt = shift(controls.policyRecord!.issuedAt); controls.policyRecord!.expiresAt = shift(controls.policyRecord!.expiresAt);
      controls.providerProbe!.observedAt = shift(controls.providerProbe!.observedAt); controls.rehearsal!.recordedAt = shift(controls.rehearsal!.recordedAt);
      state.runtime.reconciliationCompletedAt = new Date().toISOString();
    });
    const response = await new BackendApplication(store, undefined as never).command('health');
    expect(response.data).toMatchObject({ ready: true, liveReadiness: { required: true, state: 'NotChecked' } });
  });

  it('fully validates when the caller provides trusted policy and assurance configuration', async () => {
    const store = await production();
    expect(new HealthService(store, () => NOW, config, expected).check()).toMatchObject({ ready: true, liveReadiness: { required: true, state: 'Ready' } });
    expect(new HealthService(store, () => NOW, undefined, expected).check().blockingReasons).toContain('CUSTODY_COMPENSATING_ASSURANCE_NOT_ACCEPTED');
    const wrong = { ...expected, recordDigest: `sha256:${'b'.repeat(64)}` };
    expect(new HealthService(store, () => NOW, config, wrong).check().blockingReasons).toContain('CUSTODY_POLICY_MISMATCH');
    const wrongConfig = { ...config, expected: { ...config.expected, recordDigest: `sha256:${'b'.repeat(64)}` } };
    expect(new HealthService(store, () => NOW, wrongConfig, expected).check().ready).toBe(false);
  });

  it.each(['stale-probe', 'stale-custody', 'rejected-policy', 'unhealthy-provider', 'malformed-reference', 'unknown-kind', 'missing-controls', 'missing-custody-expiry', 'missing-balance-expiry', 'missing-policy-expiry'] as const)('blocks observable %s even when trusted authorization context is omitted', async problem => {
    const store = await production();
    await store.transaction(state => {
      const operational = state.runtime.operational!; const custody = operational.custody!;
      if (problem === 'stale-probe') operational.expiresAt = time(-1);
      if (problem === 'stale-custody') custody.expiresAt = time(-1);
      if (problem === 'rejected-policy') custody.policyStatus = 'rejected';
      if (problem === 'unhealthy-provider') custody.healthStatus = 'unhealthy';
      if (problem === 'malformed-reference') custody.policyReference = 'wrong-provider';
      if (problem === 'unknown-kind') custody.assuranceKind = 'unknown' as never;
      if (problem === 'missing-controls') delete custody.compensatingControls;
      if (problem === 'missing-custody-expiry') custody.expiresAt = undefined as never;
      if (problem === 'missing-balance-expiry') custody.compensatingControls!.balances!.expiresAt = undefined as never;
      if (problem === 'missing-policy-expiry') custody.compensatingControls!.policyRecord!.expiresAt = undefined as never;
    });
    expect(reports(store).health.ready).toBe(false);
    expect(reports(store).health.liveReadiness.state).toBe('NotReady');
    expect(reports(store).model.data?.state).toBe('Not ready');
    expect(new HealthService(store, () => NOW, config, expected).check().ready).toBe(false);
  });
});
