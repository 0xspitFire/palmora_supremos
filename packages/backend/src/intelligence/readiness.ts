import { randomUUID } from 'node:crypto';
import { PERSONAL_LIVE_FLEET_POLICY } from '../fleet-policy.js';
import type { BackendStore } from '../store.js';
import type { EventRecord } from '../types.js';
import { READINESS_FRESHNESS_MS, calendarId, type IntelligenceAlertSink, type IntelligenceChainPort } from './port.js';
import { plainAlertText } from '../alert-card.js';
import { CollectionNames } from './names.js';
import { eligibleReadyCard, quantityReducedCard, underfundedCard } from './cards.js';
import { formatEth, paidQuantityForScore } from './scoring.js';
import { planFreeQuantity, planningMaxFeeWei, type QuantityPlan } from './quantity-plan.js';

/**
 * Wallet-by-drop readiness sweep (T-004, P2-05, D-033). Read-only: it checks
 * balances and runs eth_call simulations, and never funds, signs, or sends.
 * Readiness is advice for the owner; live admission re-checks everything.
 */
export interface ReadinessLimits {
  freeFeeAllowanceWei: bigint;
  paidFeeAllowanceWei: bigint;
  paidMaxPricePerNftWei: bigint;
  paidMaxWalletsPerMint: number;
  /** Owner preference: at least this many wallets for a free mint (D-032). */
  freeMinWallets: number;
}

/**
 * Owner-approved Personal Live limits (D-033) as used for readiness advice. Derived from the
 * admission fleet policy, so readiness advice and admission can never disagree on a limit.
 */
export const D033_READINESS_LIMITS: Readonly<ReadinessLimits> = Object.freeze({
  freeFeeAllowanceWei: PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei,
  paidFeeAllowanceWei: PERSONAL_LIVE_FLEET_POLICY.paidFeeAllowanceWei,
  paidMaxPricePerNftWei: PERSONAL_LIVE_FLEET_POLICY.paidMaxPricePerNftWei,
  paidMaxWalletsPerMint: PERSONAL_LIVE_FLEET_POLICY.paidMaxWalletsPerMint,
  /** Owner preference (D-032), advice only: admission does not require a minimum wallet count. */
  freeMinWallets: 4,
});

export interface ReadinessOptions {
  now?: () => Date;
  limits: ReadinessLimits;
  alerts?: IntelligenceAlertSink;
  /** Advice only: every actual run is checked against current reservations at admission. */
  freeActivePeriodCapWei?: bigint;
  freeMaxQuantity?: number;
  paidAllowed?: boolean;
  /** Collection names read from the chain; one reader can be shared with discovery. */
  names?: CollectionNames;
}

export type WalletReadinessState = 'ready' | 'funded' | 'unfunded' | 'blocked' | 'skipped' | 'unknown';
export interface WalletReadiness { wallet: string; state: WalletReadinessState; reason: string; balanceWei: string | null; requiredWei: string; topUpWei: string | null; }

interface ReadinessView { calendars: Map<string, EventRecord>; scores: Map<string, EventRecord>; sweeps: Map<string, EventRecord>; }

interface CalendarView { id: string; contract: string; startMs: number; endMs: number; priceWei: bigint; maxPerWallet: number; }

const HOUR = 60 * 60_000;
const HOT_WINDOW_MS = 2 * HOUR;
const LOOKAHEAD_MS = 24 * HOUR;
const COLD_REFRESH_MS = 30 * 60_000;
const HOT_REFRESH_MS = READINESS_FRESHNESS_MS - 30_000;
/** Anyone can publish a drop, so the sweep and its alerts are bounded (security review T-004). */
const MAX_DROPS_PER_SWEEP = 20;
const MAX_READINESS_ALERTS_PER_DAY = 20;
const IMMEDIATE_MIN_SCORE = 40;

export class ReadinessSweep {
  private readonly now: () => Date;
  private readonly lastEmit = new Map<string, { at: number; signature: string }>();
  private readonly alertTimes: number[] = [];

  private readonly names: CollectionNames;

