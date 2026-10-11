import { checkInCounts, checkInMessage, startMessage } from './status-messages.js';
import { ScanTracker } from './scan-tracker.js';
import { readHeartbeat, writeHeartbeat } from './heartbeat.js';
import type { MonitorPing } from './monitor-ping.js';
import { CollectionNames, D033_READINESS_LIMITS, DiscoveryService, HealthMonitor, PauseWatch, ReadinessSweep, pauseCard, plainSystemText, type AlertManager, type HealthSample, type SystemCard, type BackendStore, type IntelligenceChainPort, type IntelligenceRepositoryPort, type RedactedLogger } from '@mint-bot/backend';

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
  /** Where to save the last time the service was alive; with it, a pause or stop is reported when the bot is back. */
  heartbeatPath?: string;
  /** How often the heartbeat is taken (default 30 s). A gap above `pauseMinMs` (default 5 min) is reported as a pause. */
  heartbeatIntervalMs?: number;
  pauseMinMs?: number;
  /** Signal sent to an outside monitor every minute: ok while chain scans work, fail when they have stalled. Silence is what the monitor alerts on. */
  monitorPing?: MonitorPing;
  monitorIntervalMs?: number;
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
  // Pause notice: a frozen bot cannot announce that it froze, so the message goes out as soon as the beats resume.
  const pauses = new PauseWatch(options.pauseMinMs ?? 5 * 60_000);
  let heartbeatReady = options.heartbeatPath === undefined;
  const runHeartbeat = async (): Promise<void> => {
    const path = options.heartbeatPath;
    if (!path) return;
    const current = now();
    if (!heartbeatReady) {
      heartbeatReady = true;
      const saved = await readHeartbeat(path);
      if (saved) pauses.beat(saved);
    }
    const span = pauses.beat(current);
    try { await writeHeartbeat(path, current); } catch (error) { options.logger?.warn({ event: 'heartbeat_write_failed', error }, 'heartbeat write failed'); }
    if (!span) return;
    options.logger?.warn({ event: 'bot_resumed_after_pause', from: span.from.toISOString(), to: span.to.toISOString(), minutes: Math.round(span.ms / 60_000) }, 'bot resumed after a pause');
    const block = options.repo.cursor(1, 'seadrop-v1')?.toString();
    const system = pauseCard({ from: span.from, to: span.to, ...(block ? { resumedBlock: block } : {}) });
    try { await options.alerts.intelligence({ kind: 'health', dedupe: `pause:${span.from.toISOString()}`, text: plainSystemText(system), priority: 'immediate', system, at: span.to.toISOString() }); }
    catch (error) { options.logger?.warn({ event: 'pause_message_failed', error }, 'pause message failed'); }
  };
  void runHeartbeat();
  // Outside monitor: 'ok' only while a chain scan worked within the last 15 minutes (start-up gets the same grace).
  let monitorWasOk: boolean | undefined;
  const runMonitor = async (): Promise<void> => {
    if (!options.monitorPing) return;
    const current = now();
    const healthy = current.getTime() - (tracker.lastOkAt ?? startedAt).getTime() < 15 * 60_000;
    try {
      await options.monitorPing(healthy ? 'ok' : 'fail');
      if (monitorWasOk !== healthy) options.logger?.info({ event: 'monitor_ping_state', status: healthy ? 'ok' : 'fail' }, 'monitor ping state changed');
      monitorWasOk = healthy;
    } catch (error) {
      options.logger?.warn({ event: 'monitor_ping_failed', reason: error instanceof Error ? error.message : 'unknown' }, 'monitor ping failed');
    }
  };
  void runMonitor();
  void sendStatus(`start:${startedAt.toISOString()}`, startMessage({ watched: options.repo.observedAddresses(1).length, ownWallets: options.wallets.length, startedAt, ...(options.startNumber !== undefined ? { startNumber: options.startNumber } : {}), ...(options.version ? { version: options.version } : {}) }));
  const timers = [setInterval(() => void runDiscovery(), options.discoveryIntervalMs), setInterval(() => void runReadiness(), options.readinessIntervalMs), setInterval(() => void runDigest(), options.digestIntervalMs), setInterval(() => void runRetry(), options.digestIntervalMs), setInterval(() => void runCheckIn(), 60 * 60_000), setInterval(() => void runHealth(), options.healthIntervalMs ?? 5 * 60_000), setInterval(() => void runHeartbeat(), options.heartbeatIntervalMs ?? 30_000), setInterval(() => void runMonitor(), options.monitorIntervalMs ?? 60_000)];
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
