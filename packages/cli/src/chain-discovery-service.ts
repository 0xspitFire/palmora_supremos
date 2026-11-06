import type { DiscoveryTickResult, RedactedLogger } from '@mint-bot/backend';
import { scanProblemCode } from './scan-tracker.js';

/** Secondary-chain discovery is read-only. Each tick is bounded by DiscoveryService's slice limit. */
export function startChainDiscovery(options: {
  chainId: 8453 | 4663;
  intervalMs: number;
  tick(): Promise<DiscoveryTickResult>;
  logger: Pick<RedactedLogger, 'info' | 'warn'>;
  notify?(text: string, dedupe: string): Promise<unknown>;
  now?: () => number;
}): { stop(): void } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) throw new Error('DISCOVERY_INTERVAL_INVALID');
  // Observed Robinhood blocks arrive about ten times per second. Ethereum's two-minute
  // default leaves >1,200 new blocks between ticks, triggering the lag policy repeatedly.
  const intervalMs = options.chainId === 4663 ? Math.min(options.intervalMs, 15_000) : options.intervalMs;
  const now = options.now ?? Date.now;
  const log = (level: 'info' | 'warn', fields: Record<string, unknown>, message: string): void => {
    try { options.logger[level](fields, message); }
    catch { /* A full log disk must not strand the completion-driven scanner. */ }
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failedSince: number | undefined;
  let lastNotice: number | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void run(); }, delay);
    timer.unref();
  };
  const run = async (): Promise<void> => {
    const started = now();
    let delay = intervalMs;
    let failed = false;
    try {
      const result = await options.tick();
      if (stopped) return;
      if (result.status === 'unavailable') {
        failed = true;
        // Never emit provider reason strings: nested errors may contain credentials.
        log('warn', { event: 'replication_discovery_unavailable', chainId: options.chainId, durationMs: now() - started, code: scanProblemCode(result.reason), scannedThrough: result.toBlock ?? null }, 'replication discovery unavailable');
      } else {
        failedSince = undefined;
        lastNotice = undefined;
        log('info', { event: 'replication_discovery', chainId: options.chainId, durationMs: now() - started, status: result.status, fromBlock: result.fromBlock ?? null, toBlock: result.toBlock ?? null, headBlock: result.headBlock ?? null, caughtUp: result.caughtUp === true, watchedPartial: result.watchedPartial === true, mintsObserved: result.mintsObserved, skippedBlocks: result.skipped?.blocks ?? '0' }, 'replication discovery tick');
        // Drain a bounded successful backlog without waiting another polling interval.
        // Missing progress/caughtUp metadata never creates a hot retry loop.
        if (result.status === 'ok' && result.caughtUp === false && result.fromBlock !== undefined && result.toBlock !== undefined) delay = 1_000;
      }
    } catch {
      if (stopped) return;
      failed = true;
      log('warn', { event: 'replication_discovery_unavailable', chainId: options.chainId, durationMs: now() - started, code: 'SCAN_FAILED' }, 'replication discovery unavailable');
    }
    if (failed) {
      failedSince ??= now();
      if (now() - failedSince >= 5 * 60_000 && (lastNotice === undefined || now() - lastNotice >= 15 * 60_000)) {
        lastNotice = now();
        const chain = options.chainId === 4663 ? 'Robinhood' : 'Base';
        try { void options.notify?.(`${chain} discovery has not completed a scan for at least five minutes. Check RPC health and the chain discovery logs; skipped blocks are not successful scans.`, `discovery-stalled:${options.chainId}:${Math.floor(now() / (15 * 60_000))}`)?.catch(() => undefined); }
        catch { /* notification transport cannot stall chain discovery */ }
      }
    }
    schedule(delay);
  };
  schedule(0);
  return { stop(): void { stopped = true; if (timer !== undefined) clearTimeout(timer); } };
}
