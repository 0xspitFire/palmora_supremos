import type { DiscoveryLiveness } from './discovery-liveness.js';
import type { DiscoveryTickResult, RedactedLogger } from '@mint-bot/backend';
import { scanProblemCode } from './scan-tracker.js';

/** Secondary-chain discovery is read-only. Each tick is bounded by DiscoveryService's slice limit. */
export function startChainDiscovery(options: {
  liveness?:DiscoveryLiveness;
  chainId: 8453 | 4663;
  intervalMs: number;
  tick(): Promise<DiscoveryTickResult>;
  logger: Pick<RedactedLogger, 'info' | 'warn'>;
  notify?(text: string, dedupe: string): Promise<unknown>;
  now?: () => number;
}): { stop(): Promise<void> } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) throw new Error('DISCOVERY_INTERVAL_INVALID');
  // Observed Robinhood blocks arrive about ten times per second. Ethereum's two-minute
  // default leaves >1,200 new blocks between ticks, triggering the lag policy repeatedly.
  const intervalMs = options.chainId === 4663 ? Math.min(options.intervalMs, 15_000) : options.intervalMs;
  const now = options.now ?? Date.now;
  options.liveness?.start(options.chainId);
  const log = (level: 'info' | 'warn', fields: Record<string, unknown>, message: string): void => {
    try { options.logger[level](fields, message); }
    catch { /* A full log disk must not strand the completion-driven scanner. */ }
  };
  let stopped = false;
  const notices = new Set<Promise<unknown>>();
  const notify = (text: string, dedupe: string): void => {
    if (stopped) return;
    try {
      const notice = Promise.resolve(options.notify?.(text, dedupe)).catch(() => undefined);
      notices.add(notice);
      void notice.finally(() => notices.delete(notice));
    } catch { /* Diagnostics cannot strand discovery. */ }
  };
  let active:Promise<void>|undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failedSince: number | undefined;
  let lastNotice: number | undefined;
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void run(); }, delay);
    timer.unref();
  };
  const perform = async (): Promise<void> => {
    const started = now();options.liveness?.begin(options.chainId);
    let delay = intervalMs;
    let failed = false;
    try {
      const result = await options.tick();options.liveness?.complete(options.chainId,result);
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
      options.liveness?.fail(options.chainId);
      if (stopped) return;
      failed = true;
      log('warn', { event: 'replication_discovery_unavailable', chainId: options.chainId, durationMs: now() - started, code: 'SCAN_FAILED' }, 'replication discovery unavailable');
    }
    if (failed) {
      failedSince ??= now();
      if (now() - failedSince >= 5 * 60_000 && (lastNotice === undefined || now() - lastNotice >= 15 * 60_000)) {
        lastNotice = now();
        const chain = options.chainId === 4663 ? 'Robinhood' : 'Base';
        notify(`${chain} discovery has not completed a scan for at least five minutes. Check RPC health and the chain discovery logs; skipped blocks are not successful scans.`, `discovery-stalled:${options.chainId}:${Math.floor(now() / (15 * 60_000))}`);
      }
    }
    schedule(delay);
  };
  const run=():Promise<void>=>{if(active)return active;const operation=perform();active=operation.finally(()=>{active=undefined;});return active;};
  schedule(0);
  const watchdog=setInterval(()=>{if(stopped)return;const state=options.liveness?.snapshot().chains.find(row=>row.chainId===options.chainId);if(state?.state==='stalled'){log('warn',{event:'replication_discovery_stalled',chainId:options.chainId,operation:state.operation??null,activeSince:state.activeSince??null,lastSuccessAt:state.lastSuccessAt??null},'discovery scan remains incomplete');if(lastNotice===undefined||now()-lastNotice>=15*60000){lastNotice=now();notify(`${options.chainId===4663?'Robinhood':'Base'} discovery is stalled. Mint readiness does not mean fresh discovery coverage. Check RPC health and discovery read deadlines.`,`discovery-stalled:${options.chainId}:${Math.floor(now()/(15*60000))}`);}}},60000);watchdog.unref();
  return { async stop(): Promise<void> { stopped = true; clearInterval(watchdog);if (timer !== undefined) clearTimeout(timer);await active; await Promise.allSettled([...notices]); } };
}
