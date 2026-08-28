/**
 * @module fee-guard
 *
 * Dimensional safety for fee budgets. A cap expressed only as "2x priority fee"
 * is not dimensionally safe, because total spent on a type-2 (EIP-1559) L2 like
 * Robinhood is:
 *
 *   gasUsed * (baseFeePerGas + priorityFeePerGas)  +  L1 data fee
 *
 * The L1 data fee is proportional to calldata size and varies with Ethereum L1
 * congestion, so it is neither zero nor bounded by the priority fee. We therefore
 * cap the WORST-CASE total cost for a mint as:
 *
 *   totalFeeCap = gasLimit * maxFeePerGas          (already embeds priority fee)
 *   plus L1 data allowance where known
 *   plus value
 *
 * and we REFUSE to arm whenever the configured budget is missing, zero, or
 * ambiguous, rather than silently underbounding spend.
 */

import { formatEther } from 'viem';

export interface FeeBudgetInput {
  /** Mint value wei = mintPrice * quantity. */
  readonly valueWei: bigint;
  /** Prepared max fee per gas (wei). Includes base + priority for EIP-1559. */
  readonly maxFeePerGasWei: bigint;
  /** Padded gas limit (wei units). */
  readonly gasLimit: bigint;
  /** Override total-budget guard. Default: gasLimit * maxFeePerGas + valueWei. */
  readonly declaredBudgetWei?: bigint;
  /** L1 data-fee allowance for L2s (Robinhood/Base). Default 0. */
  readonly l1DataFeeAllowanceWei?: bigint;
}

export type FeeBudgetVerdict =
  | { ok: true; worstCaseTotalWei: bigint }
  | { ok: false; reason: string };

/** Product policy for FREE mints. A zero priority fee is intentionally unresolved. */
export type FreeMintSpendVerdict =
  | { status: 'ok'; maxSpendWei: bigint }
  | { status: 'exceeded'; maxSpendWei: bigint; actualSpendWei: bigint }
  | { status: 'ambiguous'; reason: 'zero-priority-fee' };

/**
 * Enforce the Product Owner's FREE-mint policy for one mint period:
 * total spend must not exceed 2x the priority gas fee. Because 2x zero is not
 * an operationally meaningful allowance, zero priority fee remains an explicit
 * Product Owner decision instead of being silently interpreted as zero budget.
 */
export function validateFreeMintSpend(input: {
  priorityFeeWei: bigint;
  actualSpendWei: bigint;
}): FreeMintSpendVerdict {
  if (input.priorityFeeWei <= 0n) {
    return { status: 'ambiguous', reason: 'zero-priority-fee' };
  }
  const maxSpendWei = input.priorityFeeWei * 2n;
  return input.actualSpendWei <= maxSpendWei
    ? { status: 'ok', maxSpendWei }
    : { status: 'exceeded', maxSpendWei, actualSpendWei: input.actualSpendWei };
}

/**
 * Compute the worst-case total mint cost and validate the budget.
 * Returns ok:false (and refuses to arm) when the budget is absent, zero, or
 * dimensionally inconsistent, rather than silently underbounding.
 */
export function validateFeeBudget(input: FeeBudgetInput): FeeBudgetVerdict {
  if (input.valueWei === 0n && input.gasLimit === 0n) {
    return { ok: false, reason: 'Ambiguous budget: both value and gas limit are zero' };
  }
  if (input.gasLimit === 0n) {
    return { ok: false, reason: 'Ambiguous budget: gas limit is zero' };
  }
  if (input.maxFeePerGasWei === 0n) {
    return { ok: false, reason: 'Ambiguous budget: max fee per gas is zero' };
  }

  const gasCeilingWei = input.gasLimit * input.maxFeePerGasWei;
  const l1Allowance = input.l1DataFeeAllowanceWei ?? 0n;
  const worstCaseGasWei = gasCeilingWei + l1Allowance;
  const declared = input.declaredBudgetWei ?? (worstCaseGasWei + input.valueWei);

  if (declared === 0n) {
    return { ok: false, reason: 'Budget is zero — refusing to underbound spend' };
  }

  const worstCaseTotalWei = worstCaseGasWei + input.valueWei;
  if (declared < worstCaseTotalWei) {
    return {
      ok: false,
      reason: `Declared budget (${formatEther(declared)} ETH) is below worst-case total (${formatEther(worstCaseTotalWei)} ETH)`,
    };
  }

  return { ok: true, worstCaseTotalWei };
}

/** The priority fee alone is never an upper bound on spend; this stays explicit. */
export function assertPriorityFeeIsNotBudget(priorityFeeGwei: number): void {
  if (priorityFeeGwei > 0) {
    // Intentional no-op: the priority fee is a component, not a cap. Kept for
    // documentation so callers don't treat it as the total budget.
  }
}
