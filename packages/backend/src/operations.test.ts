import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertManager } from './alerts.js';
import { JsonJobStore } from './job-store.js';
import { MetricsRegistry, RedactedLogger } from './observability.js';
import { NotificationDispatcher, type NotificationSink } from './notifications.js';
import { OrchestratorService } from './service-orchestrator.js';
import { loadServiceConfig } from './service-config.js';
import { TelegramNotifier, type HostSecretStore, type TelegramFetcher } from './telegram.js';
import { DurableStore } from './store.js';
import type { BackendApplication } from './application.js';

const wait = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('phase 2 operations', () => {
  it('keeps service defaults CI-safe and rejects direct Telegram values', () => {
    const config = loadServiceConfig({ CI: 'true' }, '/tmp/mintbot-ops');
    expect(config.mode).toBe('dry-run');
    expect(config.telegramEnabled).toBe(false);
    expect(config.requireStartupKillSwitch).toBe(true);
    expect(() => loadServiceConfig({ ['TG_BOT_' + 'TOKEN']: 'not-used' }, '/tmp/mintbot-ops')).toThrow('TELEGRAM_SECRETS_MUST_USE_SECRET_STORE');
  });

  it('persists scheduled jobs and recovers an interrupted lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-jobs-'));
    const path = join(root, 'jobs.json');
    try {
      const first = new JsonJobStore(path);
      await first.open();
      await first.put({ id: 'job-1', runId: 'run-1', wallets: ['wallet-1'], executeAt: '2026-01-01T00:00:00.000Z', mode: 'dry-run' });
      const claimed = await first.claimDue(new Date('2026-01-01T00:00:01.000Z'));
      expect(claimed[0]?.state).toBe('running');
      const second = new JsonJobStore(path);
      await second.open();
      expect(await second.recoverRunning()).toBe(1);
      expect((await second.list())[0]?.state).toBe('scheduled');
      const persisted = await readFile(path, 'utf8');
      expect(persisted).toContain('RESTART_RECOVERY_PENDING_RECONCILIATION');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders metrics and rotates a redacted JSON log without secret-like fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-log-'));
    const path = join(root, 'service.log');
    try {
      const logger = new RedactedLogger({ destination: path, stdout: false, maxBytes: 100, maxFiles: 2 });
      logger.info({ secretValue: 'do-not-persist', runId: 'run-1' }, 'provider failure');
      logger.info({ event: 'second', detail: 'x'.repeat(200) }, 'rotate');
      const current = await readFile(path, 'utf8');
      expect(current).not.toContain('do-not-persist');
      expect(await stat(`${path}.1`)).toBeTruthy();
      const metrics = new MetricsRegistry();
      metrics.recordEndpoint('ethereum', 'rpc-primary', false, 30);
      metrics.recordNotification('delivered');
      expect(metrics.renderPrometheus()).toContain('mintbot_endpoint_requests_total');
      expect(metrics.renderPrometheus()).toContain('mintbot_notification_delivery_total');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('sends Telegram outbound messages only through the injected secret-store reader', async () => {
    let requestedUrl = '';
    let requestedBody = '';
    const store: HostSecretStore = { has: (name) => name === 'TG_BOT_TOKEN' || name === 'TG_CHAT_ID', get: (name) => name === 'TG_BOT_TOKEN' ? 'test-token-not-for-output' : name === 'TG_CHAT_ID' ? '-100123' : undefined };
    const fetcher: TelegramFetcher = async (url, init) => {
      requestedUrl = url;
      requestedBody = init?.body ?? '';
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const notifier = new TelegramNotifier({ secretStore: store, apiBaseUrl: 'http://127.0.0.1:9', approvedProxy: 'http://127.0.0.1:9', fetcher });
    await notifier.send({ eventId: 'event-1', type: 'started', text: 'safe status' });
    expect(requestedUrl).toContain('/bottest-token-not-for-output/sendMessage');
    expect(requestedBody).toContain('-100123');
    expect(requestedBody).not.toContain('test-token-not-for-output');
    expect(await notifier.health()).toEqual({ status: 'ok', provider: 'telegram' });
    expect(() => new TelegramNotifier({ secretStore: store, apiBaseUrl: 'http://external.invalid', fetcher })).toThrow('TELEGRAM_HTTPS_OR_APPROVED_PROXY_REQUIRED');
  });

  it('deduplicates and retries notifications while redacting persisted text', async () => {
    const store = new DurableStore();
    await store.open();
    await store.transaction((state) => { state.events.push({ id: 'event-1', type: 'run_started', runId: 'run-1', at: new Date().toISOString(), data: {} }); });
    let sends = 0;
    const sink: NotificationSink = { send: async () => { sends += 1; if (sends === 1) throw new Error('temporary provider error'); } };
    let now = new Date('2026-01-01T00:00:00.000Z');
    const dispatcher = new NotificationDispatcher(store, sink, { now: () => now, retryBaseMs: 1_000, retryMaxMs: 1_000 });
    await expect(dispatcher.dispatch('event-1', 'provider value 0x' + 'a'.repeat(64))).rejects.toThrow('temporary provider error');
    now = new Date('2026-01-01T00:00:01.001Z');
    await dispatcher.dispatch('event-1', 'ignored retry text');
    const item = store.snapshot().notificationOutbox[0];
    expect(sends).toBe(2);
    expect(item?.state).toBe('delivered');
    expect(item?.text).not.toContain('0x' + 'a'.repeat(64));
    await Promise.all([dispatcher.dispatch('event-1', 'duplicate-a'), dispatcher.dispatch('event-1', 'duplicate-b')]);
    expect(sends).toBe(2);
  });

  it('groups reminders and emits immediate kill alerts with durable dedupe', async () => {
    const store = new DurableStore();
    await store.open();
    const delivered: string[] = [];
    const dispatcher = new NotificationDispatcher(store, { send: async ({ text }) => { delivered.push(text); } });
    const alerts = new AlertManager(store, dispatcher, undefined, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    await alerts.started('run-1', 2);
    await alerts.started('run-1', 2);
    await alerts.flush();
    await alerts.kill('operator stop', 'run-1');
    await alerts.kill('operator stop', 'run-1');
    expect(store.snapshot().events.filter((event) => event.type === 'alert_started')).toHaveLength(1);
    expect(store.snapshot().events.filter((event) => event.type === 'alert_kill')).toHaveLength(1);
    expect(delivered).toHaveLength(2);
  });

  it('a sent mint is told at once as a "mint submitted" card with its explorer link, once per transaction (T-086)', async () => {
    const store = new DurableStore();
    await store.open();
    const delivered: string[] = [];
    const dispatcher = new NotificationDispatcher(store, { send: async ({ text }) => { delivered.push(text); } });
    const alerts = new AlertManager(store, dispatcher, undefined, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const first = { chainId: 4663, collection: '0x21d0…3383', wallet: '0x365952eb1e8209bf2bcc2db5ed213111a87d061e', quantity: 1, hash: `0x${'a'.repeat(64)}` };
    await alerts.sent('run_1', first);
    await alerts.sent('run_1', first);
    await alerts.sent('run_1', { ...first, hash: `0x${'b'.repeat(64)}` });
    const events = store.snapshot().events.filter((event) => event.type === 'alert_sent');
    expect(events).toHaveLength(2);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain('MINT SUBMITTED');
    expect(delivered[0]).not.toContain('a'.repeat(64));
    expect(JSON.stringify(events[0]!.data['system'])).toContain('txLinks');
  });

  it('a stopped live request is told every time, even for the same reason, while a repeat of the same occurrence is still ignored', async () => {
    const store = new DurableStore();
    await store.open();
    const delivered: string[] = [];
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const dispatcher = new NotificationDispatcher(store, { send: async ({ text }) => { delivered.push(text); } });
    const alerts = new AlertManager(store, dispatcher, undefined, { now: () => new Date(clock) });
    // Two requests stopped at arm for the same reason: neither has a run, so only their occurrence tells them apart.
    await alerts.blocked('READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED', undefined, 'live_request_1');
    clock += 60_000;
    await alerts.blocked('READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED', undefined, 'live_request_2');
    await alerts.blocked('READINESS_REFRESH_FAILED:FUNDING_NOT_ARRIVED', undefined, 'live_request_2');
    expect(store.snapshot().events.filter((event) => event.type === 'alert_blocked')).toHaveLength(2);
    expect(delivered).toHaveLength(2);
    // Without an occurrence (a run-less alert of any other source) the earlier de-duplication is unchanged.
    await alerts.blocked('SOME_OTHER_REASON');
    await alerts.blocked('SOME_OTHER_REASON');
    expect(store.snapshot().events.filter((event) => event.type === 'alert_blocked')).toHaveLength(3);
  });

  it('reconciles before executing a scheduled dry-run job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-orchestrator-'));
    try {
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => {
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } };
        state.runs.push({ id: 'run-1', intentId: 'intent-1', campaignId: 'campaign-1', mode: 'dry-run', requestDigest: 'digest', state: 'Armed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      });
      let reconciliations = 0;
      const application = { command: async () => ({ id: 'run-1', state: 'Completed', nextAction: 'Inspect', createdAt: new Date().toISOString(), retryable: false }) } as unknown as BackendApplication;
      const jobs = new JsonJobStore(join(root, 'jobs.json'));
      const orchestrator = new OrchestratorService(store, application, { start: async () => { reconciliations += 1; }, reconcile: async () => undefined, kill: async () => undefined }, { jobs, schedulerIntervalMs: 100, reconciliationIntervalMs: 500, maxConcurrentJobs: 1, dryRunOnly: true, now: () => new Date('2026-01-01T00:00:01.000Z'), logger: new RedactedLogger({ stdout: false }) });
      await jobs.open();
      await orchestrator.schedule({ id: 'job-1', runId: 'run-1', wallets: ['wallet-1'], executeAt: '2026-01-01T00:00:00.000Z', mode: 'dry-run' });
      await orchestrator.start();
      await wait(20);
      expect(reconciliations).toBe(1);
      expect((await jobs.list())[0]?.state).toBe('succeeded');
      await orchestrator.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks scheduling when backup evidence is future-dated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-backup-status-'));
    try {
      const statusPath = join(root, 'status.json');
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2026-01-02T00:00:00.000Z' }));
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => {
        state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } };
      });
      const jobs = new JsonJobStore(join(root, 'jobs.json'));
      const orchestrator = new OrchestratorService(store, {} as BackendApplication, { start: async () => undefined, reconcile: async () => undefined }, { jobs, dryRunOnly: true, backupStatusPath: statusPath, now: () => new Date('2026-01-01T00:00:00.000Z'), logger: new RedactedLogger({ stdout: false }) });
      await orchestrator.start();
      expect(store.snapshot().runtime.blockingReasons).toContain('BACKUP_NOT_READY');
      await orchestrator.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a remotely retrieved off-host backup when the production profile says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-offhost-status-'));
    try {
      const statusPath = join(root, 'status.json');
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2026-01-01T00:00:00.000Z', restoreVerified: true, offHost: false, remoteVerified: false }));
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } }; });
      const jobs = new JsonJobStore(join(root, 'jobs.json'));
      const orchestrator = new OrchestratorService(store, {} as BackendApplication, { start: async () => undefined, reconcile: async () => undefined }, { jobs, dryRunOnly: true, backupStatusPath: statusPath, requireOffHostBackup: true, now: () => new Date('2026-01-01T00:01:00.000Z'), logger: new RedactedLogger({ stdout: false }) });
      await orchestrator.start();
      expect(store.snapshot().runtime.blockingReasons).toContain('BACKUP_NOT_READY');
      await orchestrator.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('expires production off-host evidence after eight hours and recovers after a fresh verified backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-offhost-freshness-'));
    try {
      const statusPath = join(root, 'status.json');
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2025-12-31T15:00:00.000Z', offHost: true, remoteVerified: true }));
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } }; });
      const jobs = new JsonJobStore(join(root, 'jobs.json'));
      const orchestrator = new OrchestratorService(store, {} as BackendApplication, { start: async () => undefined, reconcile: async () => undefined }, { jobs, dryRunOnly: true, backupStatusPath: statusPath, requireOffHostBackup: true, now: () => new Date('2026-01-01T00:00:00.000Z'), logger: new RedactedLogger({ stdout: false }) });
      await orchestrator.start();
      expect(store.snapshot().runtime.blockingReasons).toContain('BACKUP_NOT_READY');
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2025-12-31T23:59:00.000Z', offHost: true, remoteVerified: true }));
      await orchestrator.tick();
      expect(store.snapshot().runtime.startupState).toBe('Ready');
      expect(store.snapshot().runtime.blockingReasons).not.toContain('BACKUP_NOT_READY');
      await orchestrator.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('the backup readiness flag follows the backup status check (T-070)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mintbot-backup-flag-'));
    try {
      const statusPath = join(root, 'status.json');
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2025-12-31T15:00:00.000Z', offHost: true, remoteVerified: true }));
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => { state.runtime = { startupState: 'Ready', blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true } }; });
      const orchestrator = new OrchestratorService(store, {} as BackendApplication, { start: async () => undefined, reconcile: async () => undefined }, { jobs: new JsonJobStore(join(root, 'jobs.json')), dryRunOnly: true, backupStatusPath: statusPath, requireOffHostBackup: true, now: () => new Date('2026-01-01T00:00:00.000Z'), logger: new RedactedLogger({ stdout: false }) });
      await orchestrator.start();
      expect(store.snapshot().runtime.dependencies.backup).toBe(false);
      await writeFile(statusPath, JSON.stringify({ status: 'ok', recordedAt: '2025-12-31T23:59:00.000Z', offHost: true, remoteVerified: true }));
      await orchestrator.tick();
      expect(store.snapshot().runtime.dependencies.backup).toBe(true);
      await writeFile(statusPath, JSON.stringify({ status: 'failed', recordedAt: '2025-12-31T23:59:30.000Z' }));
      await orchestrator.tick();
      expect(store.snapshot().runtime.dependencies.backup).toBe(false);
      await orchestrator.stop();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  describe('releasing the kill file (T-060)', () => {
    const setup = async (initial: { killed?: boolean; reasons?: string[]; activeRun?: boolean; staleKillReads?: boolean } = {}) => {
      const root = await mkdtemp(join(tmpdir(), 'mintbot-kill-release-'));
      const store = new DurableStore();
      await store.open();
      await store.transaction((state) => {
        state.runtime = { startupState: 'Ready', blockingReasons: [...(initial.reasons ?? [])], dependencies: { engine: true, chain: true, backup: true, notifications: true } };
        if (initial.killed) state.killed = true;
        if (initial.activeRun) state.runs.push({ id: 'run_interrupted', intentId: 'intent', campaignId: 'cmp', mode: 'live', requestDigest: 'd', state: 'Active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
      });
      let killFile = true;
      const probes: boolean[] = [];
      // A kill that lands after the service's own reads: those reads see none, only the transaction (on the real store) sees it.
      const seen = initial.staleKillReads ? new Proxy(store, { get: (target, key) => { if (key === 'snapshot') return () => ({ ...target.snapshot(), killed: false }); const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value; } }) : store;
      const orchestrator = new OrchestratorService(seen, {} as BackendApplication, { start: async () => undefined, reconcile: async () => undefined }, { jobs: new JsonJobStore(join(root, 'jobs.json')), dryRunOnly: true, killSwitchProbe: async () => { const value = probes.length > 0 ? probes.shift()! : killFile; return value; }, logger: new RedactedLogger({ stdout: false }) });
      return { root, store, orchestrator, release: () => { killFile = false; }, nextProbes: (...values: boolean[]) => { probes.push(...values); } };
    };

    it('an unresolved run the kill interrupted keeps it Blocked after the file is removed (fail closed)', async () => {
      const { root, store, orchestrator, release } = await setup({ activeRun: true });
      try {
        await orchestrator.start();
        await orchestrator.tick();
        release();
        await orchestrator.tick();
        expect(store.snapshot().runtime).toMatchObject({ startupState: 'Blocked', blockingReasons: ['UNRESOLVED_EXECUTIONS'] });
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('a kill command that lands after the file check keeps the block (fail closed)', async () => {
      const { root, store, orchestrator, release } = await setup({ staleKillReads: true });
      try {
        await orchestrator.start();
        await orchestrator.tick();
        release();
        await store.transaction((state) => { state.killed = true; });
        await orchestrator.tick();
        expect(store.snapshot().runtime.blockingReasons).toContain('KILL_SWITCH_ENGAGED');
        expect(store.snapshot().runtime.startupState).toBe('Blocked');
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('a kill file created again while the block is lifted blocks at once (fail closed)', async () => {
      const { root, store, orchestrator, release, nextProbes } = await setup();
      try {
        await orchestrator.start();
        await orchestrator.tick();
        release();
        nextProbes(false, true);
        await orchestrator.tick();
        expect(store.snapshot().runtime).toMatchObject({ startupState: 'Blocked', blockingReasons: ['KILL_SWITCH_ENGAGED'] });
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('stays Blocked while the kill file exists, and is Ready again once the owner removes it', async () => {
      const { root, store, orchestrator, release } = await setup();
      try {
        await orchestrator.start();
        await orchestrator.tick();
        expect(store.snapshot().runtime).toMatchObject({ startupState: 'Blocked', blockingReasons: ['KILL_SWITCH_ENGAGED'] });
        release();
        await orchestrator.tick();
        expect(store.snapshot().runtime).toMatchObject({ startupState: 'Ready', blockingReasons: [] });
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('stays Blocked after the file is removed while a kill command is in force (fail closed)', async () => {
      const { root, store, orchestrator, release } = await setup({ killed: true });
      try {
        await orchestrator.start();
        release();
        await orchestrator.tick();
        await orchestrator.tick();
        expect(store.snapshot().runtime.startupState).toBe('Blocked');
        expect(store.snapshot().runtime.blockingReasons).toContain('KILL_SWITCH_ENGAGED');
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('keeps any other blocking reason after the file is removed (fail closed)', async () => {
      const { root, store, orchestrator, release } = await setup({ reasons: ['RECONCILIATION_FAILED'] });
      try {
        await orchestrator.start();
        await orchestrator.tick();
        release();
        await orchestrator.tick();
        expect(store.snapshot().runtime.startupState).toBe('Blocked');
        expect(store.snapshot().runtime.blockingReasons).toEqual(['RECONCILIATION_FAILED']);
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('lifts a stale UNRESOLVED_EXECUTIONS block once no run is unresolved (D-072), and only that reason', async () => {
      const { root, store, orchestrator, release } = await setup({ reasons: ['UNRESOLVED_EXECUTIONS'] });
      try {
        await orchestrator.start();
        await orchestrator.tick();
        release();
        await orchestrator.tick();
        expect(store.snapshot().runtime).toMatchObject({ startupState: 'Ready', blockingReasons: [] });
        await orchestrator.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('keeps UNRESOLVED_EXECUTIONS while a run really is unresolved, or another reason or the kill command remains (fail closed)', async () => {
      const running = await setup({ reasons: ['UNRESOLVED_EXECUTIONS'], activeRun: true });
      const other = await setup({ reasons: ['UNRESOLVED_EXECUTIONS', 'RECONCILIATION_FAILED'] });
      const killed = await setup({ reasons: ['UNRESOLVED_EXECUTIONS'], killed: true });
      try {
        for (const item of [running, other, killed]) { await item.orchestrator.start(); item.release(); await item.orchestrator.tick(); await item.orchestrator.tick(); }
        expect(running.store.snapshot().runtime.startupState).toBe('Blocked');
        expect(running.store.snapshot().runtime.blockingReasons).toContain('UNRESOLVED_EXECUTIONS');
        expect(other.store.snapshot().runtime.startupState).toBe('Blocked');
        expect(other.store.snapshot().runtime.blockingReasons).toEqual(['RECONCILIATION_FAILED']);
        expect(killed.store.snapshot().runtime.startupState).toBe('Blocked');
        expect(killed.store.snapshot().runtime.blockingReasons).toContain('UNRESOLVED_EXECUTIONS');
        for (const item of [running, other, killed]) await item.orchestrator.stop();
      } finally { await Promise.all([running, other, killed].map((item) => rm(item.root, { recursive: true, force: true }))); }
    });
  });
});
