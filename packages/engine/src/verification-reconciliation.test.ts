import { describe, expect, it } from 'vitest';
import { correlateSequencerObservation } from './sequencer-correlation.js';
import { reconcileTransaction } from './reconciliation.js';
import { applyRobinhoodVerification, evaluateRobinhoodVerification } from './robinhood-gate.js';
import { getChainConfig } from './chains.js';

const hash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const otherHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const sender = '0x81c104DcB898416FD4f81eAd091DbA5b8f46F37A' as `0x${string}`;

describe('sequencer/RPC correlation', () => {
  it('correlates matching hash and nonce', () => {
    expect(correlateSequencerObservation(
      { txHash: hash, from: sender, nonce: 7, blockNumber: 10n },
      { txHash: hash, from: sender, nonce: 7, blockNumber: 10n, receiptVisible: true },
    ).status).toBe('correlated');
  });
  it('classifies receipt delay as RPC lag', () => {
    expect(correlateSequencerObservation({ txHash: hash }, { txHash: hash, receiptVisible: false })).toEqual({ status: 'pending', reason: 'rpc-lag' });
  });
  it('rejects a sender/nonce mismatch', () => {
    expect(correlateSequencerObservation({ txHash: hash, from: sender, nonce: 7 }, { txHash: hash, from: sender, nonce: 8, receiptVisible: true })).toEqual({ status: 'mismatch', reason: 'nonce' });
  });
});

describe('transaction reconciliation', () => {
  it('blocks new work during startup reconciliation', () => {
    expect(reconcileTransaction({ receiptVisible: false, sender, nonce: 1, chainPendingNonce: 1, restart: true }).action).toBe('block-new-work');
  });
  it('does not issue a fresh nonce during RPC lag', () => {
    expect(reconcileTransaction({ receiptVisible: false, observedHash: hash, sender, nonce: 1, chainPendingNonce: 1, restart: false }).action).toBe('mark-submitted');
  });
  it('records replacement when another hash has the same sender nonce', () => {
    expect(reconcileTransaction({ receiptVisible: true, receiptStatus: 'success', originalHash: hash, observedHash: otherHash, sender, nonce: 1, chainPendingNonce: 2, restart: false }).action).toBe('record-replacement');
  });
  it('reconciles an advanced nonce before retrying', () => {
    expect(reconcileTransaction({ receiptVisible: false, sender, nonce: 1, chainPendingNonce: 2, restart: false }).action).toBe('reconcile-by-nonce');
  });
});

describe('Robinhood verification gate', () => {
  const complete = {
    ownerAccepted: true, positiveSeaDropMint: true, archiveForkReplay: true,
    negativeCaseSuite: true, sequencerFeedCorrelation: true,
    duplicateTimeoutLagReplacement: true, startupReconciliation: true,
    signerBroadcastFinality: true,
  } as const;
  it('does not verify from Product Owner acceptance and positive mint alone', () => {
    const result = evaluateRobinhoodVerification({ ...complete, archiveForkReplay: false, negativeCaseSuite: false });
    expect(result.verified).toBe(false);
    expect(result.missing).toEqual(['archiveForkReplay', 'negativeCaseSuite']);
  });
  it('verifies only when every evidence item passes', () => {
    expect(evaluateRobinhoodVerification(complete)).toEqual({ verified: true, missing: [] });
  });
  it('refuses to flip the static profile on incomplete evidence', () => {
    expect(() => applyRobinhoodVerification(getChainConfig(4663), { ...complete, negativeCaseSuite: false })).toThrow('negativeCaseSuite');
  });
  it('flips only an explicitly complete evidence snapshot', () => {
    const config = applyRobinhoodVerification(getChainConfig(4663), complete);
    expect(config.verificationStatus).toBe('verified');
    expect(config.executionEnabled).toBe(true);
  });
});
