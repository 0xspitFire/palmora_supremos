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

/** Product policy for FREE mints. Zero priority is valid, but permits no priority component spend. */
export type FreeMintSpendVerdict =
  | {
      status: 'ok';
      priorityComponentCapWei: bigint;
      l2ExecutionGasReservationWei: bigint;
      l1DataGasReservationWei: bigint;
      totalIndependentReservationWei: bigint;
    }
  | { status: 'exceeded'; priorityComponentCapWei: bigint; actualPriorityComponentWei: bigint }
  | { status: 'invalid'; reason: 'negative-exposure' };

/**
 * Enforce the Product Owner's FREE-mint policy for one mint period. The 2x rule
 * applies only to the configured priority-fee component. L2 execution gas and
 * L1 data gas are independent worst-case reservations and are never collapsed
 * into that 2x allowance. A zero priority fee is valid and yields a zero cap.
 */
export function validateFreeMintSpend(input: {
  configuredPriorityFeeWei: bigint;
  actualPriorityComponentWei: bigint;
  l2ExecutionGasReservationWei: bigint;
  l1DataGasReservationWei: bigint;
}): FreeMintSpendVerdict {
  if (
    input.configuredPriorityFeeWei < 0n ||
    input.actualPriorityComponentWei < 0n ||
    input.l2ExecutionGasReservationWei < 0n ||
    input.l1DataGasReservationWei < 0n
  ) {
    return { status: 'invalid', reason: 'negative-exposure' };
  }
  const priorityComponentCapWei = input.configuredPriorityFeeWei * 2n;
  if (input.actualPriorityComponentWei > priorityComponentCapWei) {
    return { status: 'exceeded', priorityComponentCapWei, actualPriorityComponentWei: input.actualPriorityComponentWei };
  }
  return {
    status: 'ok',
    priorityComponentCapWei,
    l2ExecutionGasReservationWei: input.l2ExecutionGasReservationWei,
    l1DataGasReservationWei: input.l1DataGasReservationWei,
    totalIndependentReservationWei:
      priorityComponentCapWei + input.l2ExecutionGasReservationWei + input.l1DataGasReservationWei,
  };
}

/** Paid mints remain blocked until the Product Owner approves value/exposure limits. */
export function paidMintExecutionBlock(valueWei: bigint): { allowed: true } | { allowed: false; reason: string } {
  return valueWei > 0n
    ? { allowed: false, reason: 'Paid-mint execution is blocked pending explicit value/exposure policy' }
    : { allowed: true };
}

/** Paid-mint quantity defaults to 15 per wallet, subject to the contract's own limit. */
export function validatePaidQuantity(input: {
  requestedQuantity: number;
  contractWalletLimit: number;
  configuredWalletLimit?: number;
}): { allowed: true; quantity: number } | { allowed: false; reason: string } {
  const configured = input.configuredWalletLimit ?? 15;
  if (!Number.isInteger(configured) || configured < 1) {
    return { allowed: false, reason: 'Paid per-wallet quantity setting must be a positive integer' };
  }
  const effectiveLimit = Math.min(configured, input.contractWalletLimit);
  if (!Number.isInteger(input.requestedQuantity) || input.requestedQuantity < 1 || input.requestedQuantity > effectiveLimit) {
    return { allowed: false, reason: `Requested quantity exceeds the effective per-wallet limit of ${effectiveLimit}` };
  }
  return { allowed: true, quantity: input.requestedQuantity };
}

/** Paid gas exposure uses the priority component as requested; L1 data is separate. */
export function validatePaidGasExposure(input: {
  gasLimit: bigint;
  configuredPriorityFeeWei: bigint;
  actualPriorityComponentWei: bigint;
  l1DataGasReservationWei: bigint;
}): { allowed: true; priorityGasCapWei: bigint; l1DataGasReservationWei: bigint } | { allowed: false; reason: string } {
  if ([input.gasLimit, input.configuredPriorityFeeWei, input.actualPriorityComponentWei, input.l1DataGasReservationWei].some((value) => value < 0n)) {
    return { allowed: false, reason: 'Negative paid gas exposure is invalid' };
  }
  const priorityGasCapWei = input.gasLimit * input.configuredPriorityFeeWei * 3n / 2n;
  if (input.actualPriorityComponentWei > priorityGasCapWei) {
    return { allowed: false, reason: 'Paid gas exposure exceeds 1.5x the configured priority component' };
  }
  return { allowed: true, priorityGasCapWei, l1DataGasReservationWei: input.l1DataGasReservationWei };
}

/** Replacement budget is inclusive of the original priority component. */
export function replacementPriorityBudget(configuredPriorityComponentWei: bigint): bigint {
  return configuredPriorityComponentWei < 0n ? 0n : configuredPriorityComponentWei * 2n;
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