  public constructor(private readonly store: BackendStore, private readonly port: IntelligenceChainPort, private readonly wallets: () => Promise<readonly string[]>, private readonly options: ReadinessOptions) {
    if ((options.freeActivePeriodCapWei !== undefined && (typeof options.freeActivePeriodCapWei !== 'bigint' || options.freeActivePeriodCapWei < 0n))
      || (options.freeMaxQuantity !== undefined && (!Number.isSafeInteger(options.freeMaxQuantity) || options.freeMaxQuantity < 1 || options.freeMaxQuantity > 15))) throw new Error('READINESS_ADVISORY_LIMIT_INVALID');
    this.now = options.now ?? (() => new Date());
    this.names = options.names ?? new CollectionNames(port);
  }

  public async tick(): Promise<{ drops: number; written: number; alertsRaised: number }> {
    const nowDate = this.now();
    const now = nowDate.getTime();
    const wallets = [...new Set((await this.wallets()).map((wallet) => wallet.toLowerCase()))].sort();
    // This is a read-only advisory snapshot for this sweep, never execution authority.
    const view = this.tickView(this.store.snapshot().events);
    const drops = this.relevantDrops(now, view);
    const activeKeys = new Set(drops.map(drop => this.cacheKey(drop.id)));
    for (const key of this.lastEmit.keys()) if (!activeKeys.has(key)) this.lastEmit.delete(key);
    const events: EventRecord[] = [];
    let alertsRaised = 0;
    for (const drop of drops) {
      const boundedDrop = this.options.freeMaxQuantity === undefined || drop.priceWei !== 0n ? drop : { ...drop, maxPerWallet: Math.min(drop.maxPerWallet, this.options.freeMaxQuantity) };
      const plan = await this.plan(boundedDrop, view, wallets[0]);
      const rows: WalletReadiness[] = [];
      for (const wallet of wallets) rows.push(await this.check(wallet, drop, plan, now));
      if (plan.kind === 'paid') this.limitWallets(rows, this.options.limits.paidMaxWalletsPerMint, 'PAID_WALLET_LIMIT');
      else if (this.options.freeActivePeriodCapWei !== undefined && plan.requiredWei > 0n) {
        const capacity = this.options.freeActivePeriodCapWei / plan.requiredWei;
        const maxWallets = capacity > BigInt(rows.length) ? rows.length : Number(capacity);
        this.limitWallets(rows, maxWallets, 'FREE_FLEET_LIMIT');
      }
      const signature = rows.map((row) => `${row.wallet}:${row.state}:${row.reason}`).join('|');
      const last = this.lastEmit.get(this.cacheKey(drop.id)) ?? this.restoreLast(drop.id, view);
      const hot = drop.startMs <= now || drop.startMs - now <= HOT_WINDOW_MS;
      const due = !last || last.signature !== signature || now - last.at >= (hot ? HOT_REFRESH_MS : COLD_REFRESH_MS);
      if (due) {
        events.push({ id: `evt_${randomUUID()}`, type: 'readiness_sweep', at: nowDate.toISOString(), data: { id: `readiness:${drop.id}`, calendarId: drop.id, contract: drop.contract, chainId: this.port.chainId, mintClass: plan.kind, quantity: plan.quantity, ...(plan.quantityPlan ? { quantityPlan: { desired: plan.quantityPlan.desired, planned: plan.quantityPlan.planned, reduced: plan.quantityPlan.reduced, reason: plan.quantityPlan.reason, maxFeeGwei: plan.quantityPlan.maxFeeGwei, message: plan.quantityPlan.message } } : {}), requiredWei: plan.requiredWei.toString(), rows, expiresAt: new Date(now + (hot ? READINESS_FRESHNESS_MS : COLD_REFRESH_MS + 60_000)).toISOString() } });
        this.lastEmit.set(this.cacheKey(drop.id), { at: now, signature });
      }
      alertsRaised += await this.alert(drop, plan, rows, now, view);
    }
    if (events.length > 0) await this.store.transaction((state) => { state.events.push(...events); });
    return { drops: drops.length, written: events.length, alertsRaised };
  }

  private cacheKey(id: string): string { return `${this.port.chainId}:${id}`; }

