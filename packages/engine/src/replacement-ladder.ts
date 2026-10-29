import type { Hash, Hex } from 'viem';
import { planReplacement, type Fees, type MinedStatus } from './replacement-policy.js';

/**
 * D-080 / T-094: the loop that decides, while a sent mint is still unmined, whether to send a bounded same-nonce replacement.
 * Every side effect is injected, so each safety rule can be tested without a chain. The loop only ever STOPS replacing; it never
 * cancels a transaction, and it returns the full set of our own hashes so the caller can watch all of them.
 *
 * A replacement is prepared (signed and its attempt persisted) BEFORE it is sent, and joins the hash set before the send, so a
 * crash or an ambiguous send never leaves a transaction the system does not know about.
 */
export interface LadderAttempt { readonly hash: Hash; readonly attemptId: string; readonly fees: Fees }

export interface PreparedReplacement { readonly signedTx: Hex; readonly hash: Hash; readonly attemptId: string }

export type SendOutcome = 'accepted' | 'ambiguous' | 'rejected';

export interface LadderDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The first of our hashes that has a receipt, or undefined. Throws when it cannot be determined. */
  findMinedHash(hashes: readonly Hash[]): Promise<Hash | undefined>;
  /** Whether the sender's nonce has been used on chain. */
  nonceState(): Promise<'consumed' | 'free'>;
  /** Kill switch, owner grant, drop re-check and a fresh simulation. Returns the reason to stop, or undefined to go on. Must not throw. */
  preChecks(): Promise<string | undefined>;
  /** Builds, signs, verifies and PERSISTS the replacement attempt (same calldata, value, gas limit and nonce; only the fees differ). May throw on a signer refusal. */
  prepare(next: Fees, bump: number, replacesAttemptId: string): Promise<PreparedReplacement>;
  /** Sends it and persists the broadcast attempts. */
  send(prepared: PreparedReplacement, bump: number, replacesAttemptId: string): Promise<SendOutcome>;
}

export interface LadderInput {
  /** Our attempts so far, original first. `attempts.length - 1` is the number of replacements already used, so a restart cannot reset the ladder. */
  readonly attempts: readonly LadderAttempt[];
  readonly maxBumps: number;
  readonly ceiling: Fees;
  /** Replace only when the newest attempt has been unmined this long. */
  readonly stuckAfterMs: number;
  readonly pollMs: number;
  /** When the newest attempt was sent (ms, same clock as deps.now). */
  readonly lastSentAt: number;
}

export type LadderStop =
  | 'MINED'
  | 'NONCE_CONSUMED'
  | 'MINED_STATUS_UNKNOWN'
  | 'PRE_CHECK_REFUSED'
  | 'SIGNER_REFUSED'
  | 'REPLACEMENT_REJECTED'
  | 'REPLACEMENT_DISABLED'
  | 'REPLACEMENT_LIMIT_REACHED'
  | 'REPLACEMENT_CEILING_REACHED'
  | 'REPLACEMENT_CONFIG_INVALID'
  | 'REPLACEMENT_FEES_INVALID';

export interface LadderResult {
  readonly attempts: readonly LadderAttempt[];
  readonly winner?: Hash;
  readonly stop: LadderStop;
  readonly detail?: string;
}

export async function runReplacementLadder(input: LadderInput, deps: LadderDeps): Promise<LadderResult> {
  const attempts: LadderAttempt[] = [...input.attempts];
  if (attempts.length === 0) return { attempts, stop: 'REPLACEMENT_CONFIG_INVALID', detail: 'no original attempt' };
  let lastSentAt = input.lastSentAt;

  for (;;) {
    const hashes = attempts.map((attempt) => attempt.hash);
    let mined: Hash | undefined;
    try { mined = await deps.findMinedHash(hashes); } catch { return { attempts, stop: 'MINED_STATUS_UNKNOWN' }; }
    if (mined) return { attempts, winner: mined, stop: 'MINED' };

    if (deps.now() - lastSentAt >= input.stuckAfterMs) {
      let nonce: 'consumed' | 'free' | 'unknown';
      try { nonce = await deps.nonceState(); } catch { nonce = 'unknown'; }
      if (nonce === 'consumed') return { attempts, stop: 'NONCE_CONSUMED' };
      const mayHaveMined: MinedStatus = nonce === 'free' ? 'no' : 'unknown';

      const newest = attempts.at(-1)!;
      const decision = planReplacement({ current: newest.fees, ceiling: input.ceiling, bumpsUsed: attempts.length - 1, maxBumps: input.maxBumps, mayHaveMined });
      if (!decision.ok) {
        const stop: LadderStop = decision.reason === 'REPLACEMENT_MAY_HAVE_MINED' || decision.reason === 'REPLACEMENT_MINED_STATUS_UNKNOWN' ? 'MINED_STATUS_UNKNOWN' : decision.reason;
        return { attempts, stop };
      }

      const refusal = await deps.preChecks();
      if (refusal) return { attempts, stop: 'PRE_CHECK_REFUSED', detail: refusal };

      let prepared: PreparedReplacement;
      try { prepared = await deps.prepare(decision.next, decision.bumpsUsed, newest.attemptId); } catch { return { attempts, stop: 'SIGNER_REFUSED' }; }
      // Joins the set before it is sent, so an ambiguous or interrupted send is still watched and reconciled.
      attempts.push({ hash: prepared.hash, attemptId: prepared.attemptId, fees: decision.next });
      let outcome: SendOutcome;
      try { outcome = await deps.send(prepared, decision.bumpsUsed, newest.attemptId); } catch { outcome = 'ambiguous'; }
      lastSentAt = deps.now();
      if (outcome === 'rejected') return { attempts, stop: 'REPLACEMENT_REJECTED' };
    }
    await deps.sleep(input.pollMs);
  }
}
