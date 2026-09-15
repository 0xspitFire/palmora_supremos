import type { Address, Hash } from 'viem';
import type { FinalityStage, SupportedChainId } from './types.js';

export type ReconciliationAction =
  | 'wait-and-recheck'
  | 'mark-submitted'
  | 'mark-confirmed'
  | 'mark-reverted'
  | 'record-replacement'
  | 'reconcile-by-nonce'
  | 'mark-reorged'
  | 'mark-dropped'
  | 'retain-ambiguous'
  | 'block-new-work';

export type ReconciliationInput = {
  readonly receiptVisible: boolean;
  readonly receiptStatus?: 'success' | 'reverted';
  readonly originalHash?: Hash;
  readonly observedHash?: Hash;
  readonly sender: Address;
  readonly nonce: number;
  readonly chainPendingNonce: number;
  readonly restart: boolean;
  readonly chainId?: SupportedChainId;
  readonly finalityStage?: FinalityStage;
  readonly receiptCanonical?: boolean;
  readonly nonceConsumedByDifferentHash?: boolean;
  readonly dropped?: boolean;
};

/**
 * Deterministic chain-side decision for ambiguous submission outcomes. It never
 * invents success/failure and never authorizes a new nonce while the original
 * `(sender, nonce)` outcome is unresolved.
 */
export function reconcileTransaction(input: ReconciliationInput): {
  action: ReconciliationAction;
  reason: string;
} {
  if (input.restart) return { action: 'block-new-work', reason: 'startup reconciliation is incomplete' };
  if (input.receiptVisible && input.receiptCanonical === false) {
    return { action: 'mark-reorged', reason: 'previously observed receipt is no longer canonical' };
  }
  if (input.nonceConsumedByDifferentHash) {
    return { action: 'record-replacement', reason: 'a different transaction consumed the same sender nonce' };
  }
  if (input.receiptVisible && input.receiptStatus === 'success') {
    if (input.observedHash && input.originalHash && input.observedHash.toLowerCase() !== input.originalHash.toLowerCase()) {
      return { action: 'record-replacement', reason: 'different hash observed for the same sender and nonce' };
    }
    if (input.chainId === 4663 && input.finalityStage !== 'ethereum_final') {
      return { action: 'mark-submitted', reason: `Robinhood receipt is ${input.finalityStage ?? 'soft'} and awaits Ethereum finality` };
    }
    return { action: 'mark-confirmed', reason: 'receipt confirms successful inclusion' };
  }
  if (input.receiptVisible && input.receiptStatus === 'reverted') {
    return { action: 'mark-reverted', reason: 'receipt confirms on-chain revert' };
  }
  if (input.observedHash) return { action: 'mark-submitted', reason: 'hash observed but receipt is not visible (RPC lag)' };
  if (input.dropped) return { action: 'mark-dropped', reason: 'chain observation proves the transaction was dropped' };
  if (input.chainPendingNonce > input.nonce) {
    return { action: 'reconcile-by-nonce', reason: 'nonce advanced without the original receipt; search attempts/replacements before retry' };
  }
  return { action: 'retain-ambiguous', reason: 'submission outcome remains unknown; retain reservation and reconcile again' };
}

export type ExactChainStatus =
  | 'submitted'
  | 'included'
  | 'posted'
  | 'ethereum_final'
  | 'replaced'
  | 'dropped'
  | 'reorged'
  | 'reverted'
  | 'unresolved';

/** Stable status vocabulary consumed by persistence and recovery adapters. */
export function mapChainStatus(input: {
  chainId: SupportedChainId;
  receiptVisible: boolean;
  receiptStatus?: 'success' | 'reverted';
  finalityStage?: FinalityStage;
  receiptCanonical?: boolean;
  replaced?: boolean;
  dropped?: boolean;
}): ExactChainStatus {
  if (input.receiptCanonical === false) return 'reorged';
  if (input.replaced) return 'replaced';
  if (input.dropped) return 'dropped';
  if (!input.receiptVisible) return 'unresolved';
  if (input.receiptStatus === 'reverted') return 'reverted';
  if (input.chainId === 4663) {
    if (input.finalityStage === 'ethereum_final') return 'ethereum_final';
    if (input.finalityStage === 'posted') return 'posted';
    return 'included';
  }
  return input.finalityStage === 'confirmed' ? 'included' : 'submitted';
}
