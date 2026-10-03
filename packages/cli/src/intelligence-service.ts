import { checkInCounts, checkInMessage, startMessage } from './status-messages.js';
import { ScanTracker } from './scan-tracker.js';
import { CollectionNames, D033_READINESS_LIMITS, DiscoveryService, HealthMonitor, ReadinessSweep, plainSystemText, type AlertManager, type HealthSample, type SystemCard, type BackendStore, type IntelligenceChainPort, type IntelligenceRepositoryPort, type RedactedLogger } from '@mint-bot/backend';

export interface IntelligenceServiceOptions {
  store: BackendStore;
  repo: IntelligenceRepositoryPort;
  port: IntelligenceChainPort;
  alerts: AlertManager;
  wallets: readonly string[];
  logger?: RedactedLogger;
  discoveryIntervalMs: number;
  readinessIntervalMs: number;
  digestIntervalMs: number;
  /** Number of this start, from the restart counter; shown in the start message. */
  startNumber?: number;
  /** Short code version, shown in the start message. */
  version?: string;
  /** Disk and backup facts for the health warnings; supplied by the host. Failing or absent means those two are not checked. */
  sampleHost?: () => Promise<Pick<HealthSample, 'disk' | 'backup'>>;
  healthIntervalMs?: number;
  now?: () => Date;
}

/**
 * Phase 2 intelligence timers (T-004, P2-09): discovery, readiness and alert digests.
 * Runs in dry-run mode because it only reads chain data and writes read-model events;
 * it never admits, signs, or sends anything.
 */
export function startIntelligence(options: IntelligenceServiceOptions): { stop(): void; runOnce(): Promise<void> } {
  // One reader for collection names, so a contract's name is read from the chain once for both services.
  const names = new CollectionNames(options.port);
  const discovery = new DiscoveryService(options.store, options.repo, options.port, { budgetPerNftWei: D033_READINESS_LIMITS.paidMaxPricePerNftWei, alerts: options.alerts, names });
  const readiness = new ReadinessSweep(options.store, options.port, async () => options.wallets, { limits: D033_READINESS_LIMITS, alerts: options.alerts, names });
  const busy = { discovery: false, readiness: false, digest: false, retry: false, health: false };
  const guarded = (name: keyof typeof busy, work: () => Promise<unknown>) => async (): Promise<void> => {
    if (busy[name]) return;
    busy[name] = true;
    try {
      const result = await work();
      options.logger?.info({ event: `intelligence_${name}`, result: summarize(result) }, `intelligence ${name} tick`);
    } catch (error) {
      options.logger?.warn({ event: `intelligence_${name}_failed`, error }, `intelligence ${name} failed`);
    } finally { busy[name] = false; }
  };
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const tracker = new ScanTracker(startedAt);
  const runDiscovery = guarded('discovery', async () => {
    try {
      const result = await discovery.tick();
      tracker.record(result, now(), options.repo.cursor(1, 'seadrop-v1')?.toString());
      return result;
    } catch (error) { tracker.recordFailure(now()); throw error; }
  });
  const monitor = new HealthMonitor(options.alerts, { now, onError: (error) => options.logger?.warn({ event: 'health_message_failed', error }, 'health message failed') });
  const RETRY_WINDOW_MS = 6 * 60 * 60_000;
  const runHealth = guarded('health', async () => {
    const current = now();
    const host = options.sampleHost ? await options.sampleHost().catch(() => ({})) : {};
    const failed = options.store.snapshot().notificationOutbox.filter((item) => item.state === 'failed' && current.getTime() - Date.parse(item.createdAt) <= RETRY_WINDOW_MS);
    const oldest = failed.map((item) => Date.parse(item.createdAt)).sort((left, right) => left - right)[0];
    return monitor.check({
      now: current,
      scan: { startedAt, ...(tracker.lastOkAt ? { lastOkAt: tracker.lastOkAt } : {}), ...(tracker.lastOkBlock ? { lastOkBlock: tracker.lastOkBlock } : {}), ...(tracker.lastProblem ? { lastProblem: tracker.lastProblem } : {}) },
      endpoint: tracker.lastHour(current),
      delivery: { failed: failed.length, ...(oldest === undefined ? {} : { oldestFailedAt: new Date(oldest) }) },
      ...host,
    });
  });
  const runReadiness = guarded('readiness', () => readiness.tick());
  const runDigest = guarded('digest', () => options.alerts.flushDigest());
  // Separate guard: a failing digest never skips retrying undelivered messages (T-011).
  const runRetry = guarded('retry', () => options.alerts.retryUndelivered());
  const sendStatus = async (dedupe: string, system: SystemCard): Promise<void> => {
    try { await options.alerts.intelligence({ kind: 'status', dedupe, text: plainSystemText(system), priority: 'immediate', system }); }
    catch (error) { options.logger?.warn({ event: 'status_message_failed', error }, 'status message failed'); }
  };
  // Daily check-in: once per UTC date, from 09:00 UTC, restart-safe through durable alert deduplication.
  const runCheckIn = async (): Promise<void> => {
    const current = now();
    if (current.getUTCHours() < 9 || current.getTime() - startedAt.getTime() < 60 * 60_000) return;
    const lastScanAt = tracker.lastOkAt ?? null;
    const scanStale = current.getTime() - (lastScanAt ?? startedAt).getTime() >= 15 * 60_000;
    await sendStatus(`checkin:${current.toISOString().slice(0, 10)}`, checkInMessage(checkInCounts(options.store, options.repo, current), { runningSince: startedAt, now: current, lastScanAt, scanStale }));
  };
  void sendStatus(`start:${startedAt.toISOString()}`, startMessage({ watched: options.repo.observedAddresses(1).length, ownWallets: options.wallets.length, startedAt, ...(options.startNumber !== undefined ? { startNumber: options.startNumber } : {}), ...(options.version ? { version: options.version } : {}) }));
  const timers = [setInterval(() => void runDiscovery(), options.discoveryIntervalMs), setInterval(() => void runReadiness(), options.readinessIntervalMs), setInterval(() => void runDigest(), options.digestIntervalMs), setInterval(() => void runRetry(), options.digestIntervalMs), setInterval(() => void runCheckIn(), 60 * 60_000), setInterval(() => void runHealth(), options.healthIntervalMs ?? 5 * 60_000)];
  for (const timer of timers) timer.unref();
  void runDiscovery().then(runReadiness);
  return {
    stop: () => { for (const timer of timers) clearInterval(timer); },
    runOnce: async () => { await runDiscovery(); await runReadiness(); await runDigest(); await runRetry(); await runHealth(); await runCheckIn(); },
  };
}

function summarize(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)) : result;
}
