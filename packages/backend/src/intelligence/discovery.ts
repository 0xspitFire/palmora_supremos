import { randomUUID } from 'node:crypto';
import type { BackendStore } from '../store.js';
import type { EventRecord } from '../types.js';
import { calendarId, DISCOVERY_FRESHNESS_MS, opportunityId, validChainTime, type DropSnapshot, type IntelligenceAlertSink, type IntelligenceChainPort, type IntelligenceRepositoryPort } from './port.js';
import { scoreOpportunity, type ScoreResult } from './scoring.js';
import { parseAlertCard, plainAlertText } from '../alert-card.js';
import { CollectionNames } from './names.js';
import { openingSoonCard, opportunityCard, priceAboveLimitCard } from './cards.js';

/**
 * SeaDrop discovery (T-004, P2-02/P2-03/P2-06). Polls settled blocks, aggregates
 * public mints per contract, scores them, and keeps the on-chain calendar.
 *
 * Events are append-only and re-read on every snapshot, so they are written only
 * for a new item, a meaningful change, or a refresh just before the 15-minute
 * staleness window (D-015). Discovery never signs, sends, or admits execution.
 */
export interface DiscoveryOptions {
  now?: () => Date;
  /** Blocks to look back on the very first run (about one hour on Ethereum). */
  initialLookbackBlocks?: bigint;
  /** Scans per tick while catching up (default 8). */
  maxScansPerTick?: number;
  /**
   * If the scan is further behind the chain head than this many blocks (default 1200, about 4 hours), it jumps forward to the
   * look-back window instead of reading old blocks one slice at a time. An alert about a mint hours old is no use, and a slow host
   * would otherwise fall further behind every hour. The skipped range is recorded (event `discovery_skipped`) and reported.
   */
  maxLagBlocks?: bigint;
  /** Owner price limit per NFT (D-033). */
  budgetPerNftWei: bigint;
  alerts?: IntelligenceAlertSink;
  /** Collection names read from the chain; one reader can be shared with the readiness sweep. */
  names?: CollectionNames;
}

export interface DiscoveryTickResult {
  status: 'ok' | 'unavailable' | 'idle';
  reason?: string;
  /** Settled head captured at tick start; not transaction finality or mint permission. */
  headBlock?: string;
  /** True only after processing through that head; skipped cursor movement is not scanned coverage. */
  caughtUp?: boolean;
  fromBlock?: string;
  toBlock?: string;
  mintsObserved: number;
  opportunitiesWritten: number;
  calendarWritten: number;
  alertsRaised: number;
  /** Watched-wallet evidence was partly unavailable; SeaDrop results are still complete. */
  watchedPartial?: boolean;
  /** The scan was too far behind and jumped ahead: the first and last block it did not read, and how many. */
  skipped?: { fromBlock: string; toBlock: string; blocks: string };
}

interface Tracked {
  contract: string;
  firstSeenAt: number;
  lastActivityAt: number;
  mints: Array<{ at: number; quantity: number }>;
  totalMinted: number;
  /** Watched wallets that paid for their own SeaDrop mint (scored as convergence). */
  watched: Map<string, number>;
  /** Watched wallets that only received an NFT; shown as evidence, never scored, because anyone can send to them. */
  received: Map<string, number>;
  priceWei: bigint | null;
  drop: DropSnapshot | null;
  dropReadAt: number | null;
  hasCode: boolean | null;
  lastEmit: { at: number; score: number; band: string } | null;
}

interface CalendarItem { drop: DropSnapshot; lastEmit: { at: number; signature: string } | null; }

const SOURCE = 'seadrop-v1';
const HOUR = 60 * 60_000;
const CONVERGENCE_WINDOW_MS = 6 * HOUR;
const REFRESH_BEFORE_STALE_MS = 3 * 60_000;
const SCORE_CHANGE = 5;
const CALENDAR_HORIZON_MS = 30 * 24 * HOUR;
/** Bounds against chain-driven flooding: tracked items, calendar entries, remembered log identities and opening alerts per day. */
const MAX_TRACKED = 500;
const MAX_CALENDAR = 200;
const MAX_SEEN_LOGS = 100_000;
const MAX_OPENING_ALERTS_PER_DAY = 20;

