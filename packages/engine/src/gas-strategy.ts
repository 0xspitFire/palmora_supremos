/**
 * @module gas-strategy
 *
 * Flashbots retry-ladder policy for Ethereum L1 (and any future chain served by
 * a Flashbots relay). This is a pure, credential-free decision engine; it makes
 * no network calls and exposes no secrets.
 *
 * Approved policy (Product Owner):
 * 1. Attempt private (Flashbots) submission for up to 3 consecutive blocks.
 * 2. If unlanded after block 3:
 *    - Mint racing a hard cap:
 *      - If funds cover an escalation, raise the priority fee WITHIN Flashbots
 *        and retry for 2 more blocks.
 *      - Otherwise fall back to a public broadcast after a fresh nonce check,
 *        to confirm the private attempt did not land in an unseen block.
 *    - Mint with no hard cap: private-only retry with a slight tip bump at the
 *      next block until it lands.
 * This policy applies only to chains served by a Flashbots relay (Ethereum
 * mainnet today). It never implies guaranteed inclusion.
 */

/** Consecutive private blocks attempted before any fallback decision. */
export const PRIVATE_ATTEMPTS = 3;
/** Extra private attempts used when escalating on a hard-cap mint. */
export const ESCALATION_ATTEMPTS = 2;
/** Rounding to apply to a tip micro-adjustment on no-hard-cap retries. */
export const TIP_BUMP_FRACTION = 5n;

export type RetryAction =
  | { kind: 'private-retry'; blockOffset: number; escalate: boolean; bumpTip: boolean }
  | { kind: 'public-fallback'; requireNonceRecheck: boolean }
  | { kind: 'stop' };

export interface RetryDecisionInput {
  /** 1-based attempt counter; the first bundle submission is attempt 1. */
  readonly attempt: number;
  /** Whether the previous attempt landed in an observed block. */
  readonly landed: boolean;
  /** True when the mint is racing a hard/internal cap (supply or deadline). */
  readonly hasHardCap: boolean;
  /** True when available funds cover the escalated gas for a further retry. */
  readonly fundsCoverEscalation: boolean;
  /** Chain must be a Flashbots-relay chain; otherwise this ladder does not apply. */
  readonly relayChain: boolean;
}

/**
 * Decide the next broadcast action from a Flashbots attempt outcome.
 * Returns `{ kind: 'stop' }` when no further action is sanctioned by policy.
 */
export function nextRetryAction(input: RetryDecisionInput): RetryAction {
  if (!input.relayChain) {
    return { kind: 'stop' };
  }
  if (input.landed) {
    return { kind: 'stop' };
  }

  // Attempts 1..3: keep the bundle private at the base priority (no escalation).
  if (input.attempt <= PRIVATE_ATTEMPTS) {
    return { kind: 'private-retry', blockOffset: input.attempt, escalate: false, bumpTip: false };
  }

  // Beyond block 3 the subject has not landed.
  if (input.hasHardCap) {
    // Enough coverage → escalate within Flashbots for 2 more blocks.
    if (input.fundsCoverEscalation && input.attempt <= PRIVATE_ATTEMPTS + ESCALATION_ATTEMPTS) {
      return { kind: 'private-retry', blockOffset: input.attempt, escalate: true, bumpTip: false };
    }
    // Otherwise fall back to public with a fresh nonce check (confirms the
    // private attempt did not land in an unseen block).
    return { kind: 'public-fallback', requireNonceRecheck: true };
  }

  // No hard cap: private-only retry with a slight tip bump each block.
  return { kind: 'private-retry', blockOffset: input.attempt, escalate: false, bumpTip: true };
}

/**
 * Apply a slight tip bump to a priority fee for a no-hard-cap private retry.
 * Pure arithmetic; returns the bumped priority fee (wei).
 */
export function applyTipBump(priorityFeeWei: bigint, fraction: bigint = TIP_BUMP_FRACTION): bigint {
  return priorityFeeWei + priorityFeeWei / 100n * fraction;
}

/** Maximum lapsed blocks before an arbitrary retry is no longer sanctioned. */
export const MAX_LADDER_ATTEMPTS = PRIVATE_ATTEMPTS + ESCALATION_ATTEMPTS;