import type { BalanceCeiling, BalanceCeilings } from './compensating-controls.js';

/**
 * D-059 items 3 and 5: run-time funding and the left-over-balance reminder. Pure planning only. MintBot never signs or sends a
 * funding transfer: it works out what each wallet needs for ONE run, asks the owner to send it, and checks it arrived.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** D-059 item 2: 0.0004 per wallet and 0.002 for the fleet while no run is funded, in each chain's native unit. */
export const DEFAULT_IDLE_BALANCE_CEILINGS: BalanceCeilings = {
  1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n },
  8453: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n },
  4663: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n },
};

export const EXCESS_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
/** Amounts are shown to the owner rounded UP to 0.000001 ETH, so the envelope carries that much room (D-059: reserved exposure plus a small fixed margin). */
export const FUNDING_ROUNDING_MARGIN_WEI = 1_000_000_000_000n;
/** Rounds an amount up to the 0.000001 ETH the owner is shown, so the amount sent is never short. */
export const roundUpToDisplay = (wei: bigint): bigint => ((wei + FUNDING_ROUNDING_MARGIN_WEI - 1n) / FUNDING_ROUNDING_MARGIN_WEI) * FUNDING_ROUNDING_MARGIN_WEI;

export interface FundingWalletInput {
  address: string;
  balanceWei: bigint;
  /** The run's own reserved worst case for this wallet: mint price x quantity + total fee budget (the same figure live-run shows). */
  requiredWei: bigint;
}

export interface FundingPlanItem {
  wallet: string;
  balanceWei: string;
  requiredWei: string;
  envelopeWei: string;
  /** What the owner should send to this wallet; "0" when it already holds enough. */
  topUpWei: string;
}

export interface FundingPlan {
  chainId: number;
  items: FundingPlanItem[];
  totalTopUpWei: string;
  /** Feed to `CompensatingAssuranceConfig.runEnvelopeWei`. */
  runEnvelopeWei: Record<string, string>;
  /** Feed to `CompensatingAssuranceConfig.minimumBalanceWei`: the run cannot arm below this. */
  minimumBalanceWei: Record<string, string>;
  /** Reasons the run cannot be funded as asked. Non-empty means no request is made and the run cannot arm. */
  blockers: string[];
  /** True only when there are no blockers and nothing is left to send. */
  ready: boolean;
}

export function planRunFunding(input: { chainId: number; ceiling: BalanceCeiling | undefined; wallets: readonly FundingWalletInput[]; marginWei?: bigint }): FundingPlan {
  const plan: FundingPlan = { chainId: input.chainId, items: [], totalTopUpWei: '0', runEnvelopeWei: {}, minimumBalanceWei: {}, blockers: [], ready: false };
  const ceiling = input.ceiling;
  if (!ceiling || ceiling.walletMaxWei <= 0n || ceiling.fleetMaxWei <= 0n) { plan.blockers.push('NO_BALANCE_CEILING_FOR_CHAIN'); return plan; }
  if (input.wallets.length === 0) { plan.blockers.push('NO_WALLETS'); return plan; }
  const margin = input.marginWei ?? FUNDING_ROUNDING_MARGIN_WEI;
  if (margin < 0n) { plan.blockers.push('MARGIN_INVALID'); return plan; }
  const walletBound = ceiling.runEnvelopeMaxWei !== undefined && ceiling.runEnvelopeMaxWei > ceiling.walletMaxWei ? ceiling.runEnvelopeMaxWei : ceiling.walletMaxWei;
  const fleetBound = ceiling.runEnvelopeFleetMaxWei !== undefined && ceiling.runEnvelopeFleetMaxWei > ceiling.fleetMaxWei ? ceiling.runEnvelopeFleetMaxWei : ceiling.fleetMaxWei;
  const seen = new Set<string>();
  let total = 0n;
  let envelopeTotal = 0n;
  for (const wallet of input.wallets) {
    if (!ADDRESS.test(wallet.address)) { plan.blockers.push('WALLET_ADDRESS_INVALID'); continue; }
    const address = wallet.address.toLowerCase();
    if (seen.has(address)) { plan.blockers.push(`DUPLICATE_WALLET:${address}`); continue; }
    seen.add(address);
    if (wallet.requiredWei <= 0n || wallet.balanceWei < 0n) { plan.blockers.push(`REQUIREMENT_INVALID:${address}`); continue; }
    // The run itself must fit the chain's bound; the rounding margin is added only as far as the bound allows.
    if (wallet.requiredWei > walletBound) plan.blockers.push(`RUN_ENVELOPE_ABOVE_CHAIN_BOUND:${address}`);
    const padded = wallet.requiredWei + margin;
    const envelope = padded > walletBound && wallet.requiredWei <= walletBound ? walletBound : padded;
    // The envelope never has to be smaller than the idle ceiling: a run that needs less than the ceiling just uses the ceiling.
    const limit = envelope > ceiling.walletMaxWei ? envelope : ceiling.walletMaxWei;
    // Carried surplus never raises the envelope: the owner returns it first.
    if (wallet.balanceWei > limit) plan.blockers.push(`WALLET_ABOVE_RUN_ENVELOPE:${address}`);
    const shortfall = wallet.requiredWei > wallet.balanceWei ? roundUpToDisplay(wallet.requiredWei - wallet.balanceWei) : 0n;
    // Rounding up for display must never push the funded wallet above its own limit.
    const room = limit > wallet.balanceWei ? limit - wallet.balanceWei : 0n;
    const topUp = shortfall > room ? room : shortfall;
    total += topUp;
    envelopeTotal += limit;
    plan.items.push({ wallet: address, balanceWei: wallet.balanceWei.toString(), requiredWei: wallet.requiredWei.toString(), envelopeWei: envelope.toString(), topUpWei: topUp.toString() });
    plan.runEnvelopeWei[address] = envelope.toString();
    plan.minimumBalanceWei[address] = wallet.requiredWei.toString();
  }
  if (envelopeTotal > fleetBound) plan.blockers.push('RUN_ENVELOPE_ABOVE_FLEET_BOUND');
  plan.totalTopUpWei = total.toString();
  plan.ready = plan.blockers.length === 0 && total === 0n;
  return plan;
}

