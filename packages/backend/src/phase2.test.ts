import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ReadOnlyApi } from './api.js';
import { ExecutionCoordinator } from './coordinator.js';
import { NotificationDispatcher } from './notifications.js';
import { Orchestrator } from './orchestrator.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
import { ReadModelService } from './read-model.js';
import { DurableStore } from './store.js';
import type { Campaign, EngineAdapter, RunRecord } from './types.js';

const NOW = '2026-09-18T00:00:00.000Z';
const emptyPrepared = { executionIds: [], attempts: [], receipts: [], state: 'Prepared' as const };
const campaign: Campaign = { id: 'campaign-phase2', state: 'Draft', chainId: 1, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: true, spendPolicy: { maxRunWei: 100n, dailyCapWei: 200n, gasCeilingWei: 40n }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, checkedAt: NOW, sourceBlock: 1n, endpointReference: 'secret endpoint reference' }, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: 40n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 34n }, createdAt: NOW, updatedAt: NOW };

function run(id: string): RunRecord { return { id, intentId: `intent-${id}`, campaignId: campaign.id, mode: 'dry-run', requestDigest: `digest-${id}`, state: 'Armed', createdAt: NOW, updatedAt: NOW }; }
function readyState(store: DurableStore, runs: RunRecord[]): Promise<void> { return store.transaction((state) => { state.campaigns.push(structuredClone(campaign)); state.runs.push(...runs); state.intents.push(...runs.map((item) => ({ id: item.intentId, runId: item.id, campaignId: campaign.id, campaignSnapshot: structuredClone(campaign), wallets: ['wallet-a'], policy: structuredClone(campaign.spendPolicy), feePolicy: structuredClone(campaign.feePolicy), chainVerification: structuredClone(campaign.chainVerification), simulationIds: [], evidenceAt: NOW, createdAt: NOW }))); state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } }; }); }
function engine(overrides: Partial<EngineAdapter> = {}): EngineAdapter { return { prepare: async () => emptyPrepared, execute: async () => ({ ...emptyPrepared, state: 'Confirmed' }), reconcile: async () => ({ result: 'unknown' as const, attempts: [], receipts: [] }), ...overrides }; }

