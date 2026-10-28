/**
 * D-080: the rules for a bounded same-nonce replacement transaction. Pure arithmetic and refusals; it sends and signs nothing, and
 * nothing calls it from the send path yet (the engine still sends exactly one transaction per wallet, `maxReplacementBumps` 0).
 *
 * A replacement is only ever planned when ALL of these hold:
 *  - the owner enabled it (`maxBumps` greater than 0) and fewer than `maxBumps` replacements were used;
 *  - no earlier attempt for that nonce may have been mined;
 *  - both fees rise by at least 10 percent (the network's own rule for replacing a pending transaction);
 *  - neither fee goes above the ceiling, which must itself be within the signed provider policy's pinned fee limits and is the
 *    amount reserved at admission (D-019), so a replacement can never spend more than was reserved up front.
 */
export const MIN_REPLACEMENT_BUMP_BPS = 1_000n;
export const MAX_REPLACEMENT_BUMPS_LIMIT = 5;
const BPS = 10_000n;

export interface Fees { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }

export type ReplacementRefusal =
  | 'REPLACEMENT_DISABLED'
  | 'REPLACEMENT_LIMIT_REACHED'
  | 'REPLACEMENT_MAY_HAVE_MINED'
  | 'REPLACEMENT_MINED_STATUS_UNKNOWN'
  | 'REPLACEMENT_CEILING_REACHED'
  | 'REPLACEMENT_FEES_INVALID'
  | 'REPLACEMENT_CONFIG_INVALID';

/** Whether any earlier attempt for this nonce may already be mined. Anything but a proven 'no' refuses. */
export type MinedStatus = 'no' | 'yes' | 'unknown';

export type ReplacementDecision = { ok: true; next: Fees; bumpsUsed: number } | { ok: false; reason: ReplacementRefusal };

const validFees = (fees: Fees): boolean => fees.maxFeePerGas > 0n && fees.maxPriorityFeePerGas >= 0n && fees.maxPriorityFeePerGas <= fees.maxFeePerGas;
const raise = (value: bigint): bigint => (value * (BPS + MIN_REPLACEMENT_BUMP_BPS) + BPS - 1n) / BPS;

/** The one place a fee step is computed, so planReplacement and requiredCeiling can never disagree. A zero tip cannot rise by a percentage, so it rises by one unit. */
function nextStep(current: Fees): Fees {
  const raisedTip = raise(current.maxPriorityFeePerGas);
  const maxPriorityFeePerGas = raisedTip > current.maxPriorityFeePerGas ? raisedTip : current.maxPriorityFeePerGas + 1n;
  const raisedFee = raise(current.maxFeePerGas);
  return { maxFeePerGas: raisedFee > maxPriorityFeePerGas ? raisedFee : maxPriorityFeePerGas, maxPriorityFeePerGas };
}

export function planReplacement(input: { current: Fees; ceiling: Fees; bumpsUsed: number; maxBumps: number; mayHaveMined: MinedStatus }): ReplacementDecision {
  if (!Number.isSafeInteger(input.maxBumps) || input.maxBumps < 0 || input.maxBumps > MAX_REPLACEMENT_BUMPS_LIMIT || !Number.isSafeInteger(input.bumpsUsed) || input.bumpsUsed < 0) return { ok: false, reason: 'REPLACEMENT_CONFIG_INVALID' };
  if (input.maxBumps === 0) return { ok: false, reason: 'REPLACEMENT_DISABLED' };
  if (input.bumpsUsed >= input.maxBumps) return { ok: false, reason: 'REPLACEMENT_LIMIT_REACHED' };
  if (input.mayHaveMined === 'yes') return { ok: false, reason: 'REPLACEMENT_MAY_HAVE_MINED' };
  if (input.mayHaveMined !== 'no') return { ok: false, reason: 'REPLACEMENT_MINED_STATUS_UNKNOWN' };
  if (!validFees(input.current) || !validFees(input.ceiling)) return { ok: false, reason: 'REPLACEMENT_FEES_INVALID' };

  const { maxFeePerGas: nextFee, maxPriorityFeePerGas: nextTip } = nextStep(input.current);
  if (nextFee > input.ceiling.maxFeePerGas || nextTip > input.ceiling.maxPriorityFeePerGas) return { ok: false, reason: 'REPLACEMENT_CEILING_REACHED' };
  return { ok: true, next: { maxFeePerGas: nextFee, maxPriorityFeePerGas: nextTip }, bumpsUsed: input.bumpsUsed + 1 };
}

/** The fee ceiling needed so that `maxBumps` replacements stay possible from `initial`; must then be checked against the provider policy's pinned limits. */
export function requiredCeiling(initial: Fees, maxBumps: number): Fees {
  if (!Number.isSafeInteger(maxBumps) || maxBumps < 0 || maxBumps > MAX_REPLACEMENT_BUMPS_LIMIT) throw new Error('REPLACEMENT_CONFIG_INVALID');
  if (!validFees(initial)) throw new Error('REPLACEMENT_FEES_INVALID');
  let fees = initial;
  for (let step = 0; step < maxBumps; step += 1) fees = nextStep(fees);
  return fees;
}

/** True when the ceiling fits inside the fee limits pinned by the signed provider policy. */
export function ceilingWithinPolicy(ceiling: Fees, policy: Fees): boolean {
  return validFees(ceiling) && validFees(policy) && ceiling.maxFeePerGas <= policy.maxFeePerGas && ceiling.maxPriorityFeePerGas <= policy.maxPriorityFeePerGas;
}

/** The worst-case execution gas cost that must be reserved at admission when replacements are enabled: the gas limit at the CEILING fee, not the first fee. */
export function reservedGasCostWei(gasLimit: bigint, ceiling: Fees): bigint {
  if (gasLimit <= 0n || !validFees(ceiling)) throw new Error('REPLACEMENT_FEES_INVALID');
  return gasLimit * ceiling.maxFeePerGas;
}
