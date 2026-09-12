import type { Address, Hash } from 'viem';

export type SequencerObservation = {
  readonly txHash?: Hash;
  readonly from?: Address;
  readonly nonce?: number;
  readonly blockNumber?: bigint;
  readonly sequence?: bigint;
};

export type RpcObservation = {
  readonly txHash?: Hash;
  readonly from?: Address;
  readonly nonce?: number;
  readonly blockNumber?: bigint;
  readonly receiptVisible: boolean;
};

export type SequencerCorrelation =
  | { status: 'correlated'; txHash: Hash; blockNumber?: bigint; sequence?: bigint }
  | { status: 'pending'; reason: 'feed-missing-hash' | 'rpc-lag' | 'receipt-not-visible' }
  | { status: 'mismatch'; reason: 'hash' | 'sender' | 'nonce' | 'block' };

/**
 * Correlate a sequencer-feed observation with RPC state. Feed messages are an
 * observation aid, not finality; a missing receipt is explicitly RPC lag.
 */
export function correlateSequencerObservation(
  feed: SequencerObservation,
  rpc: RpcObservation,
): SequencerCorrelation {
  if (!feed.txHash) return { status: 'pending', reason: 'feed-missing-hash' };
  if (rpc.txHash && rpc.txHash.toLowerCase() !== feed.txHash.toLowerCase()) {
    return { status: 'mismatch', reason: 'hash' };
  }
  if (feed.from && rpc.from && feed.from.toLowerCase() !== rpc.from.toLowerCase()) {
    return { status: 'mismatch', reason: 'sender' };
  }
  if (feed.nonce !== undefined && rpc.nonce !== undefined && feed.nonce !== rpc.nonce) {
    return { status: 'mismatch', reason: 'nonce' };
  }
  if (feed.blockNumber !== undefined && rpc.blockNumber !== undefined && feed.blockNumber !== rpc.blockNumber) {
    return { status: 'mismatch', reason: 'block' };
  }
  if (!rpc.receiptVisible) return { status: 'pending', reason: 'rpc-lag' };
  return { status: 'correlated', txHash: feed.txHash, blockNumber: feed.blockNumber ?? rpc.blockNumber, sequence: feed.sequence };
}
