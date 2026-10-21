import { randomUUID } from 'node:crypto';
import type { BackendState, EventRecord } from './types.js';
import type { BackendStore } from './store.js';
import type { BalanceCeilings } from './compensating-controls.js';
import { stepExcessTracker, type ExcessState } from './fleet-funding.js';
import { excessBalanceCard, fleetWatchCard, fundingRequestCard, type FleetWatchFinding } from './fleet-messages.js';
import type { SystemCard } from './system-card.js';

/**
 * D-059 item 6: the independent on-chain watcher. It runs inside the existing service on the existing RPC (three lookups per
 * fleet wallet per check: block number, then transaction count and balance at that block) and never trusts the custody
 * provider. For every fleet wallet it compares the chain with MintBot's own records:
 *
 * - a transaction count above anything MintBot sent, or a balance fall larger than the recorded reservations can explain,
 *   is confirmed by a second read, then engages the kill switch, alerts the owner and records the finding. The baseline is
 *   NOT moved, so it keeps reporting until the owner accepts the wallet's current state.
 * - a balance rise only alerts (and feeds the left-over balance reminder).
 *
 * It signs nothing, sends nothing and cannot release the kill switch. If the kill switch cannot be engaged, the owner is told
 * so in plain words instead of being told signing has stopped.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const WATCH_ACTIVE_INTERVAL_MS = 2 * 60 * 1000;
export const WATCH_IDLE_INTERVAL_MS = 10 * 60 * 1000;
export const WATCH_BLIND_AFTER_FAILURES = 3;
/** The watcher counts as alive while its last complete check is no older than this many intervals. */
export const WATCH_HEALTHY_INTERVALS = 3;
const BASELINE_REFRESH_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FUNDING_REQUEST_HORIZON_MS = 7 * DAY_MS;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface WatchTarget { chainId: number; address: string }
export interface WalletReading { nonce: number; balanceWei: bigint }
export interface WalletBaseline { nonce: number; balanceWei: string; observedAt: string; excess?: ExcessState }
export interface WalletLedger {
  /** One above the highest transaction count MintBot itself used for this wallet, or undefined when it never sent anything. */
  knownNextNonce: number | undefined;
  /** The most the recorded reservations could explain being spent since the baseline: pending ones plus any updated since. */
  allowedFallWei: bigint;
}

export type WalletVerdict =
  | { kind: 'baseline' }
  | { kind: 'ok' }
  | { kind: 'rise' }
  | { kind: 'unknown_activity'; observedNonce: number; expectedNonce: number }
  | { kind: 'unexplained_fall'; fallWei: bigint; allowedWei: bigint }
  | { kind: 'rpc_inconsistent' };

/** Pure judgement of one wallet reading against its baseline and MintBot's ledger. */
export function judgeWallet(reading: WalletReading, baseline: WalletBaseline | undefined, ledger: WalletLedger): WalletVerdict {
  if (!baseline) return { kind: 'baseline' };
  if (reading.nonce < baseline.nonce) return { kind: 'rpc_inconsistent' };
  const expectedNonce = Math.max(baseline.nonce, ledger.knownNextNonce ?? baseline.nonce);
  if (reading.nonce > expectedNonce) return { kind: 'unknown_activity', observedNonce: reading.nonce, expectedNonce };
  const before = BigInt(baseline.balanceWei);
  if (reading.balanceWei < before) {
    const fall = before - reading.balanceWei;
    if (fall > ledger.allowedFallWei) return { kind: 'unexplained_fall', fallWei: fall, allowedWei: ledger.allowedFallWei };
    return { kind: 'ok' };
  }
  return reading.balanceWei > before ? { kind: 'rise' } : { kind: 'ok' };
}

export interface WatcherAlertSink {
  /** Returns false when this dedupe identity was already sent. May throw when delivery fails. */
  send(input: { kind: 'fleet_watch' | 'excess_balance' | 'funding_request'; dedupe: string; priority: 'immediate' | 'grouped'; text: string; system: SystemCard; at: string }): Promise<boolean>;
}

export interface FleetWatcherOptions {
  store: BackendStore;
  targets: readonly WatchTarget[];
  ceilings: BalanceCeilings;
  treasury: string;
  read(target: WatchTarget): Promise<WalletReading>;
  alerts: WatcherAlertSink;
  /** Engages the kill switch (the kill file and the coordinator). Must throw if it could not be engaged. */
  kill(reason: string): Promise<void>;
  now?: () => Date;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
}

