import { randomUUID } from 'node:crypto';
import type { BackendState, EventRecord } from './types.js';
import type { BackendStore } from './store.js';
import type { BalanceCeilings } from './compensating-controls.js';
import { stepExcessTracker, type ExcessState } from './fleet-funding.js';
import { excessBalanceCard, fleetWatchCard, fundingRequestCard, type FleetWatchFinding } from './fleet-messages.js';
import type { SystemCard } from './system-card.js';

/**
 * D-059 item 6: the independent on-chain watcher. It runs inside the existing service on the existing RPC (two lookups per
 * fleet wallet per check: transaction count and balance) and never trusts the custody provider. For every fleet wallet it
 * compares the chain with MintBot's own records:
 *
 * - a transaction count above anything MintBot sent, or a balance fall larger than the recorded reservations can explain,
 *   engages the kill switch, alerts the owner and records the finding. The baseline is NOT moved, so it keeps reporting
 *   until the owner accepts the wallet's current state.
 * - a balance rise only alerts (and feeds the left-over balance reminder).
 *
 * It signs nothing, sends nothing and cannot release the kill switch.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const WATCH_ACTIVE_INTERVAL_MS = 2 * 60 * 1000;
export const WATCH_IDLE_INTERVAL_MS = 10 * 60 * 1000;
export const WATCH_BLIND_AFTER_FAILURES = 3;
const BASELINE_REFRESH_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** Returns false when this dedupe identity was already sent. */
  send(input: { kind: 'fleet_watch' | 'excess_balance' | 'funding_request'; dedupe: string; priority: 'immediate' | 'grouped'; text: string; system: SystemCard; at: string }): Promise<boolean>;
}

export interface FleetWatcherOptions {
  store: BackendStore;
  targets: readonly WatchTarget[];
  ceilings: BalanceCeilings;
  treasury: string;
  read(target: WatchTarget): Promise<WalletReading>;
  alerts: WatcherAlertSink;
  /** Engages the kill switch (and the kill file). Idempotent. */
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
  killed: boolean;
}

const keyOf = (target: WatchTarget): string => `${target.chainId}:${target.address.toLowerCase()}`;

export class FleetWatcher {
  private readonly now: () => Date;
  private readonly baselines = new Map<string, WalletBaseline>();
  private loaded = false;
  private lastRunAt = 0;
  private lastAcceptSyncAt = '';
  private consecutiveBlind = 0;
  private blindAlerted = false;

