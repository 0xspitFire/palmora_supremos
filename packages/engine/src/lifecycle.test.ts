import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import {
  assertDirectChainExecutionPolicy,
  assertDurableReservationProvider,
  assertSimulationFresh,
  assertTimingWindow,
  broadcastAttemptId,
  canonicalExecutionIdentity,
  classifyBroadcastResult,
  lifecycleStateForFinality,
  reconcileByHashAndNonce,
  reservationCampaignId,
  selectBroadcastAttempt,
  shouldSettleReceipt,
  actualSettlementComponents,
} from './lifecycle.js';
import { mapChainStatus, reconcileTransaction } from './reconciliation.js';
import { ReceiptReorgedError } from './receipt-watcher.js';
import { zeroizePrivateKeyArray } from './signer.js';
import { MintEngine } from './mint-engine.js';
import type { MintJobConfig } from './types.js';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const hash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;
const replacementHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash;

function liveConfig(chain: MintJobConfig['target']['chain']): MintJobConfig {
  return {
    target: { chain, contract: wallet, strategy: 'seadrop-v1-public', quantity: 1, campaignId: `campaign_${chain}` },
    fleet: { walletFile: '/tmp/never-read-wallet-file', maxWallets: 1 },
    timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
    fees: { maxFeePerGasGwei: 1, maxPriorityFeePerGasGwei: 0, gasLimitPadding: 1.1 },
    safety: { maxSpendEth: 1, dailySpendCapEth: 1, maxReplacementBumps: 2, dryRun: false, killSwitchFile: '/tmp/mintbot-gate3-kill' },
    broadcast: { mode: 'public', rpcEndpoints: [], blastParallel: false },
    observability: { logLevel: 'error', logFile: '/tmp/mintbot-gate3.log' },
  };
}