export interface WatchTickResult {
  ran: boolean;
  checked: number;
  failed: number;
  findings: Array<{ wallet: string; chainId: number; kind: WalletVerdict['kind'] }>;
  reminders: number;
  /** True only when the kill switch is engaged because of this check. */
  killed: boolean;
  /** True when the check wanted to engage the kill switch and could not. */
  killFailed: boolean;
}

const keyOf = (target: WatchTarget): string => `${target.chainId}:${target.address.toLowerCase()}`;
const isKillClass = (verdict: WalletVerdict): verdict is Extract<WalletVerdict, { kind: 'unknown_activity' | 'unexplained_fall' }> => verdict.kind === 'unknown_activity' || verdict.kind === 'unexplained_fall';

export class FleetWatcher {
  private readonly now: () => Date;
  private readonly baselines = new Map<string, WalletBaseline>();
  private readonly lastFinding = new Map<string, string>();
  private readonly readFailures = new Map<string, number>();
  private readonly inconsistent = new Map<string, number>();
  private loaded = false;
  private lastRunAt = 0;
  private lastGoodAt = 0;
  private lastAcceptSyncAt = '';

  constructor(private readonly options: FleetWatcherOptions) {
    this.now = options.now ?? (() => new Date());
    for (const target of options.targets) if (!ADDRESS.test(target.address)) throw new Error('FLEET_WATCH_ADDRESS_INVALID');
    if (options.targets.length === 0) throw new Error('FLEET_WATCH_TARGETS_REQUIRED');
    if (!ADDRESS.test(options.treasury)) throw new Error('FLEET_WATCH_TREASURY_INVALID');
  }

  /** True only when every wallet is on this chain's watch list. Used by the arm gate so an unwatched wallet cannot be armed. */
  public covers(chainId: number, wallets: readonly string[]): boolean {
    if (wallets.length === 0) return false;
    const watched = new Set(this.options.targets.filter((target) => target.chainId === chainId).map((target) => target.address.toLowerCase()));
    return wallets.every((wallet) => watched.has(wallet.toLowerCase()));
  }

  /** True while the last complete check (every wallet read) is recent. A watcher that has gone quiet does not count as watching. */
  public isHealthy(at: Date = this.now()): boolean {
    const interval = Math.max(this.options.idleIntervalMs ?? WATCH_IDLE_INTERVAL_MS, this.options.activeIntervalMs ?? WATCH_ACTIVE_INTERVAL_MS);
    return this.lastGoodAt !== 0 && at.getTime() - this.lastGoodAt <= WATCH_HEALTHY_INTERVALS * interval;
  }

  /** Loads the last stored baseline of each wallet once; afterwards the cache is authoritative and every change is persisted. */
  private load(): void {
    if (this.loaded) return;
    const wanted = new Set(this.options.targets.map(keyOf));
    const events = this.options.store.snapshot().events;
    for (let index = events.length - 1; index >= 0 && this.baselines.size < wanted.size; index -= 1) {
      const event = events[index]!;
      if (event.type !== 'fleet_watch_baseline' && event.type !== 'fleet_watch_accept') continue;
      const data = event.data as { chainId?: number; address?: string; nonce?: number; balanceWei?: string; observedAt?: string; excess?: ExcessState };
      if (typeof data.chainId !== 'number' || typeof data.address !== 'string' || typeof data.nonce !== 'number' || typeof data.balanceWei !== 'string') continue;
      const key = `${data.chainId}:${data.address.toLowerCase()}`;
      if (!wanted.has(key) || this.baselines.has(key)) continue;
      this.baselines.set(key, { nonce: data.nonce, balanceWei: data.balanceWei, observedAt: data.observedAt ?? event.at, ...(data.excess ? { excess: data.excess } : {}) });
    }
    this.loaded = true;
  }

  private event(type: string, data: Record<string, unknown>): EventRecord {
    return { id: `evt_${randomUUID()}`, type, at: this.now().toISOString(), data };
  }

  private async persist(type: string, data: Record<string, unknown>): Promise<void> {
    await this.options.store.transaction((state: BackendState) => { state.events.push(this.event(type, data)); });
  }