  private tickView(events: readonly EventRecord[]): ReadinessView {
    const view: ReadinessView = { calendars: new Map(), scores: new Map(), sweeps: new Map() };
    const newest = (map: Map<string, EventRecord>, key: string, event: EventRecord): void => {
      const prior = map.get(key);
      if (!prior || event.at >= prior.at) map.set(key, event);
    };
    for (const event of events) {
      // Legacy records with no explicit chain are not evidence for any chain.
      // Even matching numeric addresses or an ID prefix cannot supply authority.
      if (event.data.chainId !== this.port.chainId) continue;
      const contract = event.data.contract;
      if (typeof contract !== 'string' || !/^0x[0-9a-f]{40}$/.test(contract)) continue;
      if (event.type === 'calendar_entry' && event.data.id === calendarId(this.port.chainId, contract)) newest(view.calendars, event.data.id, event);
      else if (event.type.startsWith('opportunity_')) newest(view.scores, contract, event);
      else if (event.type === 'readiness_sweep' && event.data.calendarId === calendarId(this.port.chainId, contract)) newest(view.sweeps, event.data.calendarId, event);
    }
    return view;
  }

  private relevantDrops(now: number, view: ReadinessView): CalendarView[] {
    const views: CalendarView[] = [];
    for (const [id, event] of view.calendars) {
      const startMs = typeof event.data.openingAt === 'string' ? Date.parse(event.data.openingAt) : Number.NaN;
      const endMs = typeof event.data.closingAt === 'string' ? Date.parse(event.data.closingAt) : Number.POSITIVE_INFINITY;
      const price = typeof event.data.priceWei === 'string' && /^\d+$/.test(event.data.priceWei) ? BigInt(event.data.priceWei) : null;
      const maxPerWallet = Number(event.data.maxPerWallet);
      const contract = String(event.data.contract ?? '');
      // Unknown facts are skipped rather than guessed; the calendar shows them as unknown.
      if (!Number.isFinite(startMs) || price === null || !Number.isSafeInteger(maxPerWallet) || !/^0x[0-9a-f]{40}$/.test(contract)) continue;
      const expires = typeof event.data.expiresAt === 'string' ? Date.parse(event.data.expiresAt) : 0;
      if (expires <= now) continue;
      if (endMs <= now || startMs - now > LOOKAHEAD_MS) continue;
      views.push({ id, contract, startMs, endMs, priceWei: price, maxPerWallet });
    }
    return views.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id)).slice(0, MAX_DROPS_PER_SWEEP);
  }

  private async plan(drop: CalendarView, view: ReadinessView, estimator?: string): Promise<{ kind: 'free' | 'paid'; quantity: number; requiredWei: bigint; blockReason?: string; quantityPlan?: QuantityPlan }> {
    const limits = this.options.limits;
    if (drop.priceWei === 0n) {
      if (drop.maxPerWallet <= 0) return { kind: 'free', quantity: 0, requiredWei: limits.freeFeeAllowanceWei, blockReason: 'NO_MINT_ALLOWANCE' };
      // D-037: plan the largest quantity whose padded worst-case fee fits the allowance at the current fee.
      const quantityPlan = await this.planFreeQuantity(drop, estimator);
      if (quantityPlan?.reason === 'cannot_fit_one') return { kind: 'free', quantity: 0, requiredWei: limits.freeFeeAllowanceWei, blockReason: 'FEES_TOO_HIGH', quantityPlan };
      return { kind: 'free', quantity: quantityPlan?.planned ?? drop.maxPerWallet, requiredWei: limits.freeFeeAllowanceWei, ...(quantityPlan ? { quantityPlan } : {}) };
    }
    if (this.options.paidAllowed === false) return { kind: 'paid', quantity: 0, requiredWei: 0n, blockReason: 'PAID_CHAIN_NOT_ENABLED' };
    if (drop.priceWei > limits.paidMaxPricePerNftWei) return { kind: 'paid', quantity: 0, requiredWei: 0n, blockReason: 'PRICE_ABOVE_LIMIT' };
    const score = this.latestScore(drop.contract, view);
    const byScore = paidQuantityForScore(score);
    const quantity = drop.maxPerWallet > 0 ? Math.min(byScore, drop.maxPerWallet) : byScore;
    if (quantity === 0) return { kind: 'paid', quantity: 0, requiredWei: 0n, blockReason: score === null ? 'SCORE_UNKNOWN' : 'SCORE_TOO_LOW' };
    return { kind: 'paid', quantity, requiredWei: drop.priceWei * BigInt(quantity) + limits.paidFeeAllowanceWei };
  }

  private async check(wallet: string, drop: CalendarView, plan: Awaited<ReturnType<ReadinessSweep['plan']>>, now: number): Promise<WalletReadiness> {
    const base = { wallet, requiredWei: plan.requiredWei.toString(), topUpWei: null };
    if (plan.blockReason) return { ...base, state: plan.blockReason === 'NO_MINT_ALLOWANCE' || plan.blockReason === 'PRICE_ABOVE_LIMIT' || plan.blockReason === 'PAID_CHAIN_NOT_ENABLED' ? 'blocked' : 'skipped', reason: plan.blockReason, balanceWei: null };
    const balance = await this.port.balance(wallet);
    if (balance === null) return { ...base, state: 'unknown', reason: 'BALANCE_UNAVAILABLE', balanceWei: null };
    if (balance < plan.requiredWei) return { ...base, state: 'unfunded', reason: 'NEEDS_TOP_UP', balanceWei: balance.toString(), topUpWei: (plan.requiredWei - balance).toString() };
    if (drop.startMs > now) return { ...base, state: 'funded', reason: 'CHECK_RUNS_WHEN_OPEN', balanceWei: balance.toString() };
    const simulation = await this.port.simulateMint(wallet, drop.contract, plan.quantity, drop.priceWei * BigInt(plan.quantity));
    if (simulation.outcome === 'pass') return { ...base, state: 'ready', reason: 'SIMULATION_PASSED', balanceWei: balance.toString() };
    if (simulation.outcome === 'fail') return { ...base, state: 'blocked', reason: `SIMULATION_FAILED:${simulation.reason}`.slice(0, 120), balanceWei: balance.toString() };
    return { ...base, state: 'funded', reason: 'SIMULATION_UNAVAILABLE', balanceWei: balance.toString() };
  }

  /** Keep every advisory row; only the best-funded wallets inside this plan's bound remain eligible. */
  private limitWallets(rows: WalletReadiness[], maxWallets: number, reason: 'PAID_WALLET_LIMIT' | 'FREE_FLEET_LIMIT'): void {
    const byBalance = (left: WalletReadiness, right: WalletReadiness): number => {
      const a = BigInt(left.balanceWei ?? '0');
      const b = BigInt(right.balanceWei ?? '0');
      return a === b ? left.wallet.localeCompare(right.wallet) : a > b ? -1 : 1;
    };
    const funded = rows.filter((row) => row.state === 'ready' || row.state === 'funded').sort(byBalance);
    const unfunded = rows.filter((row) => row.state === 'unfunded').sort(byBalance);
    const keep = new Set([...funded, ...unfunded].slice(0, maxWallets).map((row) => row.wallet));
    for (const row of rows) {
      if ((row.state === 'ready' || row.state === 'funded' || row.state === 'unfunded') && !keep.has(row.wallet)) { row.state = 'skipped'; row.reason = reason; row.topUpWei = null; }
    }
  }

  private async alert(drop: CalendarView, plan: Awaited<ReturnType<ReadinessSweep['plan']>>, rows: readonly WalletReadiness[], now: number, view: ReadinessView): Promise<number> {
    const sink = this.options.alerts;
    if (!sink) return 0;
    // The collection name is read from the chain first; the label (ETH MINT) is only for a contract that has none.
    const collectionName = await this.names.get(drop.contract);
    const base = { chainId: this.port.chainId, contract: drop.contract, collectionName, startMs: drop.startMs, priceWei: drop.priceWei, maxPerWallet: drop.maxPerWallet, now };
    let reducedAlerts = 0;
    // D-037: whenever fees cut the planned quantity (or rule a mint out), tell the owner why. One per drop and quantity, bundled.
    if (plan.quantityPlan?.reduced && this.alertAllowed(now)) {
      const card = quantityReducedCard({ ...base, message: plan.quantityPlan.message });
      if (await safe(sink, { kind: 'quantity_reduced', dedupe: `quantity:${drop.id}:${plan.quantityPlan.planned}`, priority: 'grouped', text: plainAlertText(card), card })) reducedAlerts += 1;
    }
    if (plan.blockReason) return reducedAlerts;
    // Only a drop the scorer rated worth a look may interrupt immediately; everything else waits for the digest.
    const score = this.latestScore(drop.contract, view);
    const soon = drop.startMs - now <= HOUR && score !== null && score >= IMMEDIATE_MIN_SCORE;
    let raised = reducedAlerts;
    const unfunded = rows.filter((row) => row.state === 'unfunded');
    if (unfunded.length > 0 && this.alertAllowed(now)) {
      const card = underfundedCard({ ...base, wallets: unfunded.map((row) => ({ wallet: row.wallet, topUpWei: BigInt(row.topUpWei ?? '0') })), requiredWei: plan.requiredWei, plan: plan.kind === 'free' ? 'free mint, network fee allowance' : `${plan.quantity} NFT(s) plus network fee allowance` });
      if (await safe(sink, { kind: 'underfunded', dedupe: `underfunded:${drop.id}:${unfunded.map((row) => `${row.wallet}=${row.topUpWei ?? '?'}`).join(',')}`, priority: 'grouped', text: plainAlertText(card), card })) raised += 1; // top-up reminders always go in the bundle (T-011)
    }
    const ready = rows.filter((row) => row.state === 'ready').length;
    if (ready > 0 && this.alertAllowed(now)) {
      const preference = plan.kind === 'free' && ready < this.options.limits.freeMinWallets ? ` You asked for at least ${this.options.limits.freeMinWallets} wallets on free mints.` : '';
      const planText = plan.kind === 'free' ? `free, ${plan.quantity} each${plan.quantityPlan?.reduced ? ` instead of ${plan.quantityPlan.desired} because of network fees` : ''}` : `${plan.quantity} each at ${formatEth(drop.priceWei)} ETH`;
      const card = eligibleReadyCard({ ...base, ready, total: rows.length, plan: planText, note: `${plan.kind === 'paid' ? 'Paid minting requires your final fire approval.' : 'Readiness is advice; automatic free minting still requires a qualifying watched mint and every execution check.'}${preference}` });
      if (await safe(sink, { kind: 'eligible_ready', dedupe: `ready:${drop.id}:${ready}`, priority: soon ? 'immediate' : 'grouped', text: plainAlertText(card), card })) raised += 1;
    }
    return raised;
  }

  /** Returns null when the port cannot estimate gas or fees, in which case the full allowance is kept. */
  private async planFreeQuantity(drop: CalendarView, estimator: string | undefined): Promise<QuantityPlan | null> {
    const { estimateMintGas, baseFeePerGasWei } = this.port;
    if (!estimator || !estimateMintGas || !baseFeePerGasWei) return null;
    try {
      const baseFee = await baseFeePerGasWei.call(this.port);
      if (baseFee === null || baseFee < 0n) return null;
      return await planFreeQuantity({ desired: drop.maxPerWallet, allowanceWei: this.options.limits.freeFeeAllowanceWei, maxFeePerGasWei: planningMaxFeeWei(baseFee), gasForQuantity: (quantity) => estimateMintGas.call(this.port, estimator, drop.contract, quantity, 0n) });
    } catch { return null; }
  }

  private alertAllowed(now: number): boolean {
    while (this.alertTimes.length > 0 && now - this.alertTimes[0]! > 24 * HOUR) this.alertTimes.shift();
    if (this.alertTimes.length >= MAX_READINESS_ALERTS_PER_DAY) return false;
    this.alertTimes.push(now);
    return true;
  }

  private latestScore(contract: string, view: ReadinessView): number | null {
    const latest = view.scores.get(contract);
    if (!latest || latest.data.blocked === true) return null;
    const score = Number(latest.data.score);
    return Number.isFinite(score) ? score : null;
  }

  private restoreLast(id: string, view: ReadinessView): { at: number; signature: string } | undefined {
    const latest = view.sweeps.get(id);
    if (!latest || !Array.isArray(latest.data.rows)) return undefined;
    const rows = latest.data.rows as WalletReadiness[];
    const value = { at: Date.parse(latest.at), signature: rows.map((row) => `${row.wallet}:${row.state}:${row.reason}`).join('|') };
    this.lastEmit.set(this.cacheKey(id), value);
    return value;
  }
}

async function safe(sink: IntelligenceAlertSink, input: Parameters<IntelligenceAlertSink['intelligence']>[0]): Promise<boolean> {
  try { return await sink.intelligence(input); } catch { return false; }
}
