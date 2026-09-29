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
  const timers = [setInterval(() => void runDiscovery(), options.discoveryIntervalMs), setInterval(() => void runReadiness(), options.readinessIntervalMs), setInterval(() => void runDigest(), options.digestIntervalMs)];
  for (const timer of timers) timer.unref();
  void runDiscovery().then(runReadiness);
  return {
    stop: () => { for (const timer of timers) clearInterval(timer); },
    runOnce: async () => { await runDiscovery(); await runReadiness(); await runDigest(); },
  };
}

function summarize(result: unknown): unknown {
  return typeof result === 'object' && result !== null ? JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)) : result;
}
