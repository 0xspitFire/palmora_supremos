import type { Address, Hash } from 'viem';

export type ReconciliationAction =
  | 'wait-and-recheck'
  | 'mark-submitted'
  | 'mark-confirmed'
  | 'mark-reverted'
  | 'record-replacement'
  | 'reconcile-by-nonce'
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
  if (input.receiptVisible && input.receiptStatus === 'success') {
    if (input.observedHash && input.originalHash && input.observedHash.toLowerCase() !== input.originalHash.toLowerCase()) {
      return { action: 'record-replacement', reason: 'different hash observed for the same sender and nonce' };
    }
    return { action: 'mark-confirmed', reason: 'receipt confirms successful inclusion' };
  }
  if (input.receiptVisible && input.receiptStatus === 'reverted') {
    return { action: 'mark-reverted', reason: 'receipt confirms on-chain revert' };
  }
  if (input.observedHash) return { action: 'mark-submitted', reason: 'hash observed but receipt is not visible (RPC lag)' };
  if (input.chainPendingNonce > input.nonce) {
    return { action: 'reconcile-by-nonce', reason: 'nonce advanced without the original receipt; search attempts/replacements before retry' };
  }
  return { action: 'wait-and-recheck', reason: 'submission outcome remains unknown' };
}