  private runActive(state: BackendState): boolean {
    return state.runs.some((run) => run.state === 'Armed' || run.state === 'Active');
  }

  /** What MintBot's own records say this wallet may have done since its baseline. A record that cannot be tied to a chain counts for every chain (never causes a false miss). */
  private ledgerFor(state: BackendState, target: WatchTarget, baseline: WalletBaseline | undefined): WalletLedger {
    const address = target.address.toLowerCase();
    const chainOfCampaign = new Map<string, number>();
    for (const campaign of state.campaigns) chainOfCampaign.set(campaign.id, campaign.chainId);
    const runChain = (runId: string): number | undefined => {
      const run = state.runs.find((item) => item.id === runId);
      const fromIntent = state.intents.find((item) => item.runId === runId)?.campaignSnapshot.chainId;
      return fromIntent ?? (run ? chainOfCampaign.get(run.campaignId) : undefined);
    };
    let knownNextNonce: number | undefined;
    for (const attempt of state.attempts) {
      if (attempt.wallet.toLowerCase() !== address || attempt.nonce === undefined) continue;
      const chain = runChain(attempt.runId);
      if (chain !== undefined && chain !== target.chainId) continue;
      knownNextNonce = Math.max(knownNextNonce ?? 0, attempt.nonce + 1);
    }
    let allowedFallWei = 0n;
    for (const reservation of state.reservations) {
      if (reservation.wallet.toLowerCase() !== address) continue;
      const chain = reservation.chainId ?? runChain(reservation.runId);
      if (chain !== undefined && chain !== target.chainId) continue;
      if (reservation.status === 'reserved' || reservation.status === 'reorged' || (baseline !== undefined && reservation.updatedAt >= baseline.observedAt)) allowedFallWei += reservation.amountWei;
    }
    return { knownNextNonce, allowedFallWei };
  }

  /** Records the owner's acceptance of a wallet's current state directly (used in tests and by tools that already hold a reading). */
  public async acceptCurrent(target: WatchTarget, reading: WalletReading): Promise<void> {
    this.load();
    const baseline: WalletBaseline = { nonce: reading.nonce, balanceWei: reading.balanceWei.toString(), observedAt: this.now().toISOString() };
    this.baselines.set(keyOf(target), baseline);
    this.lastFinding.delete(keyOf(target));
    await this.persist('fleet_watch_accept', { chainId: target.chainId, address: target.address.toLowerCase(), ...baseline });
  }