describe('Phase 2 backend operational shell', () => {
  it('persists T-minus jobs and replays an idempotent schedule key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-phase2-jobs-'));
    const file = join(directory, 'jobs.json');
    try {
      const first = new DurableStore(file);
      await first.open();
      const firstRun = run('run-scheduled');
      await readyState(first, [firstRun]);
      const coordinator = new ExecutionCoordinator(first, engine());
      const orchestrator = new Orchestrator(first, coordinator, { now: () => new Date(NOW), chainTimeOffsetMs: 2_000 });
      const job = await orchestrator.scheduleRun({ runId: firstRun.id, wallets: ['Wallet-A'], openingAt: '2026-09-18T00:00:10.000Z', tMinusMs: 3_000, idempotencyKey: 'schedule-once' });
      expect(job.scheduledAt).toBe('2026-09-18T00:00:05.000Z');
      expect(await orchestrator.scheduleRun({ runId: firstRun.id, wallets: ['Wallet-A'], openingAt: '2026-09-18T00:00:10.000Z', tMinusMs: 3_000, idempotencyKey: 'schedule-once' })).toMatchObject({ id: job.id });
      const second = new DurableStore(file);
      await second.open();
      expect(second.snapshot().jobs).toHaveLength(1);
      expect(second.snapshot().jobs[0]).toMatchObject({ id: job.id, tMinusMs: 3_000, chainTimeOffsetMs: 2_000 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps execution bounded and isolates a failed scheduled job', async () => {
    const store = new DurableStore();
    const runs = [run('run-a'), run('run-b'), run('run-c')];
    await readyState(store, runs);
    let active = 0;
    let peak = 0;
    const prepare = vi.fn(async ({ runId }: { runId: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (runId === 'run-b') throw new Error('wallet failure');
      return emptyPrepared;
    });
    const orchestrator = new Orchestrator(store, new ExecutionCoordinator(store, engine({ prepare })), { maxConcurrency: 2, now: () => new Date(NOW) });
    for (const item of runs) await orchestrator.scheduleRun({ runId: item.id, wallets: ['wallet-a'], idempotencyKey: `schedule-${item.id}` });
    await orchestrator.tick();
    await orchestrator.tick();
    expect(peak).toBeLessThanOrEqual(2);
    expect(store.snapshot().jobs.filter((job) => job.state === 'succeeded')).toHaveLength(2);
    expect(store.snapshot().jobs.filter((job) => job.state === 'failed')).toHaveLength(1);
  });

  it('blocks recovered submitted work until boot reconciliation is authoritative', async () => {
    const store = new DurableStore();
    const activeRun = { ...run('run-recovery'), mode: 'live' as const, state: 'Active' as const };
    await readyState(store, [activeRun]);
    await store.transaction((state) => {
      state.attempts.push({ id: 'attempt-recovery', executionId: 'execution-recovery', runId: activeRun.id, wallet: 'wallet-a', nonce: 7, hash: `0x${'a'.repeat(64)}`, state: 'Submitted', createdAt: NOW, updatedAt: NOW });
    });
    const orchestrator = new Orchestrator(store, new ExecutionCoordinator(store, engine()), { now: () => new Date(NOW) });
    await expect(orchestrator.scheduleRun({ runId: activeRun.id, wallets: ['wallet-a'], idempotencyKey: 'recovery-job' })).rejects.toThrow('PHASE2_LIVE_MODE_DISABLED');
  });

  it('records chain-time offset and keeps live jobs queued while dependencies are blocked', async () => {
    const store = new DurableStore();
    const scheduledRun = { ...run('run-chain-time'), mode: 'live' as const };
    await readyState(store, [scheduledRun]);
    await store.transaction((state) => { state.runtime.dependencies.engine = false; });
    const orchestrator = new Orchestrator(store, new ExecutionCoordinator(store, engine()), {
      now: () => new Date(NOW),
      chainTime: () => new Date(new Date(NOW).getTime() + 5_000),
    });
    await expect(orchestrator.scheduleRun({ runId: scheduledRun.id, wallets: ['wallet-a'], idempotencyKey: 'chain-time-job' })).rejects.toThrow('PHASE2_LIVE_MODE_DISABLED');
  });

  it('projects stale readiness and does not invent balance or eligibility', async () => {
    const store = new DurableStore();
    await store.transaction((state) => {
      state.campaigns.push(structuredClone(campaign));
      state.readiness.push({ campaignId: campaign.id, wallet: 'wallet-a', state: 'Ready', freshUntil: '2020-01-01T00:00:00.000Z', observedAt: '2019-12-31T23:00:00.000Z', blockingReasons: [], checks: { funded: true, eligible: true, constructible: true, simulated: true, gasPolicy: true } });
    });
    const response = new ReadModelService(store, () => new Date(NOW)).getReadinessEnvelope(campaign.id, 'readiness-request');
    expect(response.availability).toBe('stale');
    expect(response.data?.rows[0]?.decision).toBe('stale');
    expect(response.data?.rows[0]?.cost.balance).toBeNull();
  });

  it('redacts operational secrets from GET projections', async () => {
    const store = new DurableStore();
    const currentRun = run('run-redaction');
    await readyState(store, [currentRun]);
    await store.transaction((state) => {
      state.runtime.operational = { secretStoreReference: 'TOP_SECRET', storePath: '/secret/path', signerReady: true, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified', lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' };
      state.attempts.push({ id: 'attempt-redaction', executionId: 'execution-redaction', runId: currentRun.id, wallet: 'wallet-a', nonce: 1, hash: `0x${'b'.repeat(64)}`, endpoint: 'https://user:password@provider.invalid', redactedError: 'privateKey=secret calldata=0xdead', state: 'Failed', createdAt: NOW, updatedAt: NOW });
    });
    const response = new ReadModelService(store, () => new Date(NOW)).getRunEnvelope(currentRun.id, 'redaction-request');
    const encoded = JSON.stringify(response);
    expect(encoded).not.toContain('TOP_SECRET');
    expect(encoded).not.toContain('/secret/path');
    expect(encoded).not.toContain('password');
    expect(encoded).not.toContain('privateKey');
    expect(encoded).not.toContain('calldata');
  });

  it('deduplicates one-way notifications and retries a failed delivery', async () => {
    const store = new DurableStore();
    await store.transaction((state) => { state.events.push({ id: 'event-notification', runId: 'run-notification', type: 'run_failed', at: NOW, data: {} }); });
    const sent: string[] = [];
    let failures = 1;
    const dispatcher = new NotificationDispatcher(store, { send: async ({ eventId, text }) => { if (failures-- > 0) throw new Error('provider payload=secret'); sent.push(`${eventId}:${text}`); } }, () => new Date(NOW));
    await expect(dispatcher.dispatch('event-notification', 'failed calldata=0xbeef')).rejects.toThrow('provider payload=secret');
    expect(store.snapshot().notificationOutbox[0]?.state).toBe('failed');
    await dispatcher.dispatch('event-notification', 'failed calldata=0xbeef');
    await dispatcher.dispatch('event-notification', 'failed calldata=0xbeef');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('0xbeef');
    expect(store.snapshot().notificationOutbox[0]?.state).toBe('delivered');
  });

  it('exposes only GET read-model operations', async () => {
    const store = new DurableStore();
    const api = new ReadOnlyApi(new ReadModelService(store, () => new Date(NOW)));
    const response = api.handle({ method: 'POST', path: '/api/v1/read-model/health', requestId: 'api-request' });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET');
    expect(response.body.issues[0]?.code).toBe('READ_MODEL_GET_ONLY');
    expect(PHASE2_DEFAULTS.readinessFreshnessMs).toBe(300_000);
  });
});
