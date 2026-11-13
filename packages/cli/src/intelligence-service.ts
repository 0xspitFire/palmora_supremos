import { createHash } from 'node:crypto';
import { checkInCounts, checkInMessage, startMessage } from './status-messages.js';
import { ScanTracker } from './scan-tracker.js';
import { readHeartbeat, writeHeartbeat } from './heartbeat.js';
import type { MonitorPing } from './monitor-ping.js';
import { CollectionNames, D033_READINESS_LIMITS, DiscoveryService, HealthMonitor, PauseWatch, ReadinessSweep, buildSystemCard, pauseCard, scanSkippedCard, plainSystemText, type AdvancedIntelligencePort, type HistoricalQualityPort, type AdaptiveModelPort, type AlertManager, type HealthSample, type SystemCard, type BackendStore, type IntelligenceChainPort, type IntelligenceRepositoryPort, type RedactedLogger } from '@mint-bot/backend';

export interface IntelligenceServiceOptions {
  advanced?: AdvancedIntelligencePort;
  history?: HistoricalQualityPort;
  adaptive?: AdaptiveModelPort;
  store: BackendStore;
  repo: IntelligenceRepositoryPort;
  port: IntelligenceChainPort;
  alerts: AlertManager;
  wallets: readonly string[];
  /** Refreshed production custody addresses per sweep; the fixed list remains a test/local fallback. */
  walletProvider?: () => Promise<readonly string[]>;
  logger?: RedactedLogger;
  discoveryIntervalMs: number;
  /** Jump the scan ahead when it is more than this many blocks behind (default 1200). */
  discoveryMaxLagBlocks?: number;
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
  const discovery = new DiscoveryService(options.store, options.repo, options.port, { budgetPerNftWei: D033_READINESS_LIMITS.paidMaxPricePerNftWei, alerts: options.alerts, names, advanced: options.advanced, history: options.history, adaptive: options.adaptive, ...(options.discoveryMaxLagBlocks === undefined ? {} : { maxLagBlocks: BigInt(options.discoveryMaxLagBlocks) }) });
  const readiness = new ReadinessSweep(options.store, options.port, options.walletProvider ?? (async () => options.wallets), { limits: D033_READINESS_LIMITS, alerts: options.alerts, names,  now: options.now });
  const busy = { discovery: false, readiness: false, digest: false, retry: false, health: false };
  const guarded = (name: keyof typeof busy, work: () => Promise<unknown>) => async (): Promise<void> => {
    if (busy[name]) return;
    busy[name] = true;
    const startedMs = Date.now();
    try {
      const result = await work();
      // durationMs shows which tick is slow (a scan that takes minutes points at the node provider or a starved process).
      options.logger?.info({ event: `intelligence_${name}`, durationMs: Date.now() - startedMs, result: summarize(result) }, `intelligence ${name} tick`);
    } catch (error) {
      options.logger?.warn({ event: `intelligence_${name}_failed`, durationMs: Date.now() - startedMs, error }, `intelligence ${name} failed`);
    } finally { busy[name] = false; }
  };
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const tracker = new ScanTracker(startedAt);
  type SkipChain = 1 | 8453 | 4663 | 'unknown';
  type SkippedRange = { fromBlock: string; toBlock: string; blocks: string; at: string; chainId: SkipChain };
  const SKIP_NOTICE_INTERVAL_MS = 15 * 60_000;
  const SKIP_SOURCE_HORIZON_MS = 24 * 60 * 60_000;
  const MAX_SKIP_NOTICE_RANGES = 1_000;
  const pendingSkips = new Map<string, SkippedRange>();
  const coveredSkips = new Set<string>();
  const lastSkipNoticeAt = new Map<SkipChain, number>();
  let lastSkipJournalReadAt: number | undefined;
  let skipNoticeBusy = false;
  const skipKey = (chain: SkipChain, from: string, to: string): string => `${chain}:${from}:${to}`;
  const validSkipChain = (chain: unknown): chain is SkipChain => chain === 1 || chain === 8453 || chain === 4663 || chain === 'unknown';
  const validRange = (value: { fromBlock?: unknown; toBlock?: unknown; blocks?: unknown }): value is { fromBlock: string; toBlock: string; blocks: string; chainId?: unknown } => {
    const fields = [value.fromBlock, value.toBlock, value.blocks];
    if (!fields.every(field => typeof field === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(field))) return false;
    return BigInt(value.toBlock as string) >= BigInt(value.fromBlock as string)
      && BigInt(value.blocks as string) === BigInt(value.toBlock as string) - BigInt(value.fromBlock as string) + 1n;
  };
  const loadSkipJournal = (): void => {
    const journalNow = now().getTime();
    const snapshot = options.store.snapshot();
    // Rebuild, rather than accumulate, the rolling coverage window. Long-lived
    // processes must not retain every range identity ever announced.
    coveredSkips.clear();
    lastSkipNoticeAt.clear();
    const legacy = new Set(snapshot.events.filter(event => event.type === 'alert_health' && typeof event.data.dedupe === 'string')
      .map(event => String(event.data.dedupe)));
    for (const event of snapshot.events) {
      if (!['discovery_skip_notice', 'discovery_skip_notice_plan'].includes(event.type) || !validSkipChain(event.data.chainId)) continue;
      const chain = event.data.chainId;
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at > journalNow || journalNow - at > SKIP_SOURCE_HORIZON_MS) continue;
      if (event.type === 'discovery_skip_notice_plan' && !legacy.has(String(event.data.alertDedupe))) continue;
      for (const key of Array.isArray(event.data.rangeKeys) ? event.data.rangeKeys : []) if (typeof key === 'string') coveredSkips.add(key);
      if (journalNow - at < SKIP_NOTICE_INTERVAL_MS) lastSkipNoticeAt.set(chain, Math.max(lastSkipNoticeAt.get(chain) ?? at, at));
    }
    for (const event of snapshot.events) {
      if (event.type !== 'discovery_skipped' || !validRange(event.data)) continue;
      const at = Date.parse(event.at);
      // Preserve the original recovery horizon: old, future-dated or malformed
      // audit records remain retained, but are not announced as current news.
      if (!Number.isFinite(at) || at > journalNow || journalNow - at > SKIP_SOURCE_HORIZON_MS) continue;
      if (event.data.chainId !== undefined && ![1, 8453, 4663].includes(event.data.chainId as number)) continue;
      // Earlier discovery writers served multiple chains without recording the
      // chain. Do not infer Ethereum from the primary intelligence service.
      const chain: unknown = event.data.chainId === undefined ? 'unknown' : event.data.chainId;
      if (!validSkipChain(chain)) continue;
      const key = skipKey(chain, event.data.fromBlock, event.data.toBlock);
      // Preserve the old chain-less dedupe only for chain-less source records.
      if (chain === 'unknown' && legacy.has(`skip:${event.data.fromBlock}`)) coveredSkips.add(key);
      if (!coveredSkips.has(key)) pendingSkips.set(key, { ...event.data, at: event.at, chainId: chain } as SkippedRange);
    }
    for (const [key, range] of pendingSkips) {
      const at = Date.parse(range.at);
      if (coveredSkips.has(key) || !Number.isFinite(at) || at > journalNow || journalNow - at > SKIP_SOURCE_HORIZON_MS) pendingSkips.delete(key);
    }
    lastSkipJournalReadAt = journalNow;
  };
  const summaryCard = (ranges: readonly SkippedRange[], chain: SkipChain): SystemCard => {
    if (ranges.length === 1 && chain === 1) {
      const range = ranges[0]!;
      return scanSkippedCard({ blocks: BigInt(range.blocks), fromBlock: range.fromBlock, toBlock: range.toBlock, at: new Date(range.at) });
    }
    // Merge overlaps only for the count, never claim the whole bounding interval
    // was unread: there can be successfully scanned blocks between these ranges.
    const sorted = ranges.map(range => [BigInt(range.fromBlock), BigInt(range.toBlock)] as const).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const merged: Array<[bigint, bigint]> = [];
    for (const [from, to] of sorted) {
      const last = merged.at(-1);
      if (last && from <= last[1] + 1n) last[1] = to > last[1] ? to : last[1];
      else merged.push([from, to]);
    }
    const blocks = merged.reduce((sum, [from, to]) => sum + to - from + 1n, 0n);
    const examples = [...ranges].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
    const latest = examples[0]!;
    return buildSystemCard({
      title: 'SCAN JUMPED AHEAD', severity: 'attention',
      lines: [
        { label: 'Chain', value: chain === 'unknown' ? 'Not recorded in the legacy scan audit' : chain === 1 ? 'Ethereum' : chain === 8453 ? 'Base' : 'Robinhood' },
        { label: 'What happened', value: chain === 'unknown'
          ? `${ranges.length} recorded scan jumps are combined into this notice. Their block ranges may overlap or belong to different chains; a distinct-block total cannot be established.`
          : `${ranges.length} scan jumps are combined into this notice; ${blocks.toString()} distinct blocks were not read.`, strong: true },
        ...examples.map(range => ({ label: 'Skipped range', value: `blocks ${BigInt(range.fromBlock).toLocaleString('en-US')} to ${BigInt(range.toBlock).toLocaleString('en-US')} were not read.` })),
        { label: 'Coverage', value: `Only the recorded ranges were skipped; blocks between separate ranges are not included.${ranges.length > examples.length ? ` ${ranges.length - examples.length} additional ranges remain in the scan audit history.` : ''}` },
        { label: 'What it means', value: 'Mint and watched-wallet discovery in those ranges is incomplete. This notice does not change spending permissions or the kill switch.' },
      ],
      steps: ['If jumps continue, inspect scan duration and RPC errors. Keep the retained scan history for the exact ranges.'],
      dashboard: true, eventAt: latest.at, eventLabel: 'the latest recorded jump',
      summary: chain === 'unknown' ? `${ranges.length} scan jumps; chain was not recorded.` : `${ranges.length} scan jumps; ${blocks.toString()} distinct unread blocks.`,
    });
  };
  const announcePendingSkips = async (): Promise<void> => {
    if (skipNoticeBusy) return;
    skipNoticeBusy = true;
    try {
      const current = now().getTime();
      // Startup recovery is one bounded summary, not one immediate send per
      // retained jump. Re-read at most once per cooldown to repair a crash or an
      // exception between recording a jump and returning its tick result.
      if (lastSkipJournalReadAt === undefined || current - lastSkipJournalReadAt >= SKIP_NOTICE_INTERVAL_MS) loadSkipJournal();
      for (const chain of new Set([...pendingSkips.values()].map(range => range.chainId))) {
        const priorNotice = lastSkipNoticeAt.get(chain);
        if (priorNotice !== undefined && current - priorNotice >= 0 && current - priorNotice < SKIP_NOTICE_INTERVAL_MS) continue;
        // Bound both the card's represented scope and its durable plan/coverage
        // metadata. Remaining ranges stay pending for the next cooldown.
        const entries = [...pendingSkips.entries()].filter(([key, range]) => {
          const at = Date.parse(range.at);
          return range.chainId === chain && !coveredSkips.has(key) && Number.isFinite(at) && at <= current && current - at <= SKIP_SOURCE_HORIZON_MS;
        })
          .sort(([aKey, a], [bKey, b]) => a.at.localeCompare(b.at) || aKey.localeCompare(bKey)).slice(0, MAX_SKIP_NOTICE_RANGES);
        if (entries.length === 0) continue;
        const keys = entries.map(([key]) => key).sort();
        const dedupe = `skip-summary:${chain}:${createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 24)}`;
        const system = summaryCard(entries.map(([, range]) => range), chain);
        // This plan is not an acknowledgement. Recovery only treats its ranges as
        // represented if the matching durable alert exists, closing the crash
        // window before the final coverage marker without losing a failed send.
        await options.store.transaction(state => {
          if (!state.events.some(event => event.type === 'discovery_skip_notice_plan' && event.data.alertDedupe === dedupe)) {
            state.events.push({ id: `skip_plan_${createHash('sha256').update(dedupe).digest('hex').slice(0, 24)}`, type: 'discovery_skip_notice_plan', at: now().toISOString(), data: { chainId: chain, alertDedupe: dedupe, rangeKeys: keys } });
          }
        });
        let sent = false;
        try {
          sent = await options.alerts.intelligence({ kind: 'health', dedupe, text: plainSystemText(system), priority: 'immediate', system, at: now().toISOString() });
        } catch (error) { options.logger?.warn({ event: 'skip_message_failed', error }, 'skip summary delivery failed; durable outbox will retry'); }
        // A sink can fail after the alert is committed. Mark its ranges covered
        // only when that durable alert exists, leaving delivery to the outbox.
        if (!options.store.snapshot().events.some(event => event.type === 'alert_health' && event.data.dedupe === dedupe)) continue;
        for (const key of keys) { coveredSkips.add(key); pendingSkips.delete(key); }
        lastSkipNoticeAt.set(chain, current);
        await options.store.transaction(state => {
          if (!state.events.some(event => event.type === 'discovery_skip_notice' && event.data.alertDedupe === dedupe)) {
            state.events.push({ id: `skip_notice_${createHash('sha256').update(dedupe).digest('hex').slice(0, 24)}`, type: 'discovery_skip_notice', at: now().toISOString(), data: { chainId: chain, alertDedupe: dedupe, rangeKeys: keys, jumps: keys.length } });
          }
        });
        if (sent) options.logger?.warn({ event: 'discovery_skipped', jumps: keys.length, chainId: chain }, 'scan jumps summarized');
      }
    } catch (error) { options.logger?.warn({ event: 'skip_recheck_failed', error }, 'could not summarize scan jumps'); }
    finally { skipNoticeBusy = false; }
  };
  const runDiscovery = guarded('discovery', async () => {
    try {
      const result = await discovery.tick();
      tracker.record(result, now(), options.repo.cursor(1, 'seadrop-v1')?.toString());
      if (result.skipped && validRange(result.skipped)) {
        const key = skipKey(options.port.chainId, result.skipped.fromBlock, result.skipped.toBlock);
        if (!coveredSkips.has(key)) pendingSkips.set(key, { ...result.skipped, at: now().toISOString(), chainId: options.port.chainId });
      }
      await announcePendingSkips();
      return result;
    } catch (error) { tracker.recordFailure(now()); await announcePendingSkips(); throw error; }
  });
  const monitor = new HealthMonitor(options.alerts, { now, onError: (error) => options.logger?.warn({ event: 'health_message_failed', error }, 'health message failed') });
  const RETRY_WINDOW_MS = 6 * 60 * 60_000;
  const runHealth = guarded('health', async () => {
    const current = now();
    const host = options.sampleHost ? await options.sampleHost().catch(() => ({})) : {};
    const snapshot = options.store.snapshot();
    const failed = snapshot.notificationOutbox.filter((item) => item.state === 'failed' && current.getTime() - Date.parse(item.createdAt) <= RETRY_WINDOW_MS);
    const oldest = failed.map((item) => Date.parse(item.createdAt)).sort((left, right) => left - right)[0];
    const stalePending = snapshot.reservations.filter((item) => {
      if (item.status !== 'reserved') return false;
      const created = Date.parse(item.createdAt);
      return !Number.isFinite(created) || current.getTime() - created >= 24 * 60 * 60_000;
    });
    const oldestPending = stalePending.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite).sort((left, right) => left - right)[0];
    return monitor.check({
      now: current,
      scan: { startedAt, ...(tracker.lastOkAt ? { lastOkAt: tracker.lastOkAt } : {}), ...(tracker.lastOkBlock ? { lastOkBlock: tracker.lastOkBlock } : {}), ...(tracker.lastProblem ? { lastProblem: tracker.lastProblem } : {}) },
      endpoint: tracker.lastHour(current),
      delivery: { failed: failed.length, ...(oldest === undefined ? {} : { oldestFailedAt: new Date(oldest) }) },
      exposure: { stalePending: stalePending.length, ...(oldestPending === undefined ? {} : { oldestPendingAt: new Date(oldestPending) }) },
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
  let heartbeatBusy = false;
  const runHeartbeat = async (): Promise<void> => {
    const path = options.heartbeatPath;
    if (!path || heartbeatBusy) return;
    heartbeatBusy = true;
    try { await beatOnce(path); } finally { heartbeatBusy = false; }
  };
  const beatOnce = async (path: string): Promise<void> => {
    const current = now();
    if (!heartbeatReady) {
      heartbeatReady = true;
      const saved = await readHeartbeat(path);
      options.logger?.info({ event: 'heartbeat_loaded', savedAt: saved ? saved.toISOString() : null, gapMinutes: saved ? Math.round((current.getTime() - saved.getTime()) / 60_000) : null }, 'heartbeat loaded at start');
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
  void announcePendingSkips();
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
  const timers = [setInterval(() => void runDiscovery(), options.discoveryIntervalMs), setInterval(() => void runReadiness(), options.readinessIntervalMs), setInterval(() => void runDigest(), options.digestIntervalMs), setInterval(() => void runRetry(), options.digestIntervalMs), setInterval(() => void runCheckIn(), 60 * 60_000), setInterval(() => void runHealth(), options.healthIntervalMs ?? 5 * 60_000), setInterval(() => void runHeartbeat(), options.heartbeatIntervalMs ?? 30_000), setInterval(() => void runMonitor(), options.monitorIntervalMs ?? 60_000), setInterval(() => void announcePendingSkips(), SKIP_NOTICE_INTERVAL_MS)];
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