describe('Gate 3 lifecycle boundaries', () => {
  it('requires normalized durable reservations even for FREE live execution', () => {
    expect(() => assertDurableReservationProvider(undefined, false)).toThrowError(/normalized durable reservation/);
    expect(() => assertDurableReservationProvider({ reserve: async () => undefined } as never, false)).toThrowError(/normalized durable reservation/);
    expect(() => assertDurableReservationProvider({ durable: true, storeKind: 'normalized-sqlite', reserve: async () => undefined } as never, false)).not.toThrow();
    expect(() => assertDurableReservationProvider(undefined, true)).not.toThrow();
  });

  it('hard-blocks paid Robinhood and every live 4663 path while allowing paid Ethereum policy evaluation', () => {
    expect(() => assertDirectChainExecutionPolicy(4663, 1n, false)).toThrowError(/Paid Robinhood/);
    expect(() => assertDirectChainExecutionPolicy(4663, 0n, false)).toThrowError(/4663 live execution/);
    expect(() => assertDirectChainExecutionPolicy(4663, undefined, false)).toThrowError(/4663 live execution/);
    expect(() => assertDirectChainExecutionPolicy(4663, 1n, true)).toThrowError(/Paid Robinhood/);
    expect(() => assertDirectChainExecutionPolicy(1, 1n, false)).not.toThrow();
  });

  it('keeps stable canonical run, execution, and intent identity', () => {
    const first = canonicalExecutionIdentity('run_1', 'intent_1', 0, wallet);
    const second = canonicalExecutionIdentity('run_1', 'intent_1', 0, wallet);
    expect(second).toEqual(first);
    expect(first.executionId).toMatch(/^execution_[0-9a-f]{32}$/);
    expect(first.transactionIntentId).toMatch(/^intent_[0-9a-f]{32}$/);
    expect(reservationCampaignId('campaign_1', wallet)).toBe('campaign_1');
    expect(reservationCampaignId(undefined, wallet)).toBe(`contract:${wallet.toLowerCase()}`);
  });

  it('enforces timing and simulation freshness at the admission boundary', () => {
    expect(() => assertTimingWindow(2_000, 1_000, 100)).toThrowError(/start window/);
    expect(() => assertTimingWindow(2_000, 1_999.5, 1_000)).not.toThrow();
    const fresh = { walletIndex: 0, address: wallet, sourceBlock: 10n, checkedAt: new Date('2026-09-14T00:00:00.000Z'), success: true };
    expect(() => assertSimulationFresh(fresh, new Date('2026-09-14T00:00:30.000Z'), 60_000)).not.toThrow();
    expect(() => assertSimulationFresh(fresh, new Date('2026-09-14T00:02:00.000Z'), 60_000)).toThrowError(/stale/);
  });

  it('classifies provider ambiguity and retains deterministic transaction identity', () => {
    expect(classifyBroadcastResult({ txHash: hash, endpoint: 'rpc-a', latencyMs: 1, success: false, ambiguous: true })).toBe('ambiguous');
    expect(classifyBroadcastResult({ txHash: hash, endpoint: 'rpc-a', latencyMs: 1, success: false, error: 'already known' })).toBe('already_known');
    expect(classifyBroadcastResult({ txHash: hash, endpoint: 'rpc-a', latencyMs: 1, success: true })).toBe('accepted');
    expect(broadcastAttemptId('execution_1', 0, 'rejected')).not.toBe(broadcastAttemptId('execution_1', 1, 'accepted'));
    const selected = selectBroadcastAttempt('execution_1', [
      { txHash: hash, endpoint: 'rpc-a', latencyMs: 1, success: false, responseClass: 'rejected' },
      { txHash: replacementHash, endpoint: 'rpc-b', latencyMs: 2, success: true, responseClass: 'accepted' },
    ]);
    expect(selected?.resultIndex).toBe(1);
    expect(selected?.attemptId).toBe('execution_1:attempt:1:accepted');
    expect(selected?.result.txHash).toBe(replacementHash);
  });

  it('links hash and nonce outcomes to replacement, ambiguity, and reorg states', () => {
    expect(reconcileByHashAndNonce({ originalHash: hash, observedHash: replacementHash, receiptVisible: false }).state).toBe('replaced');
    expect(reconcileByHashAndNonce({ originalHash: hash, observedHash: hash, receiptVisible: false }).state).toBe('ambiguous');
    expect(reconcileByHashAndNonce({ originalHash: hash, receiptVisible: true, receiptStatus: 'success', receiptCanonical: false }).state).toBe('reorged');
    expect(mapChainStatus({ chainId: 1, receiptVisible: false, dropped: true })).toBe('dropped');
    expect(reconcileTransaction({ receiptVisible: true, receiptStatus: 'success', sender: wallet, nonce: 1, chainPendingNonce: 2, restart: false, originalHash: hash, observedHash: replacementHash }).action).toBe('record-replacement');
  });

  it('does not treat Robinhood soft or posted stages as product success or settlement', () => {
    expect(lifecycleStateForFinality(4663, 'soft', 'success')).toBe('included');
    expect(lifecycleStateForFinality(4663, 'posted', 'success')).toBe('posted');
    expect(lifecycleStateForFinality(4663, 'ethereum_final', 'success')).toBe('ethereum_final');
    expect(shouldSettleReceipt(4663, 'success', 'soft')).toBe(false);
    expect(shouldSettleReceipt(4663, 'success', 'posted')).toBe(false);
    expect(shouldSettleReceipt(4663, 'success', 'ethereum_final')).toBe(true);
    expect(shouldSettleReceipt(1, 'reverted', 'confirmed')).toBe(true);
    const components = actualSettlementComponents(100n, 7n, 20n);
    expect(components.actualL2ExecutionGasWei + (components.actualPriorityFeeComponentWei ?? 0n) + components.actualL1DataGasWei).toBe(107n);
    expect(components.actualMintValueWei).toBe(0n);
    expect(mapChainStatus({ chainId: 4663, receiptVisible: true, receiptStatus: 'success', finalityStage: 'posted' })).toBe('posted');
  });

  it('propagates receipt reorg evidence without releasing the reservation', () => {
    const error = new ReceiptReorgedError(hash, 42n);
    expect(error.txHash).toBe(hash);
    expect(error.blockNumber).toBe(42n);
    expect(error.message).toMatch(/no longer canonical/);
  });

  it('scrubs decrypted key references on the failure path without exposing values', () => {
    const keyReferences = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`] as Hash[];
    zeroizePrivateKeyArray(keyReferences);
    expect(keyReferences).toEqual(['0x00', '0x00']);
  });

  it('blocks a direct FREE live MintEngine before any RPC or signer access', async () => {
    await expect(new MintEngine(liveConfig('ethereum')).execute('not-used')).rejects.toMatchObject({ code: 'DURABLE_RESERVATION_REQUIRED' });
  });

  it('blocks direct live chain-4663 execution before mutable chain configuration', async () => {
    await expect(new MintEngine(liveConfig('robinhood')).execute('not-used')).rejects.toMatchObject({ code: 'CHAIN_4663_EXECUTION_DISABLED' });
  });
});
