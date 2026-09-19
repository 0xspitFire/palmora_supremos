import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
    expect(config.requireStartupKillSwitch).toBe(false);
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
    const notifier = new TelegramNotifier({ secretStore: store, apiBaseUrl: 'http://127.0.0.1:9', fetcher });
    await notifier.send({ eventId: 'event-1', type: 'started', text: 'safe status' });
    expect(requestedUrl).toContain('/bottest-token-not-for-output/sendMessage');
    expect(requestedBody).toContain('-100123');
    expect(requestedBody).not.toContain('test-token-not-for-output');
    expect(await notifier.health()).toEqual({ status: 'ok', provider: 'telegram' });
  });

  it('deduplicates and retries notifications while redacting persisted text', async () => {
    const store = new DurableStore();
    await store.open();
    await store.transaction((state) => { state.events.push({ id: 'event-1', type: 'run_started', runId: 'run-1', at: new Date().toISOString(), data: {} }); });
    let sends = 0;
    const sink: NotificationSink = { send: async () => { sends += 1; if (sends === 1) throw new Error('temporary provider error'); } };
    const dispatcher = new NotificationDispatcher(store, sink);
    await expect(dispatcher.dispatch('event-1', 'provider value 0x' + 'a'.repeat(64))).rejects.toThrow('temporary provider error');
    await dispatcher.dispatch('event-1', 'ignored retry text');
    const item = store.snapshot().notificationOutbox[0];
    expect(sends).toBe(2);
    expect(item?.state).toBe('delivered');
    expect(item?.text).not.toContain('0x' + 'a'.repeat(64));
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
});
