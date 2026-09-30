import { formatEth } from './scoring.js';

/**
 * Fee-aware free-mint quantity planning (T-012, D-037).
 *
 * The bot reserves a worst case per wallet before signing: padded gas limit x max fee per gas (D-019).
 * For a free mint that worst case must fit the per-wallet fee allowance (D-033, 0.0004 ETH). When the
 * full per-wallet allowance does not fit at the current fee, plan the largest quantity that does (at
 * least 1) instead of skipping, and always say why. Planning only ever lowers exposure; admission,
 * caps, reservations and the pre-sign gate are unchanged.
 */
export interface QuantityPlanInput {
  /** Quantity the owner wants: the per-wallet allowance for a free mint. */
  desired: number;
  /** Per-wallet fee allowance in wei. */
  allowanceWei: bigint;
  /** The max fee per gas the bot would sign with. */
  maxFeePerGasWei: bigint;
  /** Gas estimate for minting `quantity` NFTs, or null when it cannot be estimated. */
  gasForQuantity: (quantity: number) => Promise<bigint | null>;
  /** Gas-limit padding, as the engine applies it (default 1.2, rounded up). */
  paddingNumerator?: bigint;
  paddingDenominator?: bigint;
  /** Most gas one transaction may use (default 15,000,000, safely under Ethereum's 16,777,216 per-transaction cap). */
  maxGasLimit?: bigint;
}

export type QuantityPlanReason = 'full' | 'reduced_for_fees' | 'reduced_for_gas_limit' | 'cannot_fit_one' | 'unknown';
export interface QuantityPlan {
  desired: number;
  planned: number;
  reduced: boolean;
  reason: QuantityPlanReason;
  maxFeeGwei: string;
  /** Padded worst-case fee for the planned quantity, or null when unknown. */
  plannedWorstCaseWei: bigint | null;
  /** Plain-language explanation for the owner. */
  message: string;
}

const GWEI = 10n ** 9n;
/** Tip assumed on top of the base-fee headroom when planning (0.1 gwei). */
const PLANNING_TIP_WEI = GWEI / 10n;

/**
 * The max fee per gas used for planning and advice: twice the current base fee plus a 0.1 gwei tip,
 * which is what a careful bot signs with. The fee used is always shown to the owner.
 */
export function planningMaxFeeWei(baseFeeWei: bigint): bigint {
  return baseFeeWei * 2n + PLANNING_TIP_WEI;
}

export function formatGwei(wei: bigint): string {
  const whole = wei / GWEI;
  const fraction = (wei % GWEI).toString().padStart(9, '0').slice(0, 3).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export async function planFreeQuantity(input: QuantityPlanInput): Promise<QuantityPlan> {
  const { desired, allowanceWei, maxFeePerGasWei } = input;
  if (!Number.isSafeInteger(desired) || desired < 1 || allowanceWei <= 0n || maxFeePerGasWei <= 0n) throw new Error('QUANTITY_PLAN_INPUT_INVALID');
  const num = input.paddingNumerator ?? 12n;
  const den = input.paddingDenominator ?? 10n;
  const maxFeeGwei = formatGwei(maxFeePerGasWei);
  const gasCeiling = input.maxGasLimit ?? 15_000_000n;
  const measure = async (quantity: number): Promise<{ gasLimit: bigint; cost: bigint } | null> => {
    const gas = await input.gasForQuantity(quantity);
    if (gas === null || gas <= 0n) return null;
    const gasLimit = (gas * num + den - 1n) / den;
    return { gasLimit, cost: gasLimit * maxFeePerGasWei };
  };
  const fits = (m: { gasLimit: bigint; cost: bigint }): boolean => m.cost <= allowanceWei && m.gasLimit <= gasCeiling;
  const unknown = (): QuantityPlan => ({ desired, planned: desired, reduced: false, reason: 'unknown', maxFeeGwei, plannedWorstCaseWei: null, message: `Could not estimate the mint fee, so the full ${desired} per wallet is kept for now. Live admission re-checks the fee allowance before anything is signed.` });

  const full = await measure(desired);
  if (full === null) return unknown();
  if (fits(full)) return { desired, planned: desired, reduced: false, reason: 'full', maxFeeGwei, plannedWorstCaseWei: full.cost, message: `All ${desired} NFT(s) per wallet fit the ${formatEth(allowanceWei)} ETH fee allowance at ${maxFeeGwei} gwei.` };

  // Gas grows with quantity, so the largest quantity that fits is found by binary search.
  let low = 1;
  let high = desired - 1;
  let best: { quantity: number; cost: bigint } | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const measured = await measure(middle);
    if (measured === null) return unknown();
    if (fits(measured)) { best = { quantity: middle, cost: measured.cost }; low = middle + 1; }
    else high = middle - 1;
  }
  if (best === null) {
    const one = await measure(1);
    return { desired, planned: 0, reduced: true, reason: 'cannot_fit_one', maxFeeGwei, plannedWorstCaseWei: one?.cost ?? null, message: `Skipped: at ${maxFeeGwei} gwei even 1 NFT would cost more than the ${formatEth(allowanceWei)} ETH fee allowance in the worst case. It will be reconsidered when fees fall.` };
  }
  // Fees would allow the full quantity, but one transaction cannot carry that much gas.
  if (full.cost <= allowanceWei) return { desired, planned: best.quantity, reduced: true, reason: 'reduced_for_gas_limit', maxFeeGwei, plannedWorstCaseWei: best.cost, message: `Planned ${best.quantity} of ${desired} NFTs per wallet: the fee allowance would cover more, but one transaction cannot carry more than ${best.quantity} NFTs (network gas limit per transaction).` };
  return { desired, planned: best.quantity, reduced: true, reason: 'reduced_for_fees', maxFeeGwei, plannedWorstCaseWei: best.cost, message: `Planned ${best.quantity} of ${desired} NFTs per wallet: at ${maxFeeGwei} gwei the ${formatEth(allowanceWei)} ETH fee allowance only covers ${best.quantity}. More will be minted when fees are lower.` };
}