  constructor(private readonly options: FleetWatcherOptions) {
    this.now = options.now ?? (() => new Date());
    for (const target of options.targets) if (!ADDRESS.test(target.address)) throw new Error('FLEET_WATCH_ADDRESS_INVALID');
    if (options.targets.length === 0) throw new Error('FLEET_WATCH_TARGETS_REQUIRED');
    if (!ADDRESS.test(options.treasury)) throw new Error('FLEET_WATCH_TREASURY_INVALID');
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

  /** What MintBot's own records say this wallet may have done since its baseline. */
  private ledgerFor(state: BackendState, target: WatchTarget, baseline: WalletBaseline | undefined): WalletLedger {
    const address = target.address.toLowerCase();
    const chainOfRun = new Map<string, number>();
    for (const intent of state.intents) chainOfRun.set(intent.runId, intent.campaignSnapshot.chainId);
    let knownNextNonce: number | undefined;
    for (const attempt of state.attempts) {
      if (attempt.wallet.toLowerCase() !== address || attempt.nonce === undefined) continue;
      if (chainOfRun.get(attempt.runId) !== target.chainId) continue;
      knownNextNonce = Math.max(knownNextNonce ?? 0, attempt.nonce + 1);
    }
    let allowedFallWei = 0n;
    for (const reservation of state.reservations) {
      if (reservation.wallet.toLowerCase() !== address) continue;
      if ((reservation.chainId ?? chainOfRun.get(reservation.runId)) !== target.chainId) continue;
      if (reservation.status === 'reserved' || reservation.status === 'reorged' || (baseline !== undefined && reservation.updatedAt >= baseline.observedAt)) allowedFallWei += reservation.amountWei;
    }
    return { knownNextNonce, allowedFallWei };
  }

  /** The owner accepts a wallet's current on-chain state as the new baseline (after investigating a finding). */
  public async acceptCurrent(target: WatchTarget, reading: WalletReading): Promise<void> {
    this.load();
    const baseline: WalletBaseline = { nonce: reading.nonce, balanceWei: reading.balanceWei.toString(), observedAt: this.now().toISOString() };
    this.baselines.set(keyOf(target), baseline);
    await this.persist('fleet_watch_accept', { chainId: target.chainId, address: target.address.toLowerCase(), ...baseline });
  }

  /**
   * The owner's `fleet-watch-accept` command (a separate process) records an accept event after investigating a finding. A running
   * watcher adopts any accept event newer than its own baseline, so the accepted state takes effect without a restart.
   */
  private syncAccepts(state: BackendState): void {
    const wanted = new Set(this.options.targets.map(keyOf));
    let newest = this.lastAcceptSyncAt;
    for (let index = state.events.length - 1; index >= 0; index -= 1) {
      const event = state.events[index]!;
      if (this.lastAcceptSyncAt !== '' && event.at <= this.lastAcceptSyncAt) break;
      if (event.at > newest) newest = event.at;
      if (event.type !== 'fleet_watch_accept') continue;
      const data = event.data as { chainId?: number; address?: string; nonce?: number; balanceWei?: string };
      if (typeof data.chainId !== 'number' || typeof data.address !== 'string' || typeof data.nonce !== 'number' || typeof data.balanceWei !== 'string' || !/^\d{1,40}$/.test(data.balanceWei)) continue;
      const key = `${data.chainId}:${data.address.toLowerCase()}`;
      const known = this.baselines.get(key);
      if (!wanted.has(key) || (known !== undefined && event.at <= known.observedAt)) continue;
      this.baselines.set(key, { nonce: data.nonce, balanceWei: data.balanceWei, observedAt: event.at });
    }
    if (newest > this.lastAcceptSyncAt) this.lastAcceptSyncAt = newest;
  }

  /** Runs one check when the interval for the current state (run armed or active, or idle) has passed. */
  public async tick(force = false): Promise<WatchTickResult> {
    this.load();
    const now = this.now();
    const state = this.options.store.snapshot();
    this.syncAccepts(state);
    const active = this.runActive(state);
    const interval = active ? (this.options.activeIntervalMs ?? WATCH_ACTIVE_INTERVAL_MS) : (this.options.idleIntervalMs ?? WATCH_IDLE_INTERVAL_MS);
    const result: WatchTickResult = { ran: false, checked: 0, failed: 0, findings: [], reminders: 0, killed: false };
    if (!force && this.lastRunAt !== 0 && now.getTime() - this.lastRunAt < interval) return result;
    this.lastRunAt = now.getTime();
    result.ran = true;
    const observations: Array<{ target: WatchTarget; reading: WalletReading }> = [];
    for (const target of this.options.targets) {
      let reading: WalletReading;
      try { reading = await this.options.read(target); } catch { result.failed += 1; continue; }
      if (!Number.isSafeInteger(reading.nonce) || reading.nonce < 0 || reading.balanceWei < 0n) { result.failed += 1; continue; }
      result.checked += 1;
      observations.push({ target, reading });
      await this.judgeAndAct(state, target, reading, now, result);
    }
    await this.deliverFundingRequests(state, now);
    await this.trackBlindness(result, now);
    await this.trackExcess(observations, active, now, result);
    return result;
  }

  private async judgeAndAct(state: BackendState, target: WatchTarget, reading: WalletReading, now: Date, result: WatchTickResult): Promise<void> {
    const key = keyOf(target);
    const address = target.address.toLowerCase();
    const baseline = this.baselines.get(key);
    const verdict = judgeWallet(reading, baseline, this.ledgerFor(state, target, baseline));
    const stamp = now.toISOString();
    const remember = async (): Promise<void> => {
      const next: WalletBaseline = { nonce: reading.nonce, balanceWei: reading.balanceWei.toString(), observedAt: stamp, ...(baseline?.excess ? { excess: baseline.excess } : {}) };
      this.baselines.set(key, next);
      await this.persist('fleet_watch_baseline', { chainId: target.chainId, address, nonce: next.nonce, balanceWei: next.balanceWei, observedAt: stamp, ...(next.excess ? { excess: next.excess } : {}) });
    };
    const changed = baseline === undefined || baseline.nonce !== reading.nonce || baseline.balanceWei !== reading.balanceWei.toString();
    const stale = baseline !== undefined && now.getTime() - Date.parse(baseline.observedAt) >= BASELINE_REFRESH_MS;
    switch (verdict.kind) {
      case 'baseline':
        await remember();
        return;
      case 'ok':
        if (changed || stale) await remember();
        return;
      case 'rise': {
        const ceiling = this.options.ceilings[target.chainId];
        const aboveLimit = ceiling !== undefined && reading.balanceWei > ceiling.walletMaxWei;
        await remember();
        // A rise above the idle limit while a run is funded is expected; outside a run it is worth a note. Alert only.
        if (aboveLimit && !this.runActive(state)) await this.finding('rise_above_limit', target, reading, now, `${address}:${reading.balanceWei}`, 'grouped');
        return;
      }
      case 'rpc_inconsistent':
        result.findings.push({ wallet: address, chainId: target.chainId, kind: 'rpc_inconsistent' });
        await this.finding('rpc_inconsistent', target, reading, now, `${address}:${Math.floor(now.getTime() / DAY_MS)}`, 'grouped');
        return;
      case 'unknown_activity':
      case 'unexplained_fall': {
        result.findings.push({ wallet: address, chainId: target.chainId, kind: verdict.kind });
        // Engage the kill switch first: the alert and the record follow, and the baseline stays where it was.
        await this.options.kill(`fleet-watch-${verdict.kind}`).catch(() => undefined);
        result.killed = true;
        await this.finding(verdict.kind, target, reading, now, `${address}:${reading.nonce}:${reading.balanceWei}`, 'immediate');
        await this.persist('fleet_watch_finding', { chainId: target.chainId, address, kind: verdict.kind, nonce: reading.nonce, balanceWei: reading.balanceWei.toString() });
        return;
      }
    }
  }

  private async finding(kind: FleetWatchFinding, target: WatchTarget, reading: WalletReading, now: Date, identity: string, priority: 'immediate' | 'grouped'): Promise<void> {
    const card = fleetWatchCard({ finding: kind, chainId: target.chainId, wallet: target.address, at: now });
    await this.options.alerts.send({ kind: 'fleet_watch', dedupe: `fleet_watch:${kind}:${target.chainId}:${identity}`, priority, text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
    void reading;
  }

  /**
   * The owner asks for a run's funding with the `fleet-funding-plan --request` command, which records a request. This service
   * turns each new request into the Telegram message (once per request); it never sends the funds.
   */
  private async deliverFundingRequests(state: BackendState, now: Date): Promise<void> {
    const targets = new Set(this.options.targets.map((target) => target.chainId));
    const horizon = now.getTime() - 24 * 60 * 60 * 1000;
    let scanned = 0;
    for (let index = state.events.length - 1; index >= 0 && scanned < 500; index -= 1, scanned += 1) {
      const event = state.events[index]!;
      if (Date.parse(event.at) < horizon) break;
      if (event.type !== 'fleet_funding_requested') continue;
      const data = event.data as { requestId?: string; chainId?: number; items?: Array<{ wallet: string; topUpWei: string }> };
      if (typeof data.requestId !== 'string' || typeof data.chainId !== 'number' || !targets.has(data.chainId) || !Array.isArray(data.items)) continue;
      let card: SystemCard;
      try { card = fundingRequestCard({ chainId: data.chainId, treasury: this.options.treasury, items: data.items, at: event.at }); } catch { continue; }
      await this.options.alerts.send({ kind: 'funding_request', dedupe: `funding_request:${data.requestId}`, priority: 'immediate', text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
    }
  }

  private async trackBlindness(result: WatchTickResult, now: Date): Promise<void> {
    if (result.checked === 0 && result.failed > 0) this.consecutiveBlind += 1;
    else if (result.checked > 0) { this.consecutiveBlind = 0; this.blindAlerted = false; }
    if (this.consecutiveBlind >= WATCH_BLIND_AFTER_FAILURES && !this.blindAlerted) {
      this.blindAlerted = true;
      const chainId = this.options.targets[0]!.chainId;
      const card = fleetWatchCard({ finding: 'watcher_blind', chainId, at: now });
      await this.options.alerts.send({ kind: 'fleet_watch', dedupe: `fleet_watch:blind:${Math.floor(now.getTime() / DAY_MS)}`, priority: 'immediate', text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
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
      for (const { target } of chainObservations) {
        const address = target.address.toLowerCase();
        const baseline = this.baselines.get(keyOf(target));
        if (!baseline) continue;
        const after = step.next[address];
        const same = JSON.stringify(after ?? null) === JSON.stringify(baseline.excess ?? null);
        if (same) continue;
        const { excess: _drop, ...rest } = baseline;
        void _drop;
        const updated: WalletBaseline = { ...rest, ...(after ? { excess: after } : {}) };
        this.baselines.set(keyOf(target), updated);
        await this.persist('fleet_watch_baseline', { chainId, address, nonce: updated.nonce, balanceWei: updated.balanceWei, observedAt: updated.observedAt, ...(after ? { excess: after } : {}) });
      }
      if (step.reminders.length > 0) {
        const card = excessBalanceCard({ chainId, treasury: this.options.treasury, reminders: step.reminders, at: now });
        const bucket = Math.floor(now.getTime() / DAY_MS);
        await this.options.alerts.send({ kind: 'excess_balance', dedupe: `excess_balance:${chainId}:${bucket}`, priority: 'immediate', text: card.summary, system: card, at: now.toISOString() }).catch(() => false);
        result.reminders += step.reminders.length;
      }
    }
  }
}