export class DiscoveryService {
  private readonly tracked = new Map<string, Tracked>();
  private readonly calendar = new Map<string, CalendarItem>();
  private readonly seenLogs = new Set<string>();
  private readonly openingAlertTimes: number[] = [];
  /** At most one acknowledged price identity per calendar contract; durable alerts remain authoritative across restart. */
  private readonly priceAlertIdentities = new Map<string, string>();
  private readonly now: () => Date;
  private readonly names: CollectionNames;
  private restored = false;

  public constructor(private readonly store: BackendStore, private readonly repo: IntelligenceRepositoryPort, private readonly port: IntelligenceChainPort, private readonly options: DiscoveryOptions) {
    this.now = options.now ?? (() => new Date());
    this.names = options.names ?? new CollectionNames(port);
    if (options.budgetPerNftWei <= 0n) throw new Error('DISCOVERY_BUDGET_INVALID');
  }

  public async tick(): Promise<DiscoveryTickResult> {
    const result: DiscoveryTickResult = { status: 'idle', mintsObserved: 0, opportunitiesWritten: 0, calendarWritten: 0, alertsRaised: 0 };
    if (!this.restored) { this.restore(); this.restored = true; }
    const head = await this.port.safeHead();
    if (head === null) return { ...result, status: 'unavailable', reason: 'HEAD_UNAVAILABLE' };
    result.headBlock = head.toString();
    result.caughtUp = false;
    const chainId = this.port.chainId;
    // One consistent, read-only watch-list view for all scoring and labels in this tick.
    const watchedRows = this.repo.observedAddresses(chainId);
    const labels = new Map(watchedRows.map(row => [row.address.toLowerCase(), row.label] as const));
    const watched = [...labels.keys()];
    const watchedSet = new Set(watched);
    const cursor = this.repo.cursor(chainId, SOURCE);
    const lookback = this.options.initialLookbackBlocks ?? 300n;
    let from = cursor === undefined ? (head > lookback ? head - lookback : 0n) : cursor + 1n;
    // Too far behind: skip to the look-back window, durably (the cursor only moves forward), and say so.
    const maxLag = this.options.maxLagBlocks ?? 1200n;
    if (cursor !== undefined && head > cursor && head - cursor > maxLag && head > lookback) {
      const resume = head - lookback;
      if (resume > from) {
        const skipped = { fromBlock: from.toString(), toBlock: (resume - 1n).toString(), blocks: (resume - from).toString() };
        await this.store.transaction((state) => { state.events.push({ id: `evt_${randomUUID()}`, type: 'discovery_skipped', at: this.now().toISOString(), data: { ...skipped, chainId, headBlock: head.toString() } }); });
        this.repo.advanceCursor(chainId, SOURCE, resume - 1n);
        result.skipped = skipped;
        from = resume;
      }
    }
    const touched = new Set<string>();
    for (let scans = 0; scans < (this.options.maxScansPerTick ?? 8) && from <= head; scans += 1) {
      const outcome = await this.port.scan(from, head, watched);
      if (!outcome.ok) return { ...result, status: 'unavailable', reason: outcome.reason };
      const at = this.now().getTime();
      for (const mint of outcome.scan.mints) {
        if (!this.firstSighting('mint', mint)) continue;
        const item = this.track(mint.nftContract, at);
        const quantity = Number(mint.quantity > 10_000n ? 10_000n : mint.quantity);
        item.mints.push({ at, quantity });
        item.totalMinted += quantity;
        item.priceWei = mint.unitPriceWei;
        item.lastActivityAt = at;
        // Convergence counts only a watched wallet that paid for its own mint; a drop owner cannot forge the payer.
        if (watchedSet.has(mint.minter.toLowerCase()) && mint.minter.toLowerCase() === mint.payer.toLowerCase()) {
          item.watched.set(mint.minter.toLowerCase(), at);
          if (mint.txHash && /^0x[0-9a-fA-F]{64}$/.test(mint.txHash)) {
            const id = `watched_mint:${chainId}:${mint.txHash.toLowerCase()}:${mint.logIndex}`;
            await this.store.transaction((state) => { if (!state.events.some((event) => event.id === id)) state.events.push({ id, type: 'watched_wallet_mint', at: new Date(at).toISOString(), data: { chainId, contract: item.contract, wallet: mint.minter.toLowerCase(), txHash: mint.txHash, sourceBlock: mint.blockNumber.toString() } }); });
          }
        }
        touched.add(item.contract);
        result.mintsObserved += quantity;
      }
      for (const mint of outcome.scan.watchedMints) {
        if (!watchedSet.has(mint.recipient.toLowerCase()) || !this.firstSighting('watched', mint)) continue;
        const item = this.track(mint.nftContract, at);
        item.received.set(mint.recipient.toLowerCase(), at);
        touched.add(item.contract);
      }
      for (const update of outcome.scan.dropUpdates) {
        const contract = update.nftContract.toLowerCase();
        const drop = sanitizeDrop({ nftContract: contract, priceWei: update.mintPriceWei, startTime: update.startTime, endTime: update.endTime, maxPerWallet: update.maxPerWallet, maxSupply: null, totalMinted: null });
        if (!drop) continue;
        this.putCalendar(contract, drop);
        const item = this.tracked.get(contract);
        if (item) { item.drop = drop; item.dropReadAt = at; }
      }
      if (outcome.scan.watchedUnavailable) result.watchedPartial = true;
      result.fromBlock ??= outcome.scan.fromBlock.toString();
      result.toBlock = outcome.scan.toBlock.toString();
      from = outcome.scan.toBlock + 1n;
      await this.enrich(touched);
      // Refresh-only rewrites happen only when this scan reached the settled head, so a lagging scan never re-stamps freshness.
      const current = outcome.scan.toBlock >= head;
      result.opportunitiesWritten += await this.emitOpportunities(result, current, outcome.scan.toBlock, labels);
      result.calendarWritten += await this.emitCalendar(result, current, outcome.scan.toBlock);
      // The cursor moves only after this range's events are durable, so a crash replays rather than skips; replayed logs are not recounted.
      this.repo.advanceCursor(chainId, SOURCE, outcome.scan.toBlock);
    }
    if (result.toBlock === undefined) {
      result.opportunitiesWritten += await this.emitOpportunities(result, true, head, labels);
      result.calendarWritten += await this.emitCalendar(result, true, head);
    }
    this.prune();
    return { ...result, status: 'ok', caughtUp: from > head };
  }

