import { randomUUID } from 'node:crypto';
import type { BackendStore } from '../store.js';
import type { EventRecord } from '../types.js';
import { READINESS_FRESHNESS_MS, shortAddress, type IntelligenceAlertSink, type IntelligenceChainPort } from './port.js';
import { formatEth, paidQuantityForScore } from './scoring.js';

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
 * Owner-approved Personal Live limits (D-033), as used for readiness advice.
 * Admission enforces the same values separately (T-003 fleet policy); unify when both merge.
 */
export const D033_READINESS_LIMITS: Readonly<ReadinessLimits> = Object.freeze({
  freeFeeAllowanceWei: 400_000_000_000_000n,
  paidFeeAllowanceWei: 370_000_000_000_000n,
  paidMaxPricePerNftWei: 3_700_000_000_000_000n,
  paidMaxWalletsPerMint: 2,
  freeMinWallets: 4,
});

export interface ReadinessOptions { now?: () => Date; limits: ReadinessLimits; alerts?: IntelligenceAlertSink; }

export type WalletReadinessState = 'ready' | 'funded' | 'unfunded' | 'blocked' | 'skipped' | 'unknown';
export interface WalletReadiness { wallet: string; state: WalletReadinessState; reason: string; balanceWei: string | null; requiredWei: string; topUpWei: string | null; }

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

  public constructor(private readonly store: BackendStore, private readonly port: IntelligenceChainPort, private readonly wallets: () => Promise<readonly string[]>, private readonly options: ReadinessOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async tick(): Promise<{ drops: number; written: number; alertsRaised: number }> {
    const nowDate = this.now();
    const now = nowDate.getTime();
    const wallets = [...new Set((await this.wallets()).map((wallet) => wallet.toLowerCase()))].sort();
    const drops = this.relevantDrops(now);
    const events: EventRecord[] = [];
    let alertsRaised = 0;
    for (const drop of drops) {
      const plan = this.plan(drop);
      const rows: WalletReadiness[] = [];
      for (const wallet of wallets) rows.push(await this.check(wallet, drop, plan, now));
      if (plan.kind === 'paid') this.limitPaidWallets(rows);
      const signature = rows.map((row) => `${row.wallet}:${row.state}:${row.reason}`).join('|');
      const last = this.lastEmit.get(drop.id) ?? this.restoreLast(drop.id);
      const hot = drop.startMs <= now || drop.startMs - now <= HOT_WINDOW_MS;
      const due = !last || last.signature !== signature || now - last.at >= (hot ? HOT_REFRESH_MS : COLD_REFRESH_MS);
      if (due) {
        events.push({ id: `evt_${randomUUID()}`, type: 'readiness_sweep', at: nowDate.toISOString(), data: { id: `readiness:${drop.id}`, calendarId: drop.id, contract: drop.contract, chainId: this.port.chainId, mintClass: plan.kind, quantity: plan.quantity, requiredWei: plan.requiredWei.toString(), rows, expiresAt: new Date(now + (hot ? READINESS_FRESHNESS_MS : COLD_REFRESH_MS + 60_000)).toISOString() } });
        this.lastEmit.set(drop.id, { at: now, signature });
      }
      alertsRaised += await this.alert(drop, plan, rows, now);
    }
    if (events.length > 0) await this.store.transaction((state) => { state.events.push(...events); });
    return { drops: drops.length, written: events.length, alertsRaised };
  }

  private relevantDrops(now: number): CalendarView[] {
    const latest = new Map<string, EventRecord>();
    for (const event of this.store.snapshot().events) {
      if (event.type !== 'calendar_entry') continue;
      const id = String(event.data.id ?? '');
      const prior = latest.get(id);
      if (!prior || event.at >= prior.at) latest.set(id, event);
    }
    const views: CalendarView[] = [];
    for (const [id, event] of latest) {
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

  private plan(drop: CalendarView): { kind: 'free' | 'paid'; quantity: number; requiredWei: bigint; blockReason?: string } {
    const limits = this.options.limits;
    if (drop.priceWei === 0n) {
      if (drop.maxPerWallet <= 0) return { kind: 'free', quantity: 0, requiredWei: limits.freeFeeAllowanceWei, blockReason: 'NO_MINT_ALLOWANCE' };
      return { kind: 'free', quantity: drop.maxPerWallet, requiredWei: limits.freeFeeAllowanceWei };
    }
    if (drop.priceWei > limits.paidMaxPricePerNftWei) return { kind: 'paid', quantity: 0, requiredWei: 0n, blockReason: 'PRICE_ABOVE_LIMIT' };
    const score = this.latestScore(drop.contract);
    const byScore = paidQuantityForScore(score);
    const quantity = drop.maxPerWallet > 0 ? Math.min(byScore, drop.maxPerWallet) : byScore;
    if (quantity === 0) return { kind: 'paid', quantity: 0, requiredWei: 0n, blockReason: score === null ? 'SCORE_UNKNOWN' : 'SCORE_TOO_LOW' };
    return { kind: 'paid', quantity, requiredWei: drop.priceWei * BigInt(quantity) + limits.paidFeeAllowanceWei };
  }

  private async check(wallet: string, drop: CalendarView, plan: ReturnType<ReadinessSweep['plan']>, now: number): Promise<WalletReadiness> {
    const base = { wallet, requiredWei: plan.requiredWei.toString(), topUpWei: null };
    if (plan.blockReason) return { ...base, state: plan.blockReason === 'NO_MINT_ALLOWANCE' || plan.blockReason === 'PRICE_ABOVE_LIMIT' ? 'blocked' : 'skipped', reason: plan.blockReason, balanceWei: null };
    const balance = await this.port.balance(wallet);
    if (balance === null) return { ...base, state: 'unknown', reason: 'BALANCE_UNAVAILABLE', balanceWei: null };
    if (balance < plan.requiredWei) return { ...base, state: 'unfunded', reason: 'NEEDS_TOP_UP', balanceWei: balance.toString(), topUpWei: (plan.requiredWei - balance).toString() };
    if (drop.startMs > now) return { ...base, state: 'funded', reason: 'CHECK_RUNS_WHEN_OPEN', balanceWei: balance.toString() };
    const simulation = await this.port.simulateMint(wallet, drop.contract, plan.quantity, drop.priceWei * BigInt(plan.quantity));
    if (simulation.outcome === 'pass') return { ...base, state: 'ready', reason: 'SIMULATION_PASSED', balanceWei: balance.toString() };
    if (simulation.outcome === 'fail') return { ...base, state: 'blocked', reason: `SIMULATION_FAILED:${simulation.reason}`.slice(0, 120), balanceWei: balance.toString() };
    return { ...base, state: 'funded', reason: 'SIMULATION_UNAVAILABLE', balanceWei: balance.toString() };
  }

  /** D-032: at most N wallets per paid mint. The best-funded eligible wallets keep their plan; the rest are skipped. */
  private limitPaidWallets(rows: WalletReadiness[]): void {
    const byBalance = (left: WalletReadiness, right: WalletReadiness): number => {
      const a = BigInt(left.balanceWei ?? '0');
      const b = BigInt(right.balanceWei ?? '0');
      return a === b ? left.wallet.localeCompare(right.wallet) : a > b ? -1 : 1;
    };
    const funded = rows.filter((row) => row.state === 'ready' || row.state === 'funded').sort(byBalance);
    const unfunded = rows.filter((row) => row.state === 'unfunded').sort(byBalance);
    const keep = new Set([...funded, ...unfunded].slice(0, this.options.limits.paidMaxWalletsPerMint).map((row) => row.wallet));
    for (const row of rows) {
      if ((row.state === 'ready' || row.state === 'funded' || row.state === 'unfunded') && !keep.has(row.wallet)) { row.state = 'skipped'; row.reason = 'PAID_WALLET_LIMIT'; row.topUpWei = null; }
    }
  }

  private async alert(drop: CalendarView, plan: ReturnType<ReadinessSweep['plan']>, rows: readonly WalletReadiness[], now: number): Promise<number> {
    const sink = this.options.alerts;
    if (!sink || plan.blockReason) return 0;
    const name = `Ethereum mint ${shortAddress(drop.contract)}`;
    // Only a drop the scorer rated worth a look may interrupt immediately; everything else waits for the digest.
    const score = this.latestScore(drop.contract);
    const soon = drop.startMs - now <= HOUR && score !== null && score >= IMMEDIATE_MIN_SCORE;
    const opens = drop.startMs > now ? `opens in ${formatDuration(drop.startMs - now)}` : 'is open now';
    let raised = 0;
    const unfunded = rows.filter((row) => row.state === 'unfunded');
    if (unfunded.length > 0) {
      const lines = unfunded.map((row) => `send ${formatEth(BigInt(row.topUpWei ?? '0'))} ETH to ${row.wallet}`);
      const text = `${unfunded.length} wallet(s) need more ETH for ${name}, which ${opens}. On Ethereum: ${lines.join('; ')}. Each needs ${formatEth(plan.requiredWei)} ETH in total${plan.kind === 'free' ? ' (free mint, network fee allowance)' : ` (${plan.quantity} NFT(s) plus network fee allowance)`}.`;
      if (this.alertAllowed(now) && await safe(sink, { kind: 'underfunded', dedupe: `underfunded:${drop.id}:${unfunded.map((row) => `${row.wallet}=${row.topUpWei ?? '?'}`).join(',')}`, priority: 'grouped', text })) raised += 1; // top-up reminders always go in the bundle (T-011)
    }
    const ready = rows.filter((row) => row.state === 'ready').length;
    if (ready > 0) {
      const preference = plan.kind === 'free' && ready < this.options.limits.freeMinWallets ? ` You asked for at least ${this.options.limits.freeMinWallets} wallets on free mints.` : '';
      const text = `${ready} of ${rows.length} wallets are ready for ${name}, which ${opens} (${plan.kind === 'free' ? `free, ${plan.quantity} each` : `${plan.quantity} each at ${formatEth(drop.priceWei)} ETH`}). Minting still needs your approval.${preference}`;
      if (this.alertAllowed(now) && await safe(sink, { kind: 'eligible_ready', dedupe: `ready:${drop.id}:${ready}`, priority: soon ? 'immediate' : 'grouped', text })) raised += 1;
    }
    return raised;
  }

  private alertAllowed(now: number): boolean {
    while (this.alertTimes.length > 0 && now - this.alertTimes[0]! > 24 * HOUR) this.alertTimes.shift();
    if (this.alertTimes.length >= MAX_READINESS_ALERTS_PER_DAY) return false;
    this.alertTimes.push(now);
    return true;
  }

  private latestScore(contract: string): number | null {
    let latest: EventRecord | undefined;
    for (const event of this.store.snapshot().events) if (event.type.startsWith('opportunity_') && String(event.data.contract ?? '') === contract && (!latest || event.at >= latest.at)) latest = event;
    if (!latest || latest.data.blocked === true) return null;
    const score = Number(latest.data.score);
    return Number.isFinite(score) ? score : null;
  }

  private restoreLast(id: string): { at: number; signature: string } | undefined {
    let latest: EventRecord | undefined;
    for (const event of this.store.snapshot().events) if (event.type === 'readiness_sweep' && event.data.calendarId === id && (!latest || event.at >= latest.at)) latest = event;
    if (!latest || !Array.isArray(latest.data.rows)) return undefined;
    const rows = latest.data.rows as WalletReadiness[];
    const value = { at: Date.parse(latest.at), signature: rows.map((row) => `${row.wallet}:${row.state}:${row.reason}`).join('|') };
    this.lastEmit.set(id, value);
    return value;
  }
}

async function safe(sink: IntelligenceAlertSink, input: Parameters<IntelligenceAlertSink['intelligence']>[0]): Promise<boolean> {
  try { return await sink.intelligence(input); } catch { return false; }
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 90 ? `${minutes} minutes` : `about ${Math.round(minutes / 60)} hours`;
}
