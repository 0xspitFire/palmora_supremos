import { checkInCounts, checkInMessage, startMessage } from './status-messages.js';
import { D033_READINESS_LIMITS, DiscoveryService, ReadinessSweep, type AlertManager, type BackendStore, type IntelligenceChainPort, type IntelligenceRepositoryPort, type RedactedLogger } from '@mint-bot/backend';

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
  /** Where the owner opens the dashboard; shown in the start message. */
  dashboardUrl?: string;
  now?: () => Date;
}

/**
 * Phase 2 intelligence timers (T-004, P2-09): discovery, readiness and alert digests.
 * Runs in dry-run mode because it only reads chain data and writes read-model events;
 * it never admits, signs, or sends anything.
 */
export function startIntelligence(options: IntelligenceServiceOptions): { stop(): void; runOnce(): Promise<void> } {
  const discovery = new DiscoveryService(options.store, options.repo, options.port, { budgetPerNftWei: D033_READINESS_LIMITS.paidMaxPricePerNftWei, alerts: options.alerts });
  const readiness = new ReadinessSweep(options.store, options.port, async () => options.wallets, { limits: D033_READINESS_LIMITS, alerts: options.alerts });
  const busy = { discovery: false, readiness: false, digest: false };
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
  const runDiscovery = guarded('discovery', () => discovery.tick());
  const runReadiness = guarded('readiness', () => readiness.tick());
  const runDigest = guarded('digest', () => options.alerts.flushDigest());
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const sendStatus = async (dedupe: string, text: string): Promise<void> => {
    try { await options.alerts.intelligence({ kind: 'status', dedupe, text, priority: 'immediate' }); }
    catch (error) { options.logger?.warn({ event: 'status_message_failed', error }, 'status message failed'); }
  };
  // Daily check-in: once per UTC date, from 09:00 UTC, restart-safe through durable alert deduplication.
  const runCheckIn = async (): Promise<void> => {
    const current = now();
    if (current.getUTCHours() < 9 || current.getTime() - startedAt.getTime() < 60 * 60_000) return;
    await sendStatus(`checkin:${current.toISOString().slice(0, 10)}`, checkInMessage(checkInCounts(options.store, options.repo, current)));
  };
  void sendStatus(`start:${startedAt.toISOString()}`, startMessage({ watched: options.repo.observedAddresses(1).length, ownWallets: options.wallets.length, dashboardUrl: options.dashboardUrl ?? 'http://127.0.0.1:8780/' }));
  const timers = [setInterval(() => void runDiscovery(), options.discoveryIntervalMs), setInterval(() => void runReadiness(), options.readinessIntervalMs), setInterval(() => void runDigest(), options.digestIntervalMs), setInterval(() => void runCheckIn(), 60 * 60_000)];
  for (const timer of timers) timer.unref();
  void runDiscovery().then(runReadiness);
  return {
    stop: () => { for (const timer of timers) clearInterval(timer); },
    runOnce: async () => { await runDiscovery(); await runReadiness(); await runDigest(); await runCheckIn(); },
  };
}

function summarize(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)) : result;
}