  /** Rebuilds recent state from the last opportunity and calendar events, so a restart keeps convergence and refresh timing. */
  private restore(): void {
    const now = this.now().getTime();
    const latest = new Map<string, EventRecord>();
    const snapshot = this.store.snapshot().events;
    for (const event of snapshot) {
      if (event.type !== 'opportunity_scored' && event.type !== 'opportunity_notified' && event.type !== 'calendar_entry') continue;
      if (event.data.chainId !== this.port.chainId) continue;
      const contract = String(event.data.contract ?? '').toLowerCase();
      const at = Date.parse(event.at);
      if (!/^0x[0-9a-f]{40}$/.test(contract) || !Number.isFinite(at) || at > now) continue;
      // Scored and notified are dispositions of the same opportunity, not separate histories.
      const key = `${event.type === 'calendar_entry' ? 'calendar' : 'opportunity'}:${contract}`;
      const prior = latest.get(key);
      if (!prior || at >= Date.parse(prior.at)) latest.set(key, event);
    }
    for (const event of latest.values()) {
      const contract = String(event.data.contract).toLowerCase();
      const at = Date.parse(event.at);
      if (event.type === 'calendar_entry') {
        const drop = dropFromEvent(event, contract);
        if (drop && (drop.endTime === 0 || drop.endTime * 1000 > now)) this.putCalendar(contract, drop, { at, signature: dropSignature(drop) });
        continue;
      }
      const lastActivity = Date.parse(String(event.data.lastActivityAt ?? event.at));
      const firstSeen = Date.parse(String(event.data.firstSeenAt ?? event.at));
      if (!Number.isFinite(lastActivity) || lastActivity > at || now - lastActivity > CONVERGENCE_WINDOW_MS || !Number.isFinite(firstSeen) || firstSeen > lastActivity) continue;
      const watched = new Map<string, number>();
      // New records preserve each observation's own time. Legacy address-only lists are
      // restored only from their original durable self-mint event, never collection activity.
      const minters = new Set((Array.isArray(event.data.watchedMinters) ? event.data.watchedMinters : []).filter((address): address is string => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)).map(address => address.toLowerCase()));
      const remember = (address: unknown, observedAt: unknown): void => {
        if (typeof address !== 'string' || !minters.has(address.toLowerCase()) || typeof observedAt !== 'string') return;
        const observed = Date.parse(observedAt);
        if (!Number.isFinite(observed) || observed > at || observed > lastActivity || now - observed > CONVERGENCE_WINDOW_MS) return;
        const key = address.toLowerCase();
        if (observed > (watched.get(key) ?? -Infinity)) watched.set(key, observed);
      };
      if (Array.isArray(event.data.watchedMinterObservations)) {
        for (const row of event.data.watchedMinterObservations) if (row && typeof row === 'object') {
          const observation = row as Record<string, unknown>;
          remember(observation.wallet, observation.at);
        }
      } else {
        for (const source of snapshot) if (source.type === 'watched_wallet_mint' && source.data.chainId === this.port.chainId && typeof source.data.contract === 'string' && source.data.contract.toLowerCase() === contract) remember(source.data.wallet, source.at);
      }
      const mints: Tracked['mints'] = [];
      if (Array.isArray(event.data.mintActivity) && event.data.mintActivity.length <= 61) {
        for (const row of event.data.mintActivity) if (row && typeof row === 'object') {
          const activity = row as Record<string, unknown>;
          const observed = typeof activity.at === 'string' ? Date.parse(activity.at) : NaN;
          const quantity = activity.quantity;
          if (Number.isFinite(observed) && observed <= at && observed <= lastActivity && now - observed <= HOUR && typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity > 0) mints.push({ at: observed, quantity });
        }
      }
      this.tracked.set(contract, { contract, firstSeenAt: firstSeen, lastActivityAt: lastActivity, mints, totalMinted: Number(event.data.totalMinted ?? 0), watched, received: new Map(), priceWei: typeof event.data.priceWei === 'string' && /^\d+$/.test(event.data.priceWei) ? BigInt(event.data.priceWei) : null, drop: null, dropReadAt: null, hasCode: typeof event.data.hasCode === 'boolean' ? event.data.hasCode : null, lastEmit: { at, score: Number(event.data.score ?? 0), band: String(event.data.band ?? 'log') } });
    }
    for (const [contract, item] of this.tracked) item.drop = this.calendar.get(contract)?.drop ?? null;
  }

  private track(contractAddress: string, at: number): Tracked {
    const contract = contractAddress.toLowerCase();
    let item = this.tracked.get(contract);
    if (!item) {
      item = { contract, firstSeenAt: at, lastActivityAt: at, mints: [], totalMinted: 0, watched: new Map(), received: new Map(), priceWei: null, drop: this.calendar.get(contract)?.drop ?? null, dropReadAt: null, hasCode: null, lastEmit: null };
      this.tracked.set(contract, item);
      if (this.tracked.size > MAX_TRACKED) {
        const quietest = [...this.tracked.values()].filter((candidate) => candidate !== item).sort((left, right) => left.lastActivityAt - right.lastActivityAt)[0];
        if (quietest) this.tracked.delete(quietest.contract);
      }
    }
    return item;
  }

  private async enrich(contracts: ReadonlySet<string>): Promise<void> {
    const now = this.now().getTime();
    for (const contract of contracts) {
      const item = this.tracked.get(contract);
      if (!item) continue;
      if (item.hasCode === null) item.hasCode = await this.port.hasCode(contract);
      if (item.dropReadAt === null || now - item.dropReadAt > DISCOVERY_FRESHNESS_MS) {
        const raw = await this.port.readDrop(contract);
        const drop = raw ? sanitizeDrop(raw) : null;
        item.dropReadAt = now;
        if (drop) {
          item.drop = drop;
          if (item.priceWei === null) item.priceWei = drop.priceWei;
          this.putCalendar(contract, drop);
        }
      }
    }
  }

  private score(item: Tracked, now: number, watchingConfigured: boolean): ScoreResult {
    const watchedMinters = [...item.watched.values()].filter((at) => now - at <= CONVERGENCE_WINDOW_MS).length;
    const mintsLastHour = item.mints.filter((mint) => now - mint.at <= HOUR).reduce((total, mint) => total + mint.quantity, 0);
    return scoreOpportunity({ watchedMinters, watchingConfigured, priceWei: item.priceWei, budgetPerNftWei: this.options.budgetPerNftWei, knownSeaDropPattern: item.drop !== null, hasCode: item.hasCode, mintsLastHour, discoveredAt: new Date(item.firstSeenAt), now: new Date(now) });
  }

  private async emitOpportunities(result: DiscoveryTickResult, refreshAllowed: boolean, sourceBlock: bigint, labels: ReadonlyMap<string, string | null | undefined>): Promise<number> {
    const nowDate = this.now();
    const now = nowDate.getTime();
    const events: EventRecord[] = [];
    const alerts: Array<Parameters<IntelligenceAlertSink['intelligence']>[0]> = [];
    for (const item of this.tracked.values()) {
      if (now - item.lastActivityAt > CONVERGENCE_WINDOW_MS) continue;
      try {
      const scored = this.score(item, now, labels.size > 0);
      const last = item.lastEmit;
      const changed = !last || last.band !== scored.band || Math.abs(last.score - scored.score) >= SCORE_CHANGE;
      const due = changed || (refreshAllowed && now - last.at >= DISCOVERY_FRESHNESS_MS - REFRESH_BEFORE_STALE_MS);
      if (!due) continue;
      const watchedMinters = [...item.watched.entries()].filter(([, at]) => now - at <= CONVERGENCE_WINDOW_MS).map(([address]) => address).sort();
      const disposition = scored.band === 'log' ? 'scored' : 'notified';
      const alertable = !scored.blocked && scored.band !== 'log';
      // The name is read from the chain first; the label (ETH MINT) is only for a contract that really has none.
      const collectionName = alertable ? await this.names.get(item.contract) : null;
      const mintsLastHour = item.mints.filter((mint) => now - mint.at <= HOUR).reduce((total, mint) => total + mint.quantity, 0);
      events.push({ id: `evt_${randomUUID()}`, type: `opportunity_${disposition}`, at: nowDate.toISOString(), data: {
        opportunityId: opportunityId(this.port.chainId, item.contract), chainId: this.port.chainId, contract: item.contract, disposition, ...(collectionName ? { collectionName } : {}),
        score: scored.score, scoreVersion: scored.modelVersion, sampleSize: Math.round(scored.confidence * 100).toString(), denominator: '100', confidence: scored.confidenceLabel, band: scored.band, blocked: scored.blocked,
        factors: scored.factors, risks: scored.risks, watchedMinters, watchedMinterObservations: watchedMinters.map(wallet => ({ wallet, at: new Date(item.watched.get(wallet)!).toISOString() })), mintActivity: compactMintActivity(item.mints, now), mintsLastHour: item.mints.filter((mint) => now - mint.at <= HOUR).reduce((total, mint) => total + mint.quantity, 0), totalMinted: item.totalMinted,
        ...(item.priceWei === null ? {} : { priceWei: item.priceWei.toString() }), ...(item.hasCode === null ? {} : { hasCode: item.hasCode }),
        ...(item.drop && item.drop.startTime > 0 ? { openingAt: new Date(item.drop.startTime * 1000).toISOString() } : {}),
        watchedReceivers: [...item.received.keys()].sort(), sourceBlock: sourceBlock.toString(),
        firstSeenAt: new Date(item.firstSeenAt).toISOString(), lastActivityAt: new Date(item.lastActivityAt).toISOString(), expiresAt: new Date(now + DISCOVERY_FRESHNESS_MS).toISOString(),
      } });
      item.lastEmit = { at: now, score: scored.score, band: scored.band };
      if (alertable) {
        const card = opportunityCard({ chainId: this.port.chainId, contract: item.contract, collectionName, score: scored.score, priceWei: item.priceWei, watchingConfigured: labels.size > 0, minters: watchedMinters, receivers: item.received.size, labels, drop: item.drop, seenMinted: item.totalMinted, mintsLastHour, scored, spottedAt: item.lastActivityAt, now });
        alerts.push({ kind: 'opportunity', dedupe: `opportunity:${this.port.chainId}:${item.contract}:${scored.band}`, priority: scored.band === 'proposal' ? 'immediate' : 'grouped', text: plainAlertText(card), card });
      }
      } catch { /* one malformed item never blocks the others or the cursor */ }
    }
    if (events.length > 0) await this.store.transaction((state) => { state.events.push(...events); });
    await this.raise(alerts, result);
    return events.length;
  }

  private async emitCalendar(result: DiscoveryTickResult, refreshAllowed: boolean, sourceBlock: bigint): Promise<number> {
    const nowDate = this.now();
    const now = nowDate.getTime();
    const events: EventRecord[] = [];
    const alerts: Array<Parameters<IntelligenceAlertSink['intelligence']>[0]> = [];
    for (const [contract, entry] of this.calendar) {
      try {
      const { drop } = entry;
      const startMs = drop.startTime * 1000;
      const ended = drop.endTime !== 0 && drop.endTime * 1000 <= now;
      const upcoming = startMs > now;
      const recentlyActive = (this.tracked.get(contract)?.lastActivityAt ?? 0) >= now - CONVERGENCE_WINDOW_MS;
      if (ended || (upcoming && startMs - now > CALENDAR_HORIZON_MS) || (!upcoming && !recentlyActive && entry.lastEmit !== null)) continue;
      const signature = dropSignature(drop);
      const due = !entry.lastEmit || entry.lastEmit.signature !== signature || (refreshAllowed && now - entry.lastEmit.at >= DISCOVERY_FRESHNESS_MS - REFRESH_BEFORE_STALE_MS);
      if (due) {
        events.push({ id: `evt_${randomUUID()}`, type: 'calendar_entry', at: nowDate.toISOString(), data: {
          id: calendarId(this.port.chainId, contract), chainId: this.port.chainId, contract, openingAt: startMs > 0 ? new Date(startMs).toISOString() : null, closingAt: drop.endTime > 0 ? new Date(drop.endTime * 1000).toISOString() : null,
          phase: upcoming ? 'upcoming' : 'active', priceWei: drop.priceWei.toString(), maxPerWallet: drop.maxPerWallet, ...(drop.maxSupply === null ? {} : { maxSupply: drop.maxSupply.toString() }), ...(drop.totalMinted === null ? {} : { totalMinted: drop.totalMinted.toString() }),
          method: 'seadrop-v1-public', publicStatus: 'public', sourceAuthority: 'on_chain', sourceBlock: sourceBlock.toString(), expiresAt: new Date(now + DISCOVERY_FRESHNESS_MS).toISOString(),
        } });
        entry.lastEmit = { at: now, signature };
      }
      const chainId = this.port.chainId;
      if (drop.priceWei > this.options.budgetPerNftWei) {
        const dedupe = `price:${chainId}:${contract}:${drop.priceWei}`;
        if (this.priceAlertIdentities.get(contract) !== dedupe) {
          const card = priceAboveLimitCard({ chainId, contract, collectionName: await this.names.get(contract), drop, now, limitWei: this.options.budgetPerNftWei });
          alerts.push({ kind: 'price_above_limit', dedupe, priority: 'grouped', text: plainAlertText(card), card });
        }
      } else if (upcoming && drop.maxPerWallet > 0) {
        const minutes = Math.round((startMs - now) / 60_000);
        // Anyone can publish a drop, so opening reminders are grouped and capped per day rather than pushed immediately.
        const window = minutes <= 30 ? '30m' : minutes <= 360 ? '6h' : null;
        if (window && this.openingAlertAllowed(now)) {
          const card = openingSoonCard({ chainId, contract, collectionName: await this.names.get(contract), drop, now });
          alerts.push({ kind: 'opening_soon', dedupe: `opening:${chainId}:${contract}:${drop.startTime}:${window}`, priority: 'grouped', text: plainAlertText(card), card });
        }
      }
      } catch { /* one malformed entry never blocks the others or the cursor */ }
    }
    if (events.length > 0) await this.store.transaction((state) => { state.events.push(...events); });
    await this.raise(alerts, result);
    return events.length;
  }

  private async raise(alerts: ReadonlyArray<Parameters<IntelligenceAlertSink['intelligence']>[0]>, result: DiscoveryTickResult): Promise<void> {
    for (const alert of alerts) {
      try {
        // Preserve acknowledged legacy notices only on the chain identified by their
        // stored card. A chainless identity must never suppress another chain.
        const legacyDedupe = alert.dedupe.replace(`:${this.port.chainId}:`, ':');
        const legacyRecorded = this.store.snapshot().events.some(event => event.type === `alert_${alert.kind}` && event.data.dedupe === legacyDedupe && parseAlertCard(event.data.card)?.chainId === this.port.chainId);
        const recorded = legacyRecorded ? false : await this.options.alerts?.intelligence(alert);
        if (recorded) result.alertsRaised += 1;
        // Both true (inserted) and false (already durable) establish dedupe.
        // A missing sink or a throw does not, so the next slice/tick retries.
        if (typeof recorded === 'boolean' && alert.kind === 'price_above_limit' && alert.card) {
          this.priceAlertIdentities.set(alert.card.contract, alert.dedupe);
          if (this.priceAlertIdentities.size > MAX_CALENDAR) this.priceAlertIdentities.delete(this.priceAlertIdentities.keys().next().value!);
        }
      }
      catch { /* alert delivery never blocks discovery */ }
    }
  }

  /** Remembers a log's identity; returns false when it was already counted. Logs without identity are counted once per scan. */
  private firstSighting(kind: string, log: { txHash?: string | null; logIndex?: number | null }): boolean {
    if (!log.txHash || log.logIndex === null || log.logIndex === undefined) return true;
    const identity = `${kind}:${log.txHash.toLowerCase()}:${log.logIndex}`;
    if (this.seenLogs.has(identity)) return false;
    this.seenLogs.add(identity);
    if (this.seenLogs.size > MAX_SEEN_LOGS) { const oldest = this.seenLogs.values().next().value; if (oldest !== undefined) this.seenLogs.delete(oldest); }
    return true;
  }

  private putCalendar(contract: string, drop: DropSnapshot, lastEmit?: { at: number; signature: string }): void {
    this.calendar.set(contract, { drop, lastEmit: lastEmit ?? this.calendar.get(contract)?.lastEmit ?? null });
    if (this.calendar.size <= MAX_CALENDAR) return;
    // Keep the soonest entries; the one opening furthest away is dropped first.
    const furthest = [...this.calendar.entries()].filter(([key]) => key !== contract).sort((left, right) => right[1].drop.startTime - left[1].drop.startTime)[0];
    if (furthest) { this.calendar.delete(furthest[0]); this.priceAlertIdentities.delete(furthest[0]); }
  }

  private openingAlertAllowed(now: number): boolean {
    while (this.openingAlertTimes.length > 0 && now - this.openingAlertTimes[0]! > 24 * HOUR) this.openingAlertTimes.shift();
    if (this.openingAlertTimes.length >= MAX_OPENING_ALERTS_PER_DAY) return false;
    this.openingAlertTimes.push(now);
    return true;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [contract, item] of this.tracked) {
      item.mints = item.mints.filter((mint) => now - mint.at <= HOUR);
      for (const [address, at] of item.watched) if (now - at > CONVERGENCE_WINDOW_MS) item.watched.delete(address);
      if (now - item.lastActivityAt > CONVERGENCE_WINDOW_MS) this.tracked.delete(contract);
    }
    for (const [contract, entry] of this.calendar) {
      const ended = entry.drop.endTime !== 0 && entry.drop.endTime * 1000 <= now;
      const startedAndQuiet = entry.drop.startTime * 1000 <= now && entry.lastEmit !== null && !this.tracked.has(contract);
      if (ended || startedAndQuiet) { this.calendar.delete(contract); this.priceAlertIdentities.delete(contract); }
    }
  }
}