  /**
   * The owner's `fleet-watch-accept` command (a separate process) records an accept event after investigating a finding. A running
   * watcher adopts it only if it is not dated in the future and does not claim a transaction count above what the chain shows now,
   * so a forged record cannot blind the watcher. Every adopted or rejected accept is reported to the owner.
   */
  private async syncAccepts(state: BackendState, readings: ReadonlyMap<string, WalletReading>, now: Date): Promise<void> {
    const wanted = new Set(this.options.targets.map(keyOf));
    let newest = this.lastAcceptSyncAt;
    const found: Array<{ event: EventRecord; key: string; nonce: number; balanceWei: string }> = [];
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index]!;
      if (this.lastAcceptSyncAt !== '' && event.at <= this.lastAcceptSyncAt) break;
      if (Date.parse(event.at) <= now.getTime() + FUTURE_TOLERANCE_MS && event.at > newest) newest = event.at;
      if (event.type !== 'fleet_watch_accept') continue;
      const data = event.data as { chainId?: number; address?: string; nonce?: number; balanceWei?: string };
      if (typeof data.chainId !== 'number' || typeof data.address !== 'string' || typeof data.nonce !== 'number' || typeof data.balanceWei !== 'string' || !/^\d{1,40}$/.test(data.balanceWei)) continue;
      const key = `${data.chainId}:${data.address.toLowerCase()}`;
      if (wanted.has(key)) found.push({ event, key, nonce: data.nonce, balanceWei: data.balanceWei });
    }
    if (newest > this.lastAcceptSyncAt) this.lastAcceptSyncAt = newest;
    for (const accept of found.reverse()) {
      const target = this.options.targets.find((item) => keyOf(item) === accept.key)!;
      const known = this.baselines.get(accept.key);
      if (known !== undefined && accept.event.at <= known.observedAt) continue;
      const reading = readings.get(accept.key);
      const future = Date.parse(accept.event.at) > now.getTime() + FUTURE_TOLERANCE_MS;
      const ahead = reading !== undefined && accept.nonce > reading.nonce;
      if (future || ahead || !Number.isSafeInteger(accept.nonce) || accept.nonce < 0) {
        await this.finding('accept_rejected', target, now, accept.event.id, 'immediate');
        continue;
      }
      this.baselines.set(accept.key, { nonce: accept.nonce, balanceWei: accept.balanceWei, observedAt: accept.event.at });
      this.lastFinding.delete(accept.key);
      await this.finding('baseline_accepted', target, now, accept.event.id, 'immediate');
    }
  }

  /** Runs one check when the interval for the current state (run armed or active, or idle) has passed. */
  public async tick(force = false): Promise<WatchTickResult> {
    this.load();
    const now = this.now();
    const active = this.runActive(this.options.store.snapshot());
    const interval = active ? (this.options.activeIntervalMs ?? WATCH_ACTIVE_INTERVAL_MS) : (this.options.idleIntervalMs ?? WATCH_IDLE_INTERVAL_MS);
    const result: WatchTickResult = { ran: false, checked: 0, failed: 0, findings: [], reminders: 0, killed: false, killFailed: false };
    if (!force && this.lastRunAt !== 0 && now.getTime() - this.lastRunAt < interval) return result;
    this.lastRunAt = now.getTime();
    result.ran = true;
    // Read the chain first, then take the records: anything MintBot recorded while the reads were in flight is then included.
    const observations: Array<{ target: WatchTarget; reading: WalletReading }> = [];
    for (const target of this.options.targets) {
      const key = keyOf(target);
      let reading: WalletReading | undefined;
      try { reading = await this.options.read(target); } catch { reading = undefined; }
      if (!reading || !Number.isSafeInteger(reading.nonce) || reading.nonce < 0 || reading.balanceWei < 0n) {
        result.failed += 1;
        const failures = (this.readFailures.get(key) ?? 0) + 1;
        this.readFailures.set(key, failures);
        if (failures >= WATCH_BLIND_AFTER_FAILURES) await this.finding('watcher_blind', target, now, `${Math.floor(now.getTime() / DAY_MS)}`, 'immediate');
        continue;
      }
      this.readFailures.delete(key);
      result.checked += 1;
      observations.push({ target, reading });
    }
    const state = this.options.store.snapshot();
    await this.syncAccepts(state, new Map(observations.map((item) => [keyOf(item.target), item.reading])), now);
    for (const { target, reading } of observations) await this.judgeAndAct(state, target, reading, now, result);
    await this.deliverFundingRequests(state, now);
    await this.trackExcess(observations, active, now, result);
    if (result.failed === 0 && result.checked > 0) this.lastGoodAt = now.getTime();
    return result;
  }

  /** For failures the service itself sees (a check that threw): the owner is told once a day that wallet activity is not being watched. */
  public async reportBlind(at: Date = this.now()): Promise<void> {
    await this.finding('watcher_blind', this.options.targets[0]!, at, `service:${Math.floor(at.getTime() / DAY_MS)}`, 'immediate', undefined, true);
  }

  private async judgeAndAct(state: BackendState, target: WatchTarget, reading: WalletReading, now: Date, result: WatchTickResult): Promise<void> {
    const key = keyOf(target);
    const address = target.address.toLowerCase();
    const baseline = this.baselines.get(key);
    let verdict = judgeWallet(reading, baseline, this.ledgerFor(state, target, baseline));
    let effective = reading;
    const stamp = now.toISOString();
    const remember = async (): Promise<void> => {
      const next: WalletBaseline = { nonce: effective.nonce, balanceWei: effective.balanceWei.toString(), observedAt: stamp, ...(baseline?.excess ? { excess: baseline.excess } : {}) };
      this.baselines.set(key, next);
      await this.persist('fleet_watch_baseline', { chainId: target.chainId, address, nonce: next.nonce, balanceWei: next.balanceWei, observedAt: stamp, ...(next.excess ? { excess: next.excess } : {}) });
    };
    // A finding that would stop signing is confirmed by one more read first, so a single odd provider answer cannot kill a live run.
    if (isKillClass(verdict)) {
      try {
        const second = await this.options.read(target);
        const again = judgeWallet(second, baseline, this.ledgerFor(this.options.store.snapshot(), target, baseline));
        if (!isKillClass(again)) verdict = { kind: 'rpc_inconsistent' };
        else { verdict = again; effective = second; }
      } catch { /* the second read failed: act on the first, which is the safe side */ }
    }
    if (verdict.kind !== 'rpc_inconsistent') this.inconsistent.delete(key);
    const changed = baseline === undefined || baseline.nonce !== effective.nonce || baseline.balanceWei !== effective.balanceWei.toString();
    const stale = baseline !== undefined && now.getTime() - Date.parse(baseline.observedAt) >= BASELINE_REFRESH_MS;
    switch (verdict.kind) {
      case 'baseline':
        await remember();
        return;
      case 'ok':
        this.lastFinding.delete(key);
        if (changed || stale) await remember();
        return;
      case 'rise': {
        const ceiling = this.options.ceilings[target.chainId];
        const aboveLimit = ceiling !== undefined && effective.balanceWei > ceiling.walletMaxWei;
        await remember();
        // Funds the owner was asked to send (a recorded funding request) are expected; anything else above the limit is worth a note.
        if (aboveLimit && !this.runActive(state) && !this.recentlyRequested(state, target, now)) await this.finding('rise_above_limit', target, now, `${effective.balanceWei}:${Math.floor(now.getTime() / DAY_MS)}`, 'grouped');
        return;
      }
      case 'rpc_inconsistent': {
        result.findings.push({ wallet: address, chainId: target.chainId, kind: 'rpc_inconsistent' });
        const count = (this.inconsistent.get(key) ?? 0) + 1;
        this.inconsistent.set(key, count);
        const day = Math.floor(now.getTime() / DAY_MS);
        await this.finding('rpc_inconsistent', target, now, `${day}`, 'grouped');
        // A provider that keeps reporting less than MintBot already knows is hiding something or broken: say so at once, without killing.
        if (count >= WATCH_BLIND_AFTER_FAILURES) await this.finding('watcher_blind', target, now, `inconsistent:${day}`, 'immediate');
        return;
      }
      case 'unknown_activity':
      case 'unexplained_fall': {
        result.findings.push({ wallet: address, chainId: target.chainId, kind: verdict.kind });
        // Engage the kill switch first. If that fails the owner is told so plainly; the baseline stays where it was either way.
        let killFailed = false;
        if (!this.options.store.snapshot().killed) {
          try { await this.options.kill(`fleet-watch-${verdict.kind}`); } catch { killFailed = true; }
        }
        if (killFailed) result.killFailed = true; else result.killed = true;
        const identity = `${effective.nonce}:${effective.balanceWei}:${Math.floor(now.getTime() / DAY_MS)}`;
        await this.finding(verdict.kind, target, now, killFailed ? `${identity}:kill-failed` : identity, 'immediate', killFailed);
        const findingKey = `${verdict.kind}:${effective.nonce}:${effective.balanceWei}`;
        if (this.lastFinding.get(key) !== findingKey) {
          this.lastFinding.set(key, findingKey);
          await this.persist('fleet_watch_finding', { chainId: target.chainId, address, kind: verdict.kind, nonce: effective.nonce, balanceWei: effective.balanceWei.toString(), killFailed });
        }
        return;
      }
    }
  }

  private recentlyRequested(state: BackendState, target: WatchTarget, now: Date): boolean {
    const horizon = now.getTime() - DAY_MS;
    const address = target.address.toLowerCase();
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index]!;
      if (Date.parse(event.at) < horizon) return false;
      if (event.type !== 'fleet_funding_requested') continue;
      const data = event.data as { chainId?: number; items?: Array<{ wallet?: string }> };
      if (data.chainId === target.chainId && Array.isArray(data.items) && data.items.some((item) => typeof item.wallet === 'string' && item.wallet.toLowerCase() === address)) return true;
    }
    return false;
  }

  private async finding(kind: FleetWatchFinding, target: WatchTarget, now: Date, identity: string, priority: 'immediate' | 'grouped', killFailed?: boolean, noWallet?: boolean): Promise<void> {
    const card = fleetWatchCard({ finding: kind, chainId: target.chainId, ...(noWallet ? {} : { wallet: target.address }), ...(killFailed ? { killFailed: true } : {}), at: now });
    await this.options.alerts.send({ kind: 'fleet_watch', dedupe: `fleet_watch:${kind}:${target.chainId}:${noWallet ? 'service' : target.address.toLowerCase()}:${identity}`, priority, text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
  }

  /**
   * The owner asks for a run's funding with the `fleet-funding-plan --request` command, which records a request. This service
   * turns each new request into the Telegram message (once per request); it never sends the funds. Only wallets on the watch
   * list for that chain are accepted, so a forged request cannot name an address of its own choosing.
   */
  private async deliverFundingRequests(state: BackendState, now: Date): Promise<void> {
    const horizon = now.getTime() - FUNDING_REQUEST_HORIZON_MS;
    let scanned = 0;
    for (let index = state.events.length - 1; index >= 0 && scanned < 5000; index -= 1, scanned += 1) {
      const event = state.events[index]!;
      if (Date.parse(event.at) < horizon) break;
      if (event.type !== 'fleet_funding_requested') continue;
      const data = event.data as { requestId?: string; chainId?: number; items?: Array<{ wallet: string; topUpWei: string }> };
      if (typeof data.requestId !== 'string' || typeof data.chainId !== 'number' || !Array.isArray(data.items) || data.items.length === 0) continue;
      if (!this.covers(data.chainId, data.items.map((item) => item.wallet))) continue;
      let card: SystemCard;
      try { card = fundingRequestCard({ chainId: data.chainId, treasury: this.options.treasury, items: data.items, at: event.at }); } catch { continue; }
      await this.options.alerts.send({ kind: 'funding_request', dedupe: `funding_request:${data.requestId}`, priority: 'immediate', text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
    }
  }

  private async trackExcess(observations: ReadonlyArray<{ target: WatchTarget; reading: WalletReading }>, runActive: boolean, now: Date, result: WatchTickResult): Promise<void> {
    const byChain = new Map<number, typeof observations>();
    for (const observation of observations) byChain.set(observation.target.chainId, [...(byChain.get(observation.target.chainId) ?? []), observation]);
    for (const [chainId, chainObservations] of byChain) {
      const ceiling = this.options.ceilings[chainId];
      if (!ceiling) continue;
      const previous: Record<string, ExcessState> = {};
      for (const { target } of chainObservations) { const excess = this.baselines.get(keyOf(target))?.excess; if (excess) previous[target.address.toLowerCase()] = excess; }
      const step = stepExcessTracker({ previous, observations: chainObservations.map(({ target, reading }) => ({ address: target.address, balanceWei: reading.balanceWei, nonce: reading.nonce })), walletMaxWei: ceiling.walletMaxWei, runActive, now });
      let delivered = true;
      if (step.reminders.length > 0) {
        const card = excessBalanceCard({ chainId, treasury: this.options.treasury, reminders: step.reminders, at: now });
        const bucket = Math.floor(now.getTime() / DAY_MS);
        const wallets = step.reminders.map((reminder) => reminder.wallet).sort().join(',');
        try { await this.options.alerts.send({ kind: 'excess_balance', dedupe: `excess_balance:${chainId}:${wallets}:${bucket}`, priority: 'immediate', text: card.summary, system: card, at: now.toISOString() }); } catch { delivered = false; }
        if (delivered) result.reminders += step.reminders.length;
      }
      // A reminder that could not be delivered must not start the next 24 hours: the previous state is kept for those wallets.
      const reminded = new Set(delivered ? [] : step.reminders.map((reminder) => reminder.wallet));
      for (const { target } of chainObservations) {
        const address = target.address.toLowerCase();
        const baseline = this.baselines.get(keyOf(target));
        if (!baseline) continue;
        const after = reminded.has(address) ? previous[address] : step.next[address];
        const same = JSON.stringify(after ?? null) === JSON.stringify(baseline.excess ?? null);
        if (same) continue;
        const { excess: dropped, ...rest } = baseline;
        void dropped;
        const updated: WalletBaseline = { ...rest, ...(after ? { excess: after } : {}) };
        this.baselines.set(keyOf(target), updated);
        await this.persist('fleet_watch_baseline', { chainId, address, nonce: updated.nonce, balanceWei: updated.balanceWei, observedAt: updated.observedAt, ...(after ? { excess: after } : {}) });
      }
    }
  }
}