/** Plain, checkable wording of the amounts to send. */
export function describeTopUps(plan: FundingPlan): Array<{ wallet: string; topUpWei: string }> {
  return plan.items.filter((item) => BigInt(item.topUpWei) > 0n).map((item) => ({ wallet: item.wallet, topUpWei: item.topUpWei }));
}

export interface ExcessState { firstAboveAt?: string; activityKey?: string; lastReminderAt?: string }
export type ExcessStates = Readonly<Record<string, ExcessState>>;
export interface ExcessObservation { address: string; balanceWei: bigint; /** On-chain transaction count: any change is activity from this wallet. */ nonce: number; }
export interface ExcessReminder { wallet: string; balanceWei: string; excessWei: string; idleMs: number }

/**
 * Left-over balance rule (D-059 item 3). A wallet above the idle ceiling while no run is armed or active starts a 24-hour clock.
 * Any on-chain activity from the wallet restarts it. When it has been idle that long the owner gets a reminder, repeated every
 * 24 hours until the balance is back at or below the ceiling or a run is armed. Nothing is moved by the bot.
 */
export function stepExcessTracker(input: {
  previous: ExcessStates;
  observations: readonly ExcessObservation[];
  walletMaxWei: bigint;
  runActive: boolean;
  now: Date;
  afterMs?: number;
}): { next: Record<string, ExcessState>; reminders: ExcessReminder[] } {
  const afterMs = input.afterMs ?? EXCESS_REMINDER_AFTER_MS;
  const now = input.now.getTime();
  const next: Record<string, ExcessState> = {};
  const reminders: ExcessReminder[] = [];
  for (const observation of input.observations) {
    const address = observation.address.toLowerCase();
    if (!ADDRESS.test(address)) continue;
    // While a run is armed or active, or once back within the ceiling, there is nothing to remind about.
    if (input.runActive || observation.balanceWei <= input.walletMaxWei) continue;
    const key = String(observation.nonce);
    const previous = input.previous[address];
    let state: ExcessState;
    if (!previous || previous.firstAboveAt === undefined || previous.activityKey !== key) {
      state = { firstAboveAt: input.now.toISOString(), activityKey: key };
    } else state = { ...previous };
    const first = Date.parse(state.firstAboveAt!);
    const last = state.lastReminderAt === undefined ? undefined : Date.parse(state.lastReminderAt);
    const idle = now - first;
    if (Number.isFinite(first) && idle >= afterMs && (last === undefined || !Number.isFinite(last) || now - last >= afterMs)) {
      state.lastReminderAt = input.now.toISOString();
      reminders.push({ wallet: address, balanceWei: observation.balanceWei.toString(), excessWei: (observation.balanceWei - input.walletMaxWei).toString(), idleMs: idle });
    }
    next[address] = state;
  }
  return { next, reminders };
}