/** Rejects untrusted chain times that are out of range (a uint48 can exceed what a Date can hold); an absurd end time means open-ended. */
function sanitizeDrop(drop: DropSnapshot): DropSnapshot | null {
  if (!validChainTime(drop.startTime) || !Number.isSafeInteger(drop.maxPerWallet) || drop.maxPerWallet < 0 || drop.priceWei < 0n) return null;
  return validChainTime(drop.endTime) ? drop : { ...drop, endTime: 0 };
}

function dropSignature(drop: DropSnapshot): string { return `${drop.priceWei}:${drop.startTime}:${drop.endTime}:${drop.maxPerWallet}`; }

function dropFromEvent(event: EventRecord, contract: string): DropSnapshot | null {
  const price = typeof event.data.priceWei === 'string' && /^\d+$/.test(event.data.priceWei) ? BigInt(event.data.priceWei) : null;
  const start = typeof event.data.openingAt === 'string' ? Date.parse(event.data.openingAt) : Number.NaN;
  const end = typeof event.data.closingAt === 'string' ? Date.parse(event.data.closingAt) : 0;
  const maxPerWallet = Number(event.data.maxPerWallet);
  if (price === null || !Number.isFinite(start) || !Number.isSafeInteger(maxPerWallet)) return null;
  return { nftContract: contract, priceWei: price, startTime: Math.floor(start / 1000), endTime: Number.isFinite(end) ? Math.floor(end / 1000) : 0, maxPerWallet, maxSupply: null, totalMinted: null };
}

/** At most 61 minute buckets; use the oldest real time so restoration cannot extend activity. */
function compactMintActivity(mints: Tracked['mints'], now: number): Array<{ at: string; quantity: number }> {
  const buckets = new Map<number, { at: number; quantity: number }>();
  for (const mint of mints) {
    if (mint.at > now || now - mint.at > HOUR) continue;
    const key = Math.floor(mint.at / 60_000);
    const prior = buckets.get(key);
    buckets.set(key, { at: Math.min(prior?.at ?? mint.at, mint.at), quantity: (prior?.quantity ?? 0) + mint.quantity });
  }
  return [...buckets.values()].map(bucket => ({ at: new Date(bucket.at).toISOString(), quantity: bucket.quantity }));
}
