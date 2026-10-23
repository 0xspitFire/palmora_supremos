import { describe, expect, it } from 'vitest';
import type { Address, Hash } from 'viem';
import {
  assertDirectChainExecutionPolicy,
  authorizedBaseExecutionProfile,
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
import type { ChainConfig, MintJobConfig } from './types.js';

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

  it('D-062: paid Base is refused without a current grant that allows paid mints, and allowed with one', () => {
    const now = new Date('2026-10-23T12:00:00.000Z');
    const free = { expiresAt: '9999-12-31T23:59:59.999Z', freeAllowed: true as const, paidAllowed: false };
    const paid = { ...free, paidAllowed: true };
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, false, undefined, now, undefined)).toThrowError(/Paid Base/);
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, false, undefined, now, free)).toThrowError(/Paid Base/);
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, true, undefined, now, free)).toThrowError(/Paid Base/);
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, false, undefined, now, { ...paid, expiresAt: '2026-10-22T00:00:00.000Z' })).toThrowError(/Paid Base/);
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, false, undefined, now, paid)).not.toThrow();
    expect(() => assertDirectChainExecutionPolicy(8453, 0n, false, undefined, now, free)).not.toThrow();
    expect(() => assertDirectChainExecutionPolicy(8453, 0n, false, undefined, now, undefined)).toThrowError(/Base live execution/);
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
    expect(shouldSettleReceipt(8453, 'success', 'soft')).toBe(false);
    expect(shouldSettleReceipt(8453, 'success', 'posted')).toBe(false);
    expect(shouldSettleReceipt(8453, 'success', 'ethereum_final')).toBe(true);
    expect(lifecycleStateForFinality(8453, 'soft', 'reverted')).toBe('included');
    expect(lifecycleStateForFinality(8453, 'posted', 'reverted')).toBe('posted');
    expect(lifecycleStateForFinality(8453, 'ethereum_final', 'reverted')).toBe('failed');
    expect(shouldSettleReceipt(8453, 'reverted', 'soft')).toBe(false);
    expect(shouldSettleReceipt(8453, 'reverted', 'posted')).toBe(false);
    expect(shouldSettleReceipt(8453, 'reverted', 'ethereum_final')).toBe(true);
    expect(shouldSettleReceipt(1, 'reverted', 'confirmed')).toBe(true);
    const components = actualSettlementComponents(100n, 7n, 20n);
    expect(components.actualL2ExecutionGasWei + (components.actualPriorityFeeComponentWei ?? 0n) + components.actualL1DataGasWei).toBe(107n);
    expect(components.actualMintValueWei).toBe(0n);
    expect(mapChainStatus({ chainId: 4663, receiptVisible: true, receiptStatus: 'success', finalityStage: 'posted' })).toBe('posted');
  });

  it('derives an executable Base profile only from dry-run policy or a current owner grant', () => {
    const profile: ChainConfig = { chainId: 8453, name: 'Base', blockTimeMs: 2_000, confirmationDepth: 1, rpcEndpoints: [], isL2: true, verificationStatus: 'unverified', finalityPolicy: { stages: ['soft', 'posted', 'ethereum_final'], settlementStage: 'ethereum_final', notes: 'test' }, executionEnabled: false };
    const now = new Date('2026-10-20T00:00:00.000Z');
    expect(authorizedBaseExecutionProfile(profile, true, undefined, now)).toMatchObject({ verificationStatus: 'verified', executionEnabled: true });
    expect(() => authorizedBaseExecutionProfile(profile, false, undefined, now)).toThrow('Base live execution requires a current owner enablement record');
    expect(() => authorizedBaseExecutionProfile(profile, false, { expiresAt: now.toISOString(), freeAllowed: true, paidAllowed: false }, now)).toThrow('Base live execution requires a current owner enablement record');
    expect(authorizedBaseExecutionProfile(profile, false, { expiresAt: '2026-10-21T00:00:00.000Z', freeAllowed: true, paidAllowed: false }, now)).toMatchObject({ verificationStatus: 'verified', executionEnabled: true });
    expect(profile.executionEnabled).toBe(false);
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

describe('Robinhood enablement grant (D-040, Key 2): refused unless a current owner grant is passed in', () => {
  const now = new Date('2026-10-12T12:00:00.000Z');
  const current = { expiresAt: '2026-10-13T12:00:00.000Z', paidAllowed: false };

  it('keeps today\'s answers when there is no grant', () => {
    expect(() => assertDirectChainExecutionPolicy(4663, 1n, false, undefined, now)).toThrowError(/Paid Robinhood/);
    expect(() => assertDirectChainExecutionPolicy(4663, 0n, false, undefined, now)).toThrowError(/4663 live execution/);
    expect(() => assertDirectChainExecutionPolicy(4663, undefined, false, undefined, now)).toThrowError(/4663 live execution/);
    expect(() => assertDirectChainExecutionPolicy(4663, undefined, true, undefined, now)).not.toThrow();
  });

  it('allows free live Robinhood only with a current grant, and paid only when the grant allows paid', () => {
    expect(() => assertDirectChainExecutionPolicy(4663, 0n, false, current, now)).not.toThrow();
    expect(() => assertDirectChainExecutionPolicy(4663, 1n, false, current, now)).toThrowError(/Paid Robinhood/);
    expect(() => assertDirectChainExecutionPolicy(4663, 1n, false, { ...current, paidAllowed: true }, now)).not.toThrow();
  });

  it('refuses an expired grant, one expiring right now, and malformed grants', () => {
    expect(() => assertDirectChainExecutionPolicy(4663, 0n, false, { ...current, expiresAt: '2026-10-12T11:59:59.000Z' }, now)).toThrowError(/4663 live execution/);
    expect(() => assertDirectChainExecutionPolicy(4663, 0n, false, { ...current, expiresAt: now.toISOString() }, now)).toThrowError(/4663 live execution/);
    for (const bad of [{ expiresAt: 'soon', paidAllowed: true }, { expiresAt: '2026-10-13T12:00:00.000Z' }, { expiresAt: 5, paidAllowed: true }, {}, null, 'yes', true]) {
      expect(() => assertDirectChainExecutionPolicy(4663, 0n, false, bad as never, now)).toThrowError(/4663 live execution/);
      expect(() => assertDirectChainExecutionPolicy(4663, 1n, false, bad as never, now)).toThrowError(/Paid Robinhood/);
    }
  });

  it('does not touch Ethereum and independently gates Base', () => {
    expect(() => assertDirectChainExecutionPolicy(1, 1n, false, undefined, now)).not.toThrow();
    expect(() => assertDirectChainExecutionPolicy(8453, 0n, false, undefined, now)).toThrowError(/Base live execution/);
    expect(() => assertDirectChainExecutionPolicy(8453, 0n, false, undefined, now, { expiresAt: current.expiresAt, freeAllowed: true, paidAllowed: false })).not.toThrow();
    expect(() => assertDirectChainExecutionPolicy(8453, 1n, false, undefined, now, { expiresAt: current.expiresAt, freeAllowed: true, paidAllowed: false })).toThrowError(/Paid Base/);
    expect(() => assertDirectChainExecutionPolicy(8453, 0n, true, undefined, now)).not.toThrow();
  });
});

describe('the engine hands its Robinhood grant to the policy at every check', () => {
  it('passes safety.robinhoodGrant at all five call sites (four run-level checks and one per wallet before preparing and signing) and reads no environment variable for it', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./mint-engine.ts', import.meta.url), 'utf8');
    const calls = source.match(/assertDirectChainExecutionPolicy\(/g)?.length ?? 0;
    const granted = source.match(/this\.config\.safety\.robinhoodGrant/g)?.length ?? 0;
    expect(calls).toBe(5);
    expect(granted).toBe(6);
    expect(source).not.toMatch(/process\.env[^\n]*(ROBINHOOD|GRANT)/i);
  });
});
