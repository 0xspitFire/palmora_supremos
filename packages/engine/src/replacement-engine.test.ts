import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, parseGwei, parseTransaction, type Hash, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MintEngine } from './mint-engine.js';
import { registerStrategy } from './drop-reader.js';
import { broadcastAttemptId } from './lifecycle.js';
import type { BroadcastResult, DropConfig, MintJobConfig, MintReceipt, MintStrategy, TransactionIntent, WalletMintResult } from './types.js';

/**
 * T-094: the whole send-and-replace flow of one wallet, driven through the real MintEngine.executeFleet with fakes for the chain, the
 * signer, the reservation store, the lifecycle store and the clock. Time only moves when the test advances it.
 */
const account = privateKeyToAccount(generatePrivateKey());
const CONTRACT = '0x1111111111111111111111111111111111111111' as const;
const STRATEGY = 'fake-t094';
const GAS_LIMIT = 100_000n;
const START = new Date('2026-10-28T12:00:00.000Z');

let dropOnChain: DropConfig;
const baseDrop = (): DropConfig => ({ nftContract: CONTRACT, mintPrice: 0n, maxTotalMintableByWallet: 5, maxTokenSupply: 1000n, totalMinted: 0n, startTime: 0, endTime: 0, feePayer: '0x2222222222222222222222222222222222222222', strategyName: STRATEGY, chainId: 4663, extra: { seaDropAddress: '0x3333333333333333333333333333333333333333', feeBps: 250, restrictFeeRecipients: true, totalSupplyKnown: true, maxSupplyKnown: true } });
const fakeStrategy: MintStrategy = {
  name: STRATEGY,
  readDrop: async () => dropOnChain,
  validateDrop: () => ({ valid: true, errors: [], warnings: [] }),
  buildCalldata: () => '0x1234',
} as unknown as MintStrategy;

function config(opts: { replacement?: boolean; bumps?: number } = {}): MintJobConfig {
  return {
    target: { chain: 'robinhood', contract: CONTRACT, strategy: STRATEGY, quantity: 1, campaignId: 'campaign-t094' },
    fleet: { walletFile: '/tmp/never-read-wallet-file', maxWallets: 1 },
    timing: { mintStartUnix: 'auto', armBeforeMs: 30_000 },
    fees: { maxFeePerGasGwei: 1, maxPriorityFeePerGasGwei: 0.1, gasLimitPadding: 1.1, ...(opts.replacement === false ? {} : { replacement: { ceilingMaxFeePerGasGwei: 1.3, ceilingMaxPriorityFeePerGasGwei: 0.13, stuckAfterMs: 8_000, policyLimits: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 }, ownerCap: { maxFeePerGasGwei: 1.3, maxPriorityFeePerGasGwei: 0.13 } } }) },
    safety: { maxSpendEth: 1, dailySpendCapEth: 1, maxReplacementBumps: opts.bumps ?? 2, dryRun: false, killSwitchFile: `/tmp/mintbot-t094-engine-${process.pid}-kill`, robinhoodGrant: { expiresAt: '2099-01-01T00:00:00.000Z', freeAllowed: true, paidAllowed: false } },
    broadcast: { mode: 'sequencer', rpcEndpoints: [], blastParallel: false },
    observability: { logLevel: 'silent', logFile: '/tmp/mintbot-t094-engine.log' },
  } as unknown as MintJobConfig;
}

function harness(cfg: MintJobConfig, behaviour: { signError?: (call: number) => boolean; nonceOnChain?: () => number; broadcastOutcome?: (call: number) => 'accepted' | 'rejected'; receiptReadError?: boolean; persistAttemptFails?: (id: string) => boolean; reconfirmRefuses?: () => boolean; noReconfirm?: boolean } = {}) {
  const log: string[] = [];
  const signed: Hex[] = [];
  const intents: TransactionIntent[] = [];
  const reservations: Array<{ maxGasCostWei: bigint; l2ExecutionGasWei: bigint; priorityFeeComponentWei: bigint }> = [];
  const settled: unknown[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  const mined = new Map<string, MintReceipt>();
  const waiters = new Map<string, Array<(receipt: MintReceipt) => void>>();
  const rejecters: Array<(error: Error) => void> = [];
  let broadcasts = 0;

  const signer = {
    listWallets: async () => [{ index: 0, address: account.address }],
    signTransaction: async (_index: number, intent: TransactionIntent) => {
      const call = signed.length;
      log.push(`sign:${call}`);
      if (behaviour.signError?.(call)) throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
      intents.push(intent);
      const tx = await account.signTransaction({ type: 'eip1559', chainId: intent.chainId, to: intent.to, value: intent.value, data: intent.data, nonce: intent.nonce, gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas });
      signed.push(tx);
      return tx;
    },
    zeroize: () => undefined,
  };
  const publicClient = {
    getBlockNumber: async () => 1_000n,
    call: async () => ({ data: '0x' }),
    getTransactionCount: async () => behaviour.nonceOnChain?.() ?? 4,
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      if (behaviour.receiptReadError) throw new Error('rpc unavailable');
      const receipt = mined.get(hash.toLowerCase());
      if (!receipt) throw Object.assign(new Error('Transaction receipt could not be found'), { name: 'TransactionReceiptNotFoundError' });
      return receipt;
    },
  };
  const broadcaster = {
    name: 'sequencer-direct',
    broadcast: async (txs: Hex[]): Promise<BroadcastResult[]> => {
      const call = broadcasts++;
      log.push(`broadcast:${call}`);
      const hash = keccak256(txs[0]!);
      if (behaviour.broadcastOutcome?.(call) === 'rejected') return [{ txHash: hash, endpoint: 'https://seq.example', latencyMs: 1, success: false, error: 'replacement transaction underpriced', responseClass: 'rejected' }];
      return [{ txHash: hash, endpoint: 'https://seq.example', latencyMs: 1, success: true, responseClass: 'accepted' }];
    },
  };
  const nonceManager = { getNonce: async () => 4, consumeNonce: () => undefined, resetNonce: async () => 4 };
  const receiptWatcher = {
    waitForReceipt: (hash: Hash) => new Promise<MintReceipt>((resolve, reject) => {
      rejecters.push(reject);
      const found = mined.get(hash.toLowerCase());
      if (found) { resolve(found); return; }
      waiters.set(hash.toLowerCase(), [...(waiters.get(hash.toLowerCase()) ?? []), resolve]);
    }),
  };
  const lifecycleStore = {
    persistIntent: async () => { log.push('persistIntent'); },
    persistAttempt: async (record: Record<string, unknown>) => {
      if (behaviour.persistAttemptFails?.(String(record['id']))) throw new Error('store unavailable');
      log.push(`attempt:${String(record['id'])}`);
      attempts.push(record);
    },
    persistReceipt: async (record: Record<string, unknown>) => { receipts.push(record); },
    persistReconciliation: async (record: Record<string, unknown>) => { reconciliations.push(record); },
  };
  const reservationProvider = {
    durable: true as const,
    storeKind: 'normalized-sqlite' as const,
    ...(behaviour.noReconfirm ? {} : { reconfirm: async () => { log.push('reconfirm'); if (behaviour.reconfirmRefuses?.()) throw new Error('CHAIN_ENABLEMENT_NOT_CURRENT'); } }),
    reserve: async (request: { maxGasCostWei: bigint; l2ExecutionGasWei: bigint; priorityFeeComponentWei: bigint }) => {
      log.push('reserve');
      reservations.push(request);
      return { reservationId: 'res-1', walletIndex: 0, maxValueWei: 0n, maxGasCostWei: request.maxGasCostWei, settle: async () => { settled.push('settle'); }, settleComponents: async (components: unknown) => { settled.push(components); }, release: async () => { log.push('release'); } };
    },
  };
  const engine = new MintEngine(cfg, { reservationProvider: reservationProvider as never, lifecycleStore: lifecycleStore as never, runId: 'run-t094', now: () => new Date(Date.now()) });
  const receiptFor = (hash: Hash): MintReceipt => ({ txHash: hash, status: 'success', blockNumber: 1_001n, blockHash: `0x${'6'.repeat(64)}`, gasUsed: 90_000n, effectiveGasPrice: 1_000_000_000n, confirmations: 1, finalityStage: 'ethereum_final' } as MintReceipt);
  const mine = (hash: Hash) => {
    const receipt = receiptFor(hash);
    mined.set(hash.toLowerCase(), receipt);
    for (const resolve of waiters.get(hash.toLowerCase()) ?? []) resolve(receipt);
  };
  const run = (): Promise<WalletMintResult[]> => (engine as unknown as { executeFleet: (...args: unknown[]) => Promise<WalletMintResult[]> }).executeFleet(
    'run-t094', [0], signer, publicClient, fakeStrategy, baseDrop(), broadcaster, nonceManager, receiptWatcher, 4663,
    new Map([[0, GAS_LIMIT]]), new Map([[0, { walletIndex: 0, address: account.address, sourceBlock: 1n, checkedAt: new Date(Date.now()), success: true }]]),
    (engine as unknown as { logger: unknown }).logger,
  );
  const failWaiters = (error: Error) => { for (const reject of rejecters) reject(error); };
  return { engine, run, mine, failWaiters, log, signed, intents, reservations, settled, attempts, receipts, reconciliations, broadcastCount: () => broadcasts, hashOf: (index: number) => keccak256(signed[index]!) };
}

beforeEach(() => { vi.useFakeTimers({ now: START }); dropOnChain = baseDrop(); registerStrategy(fakeStrategy); });
afterEach(() => { vi.useRealTimers(); });

/** Lets the first send complete, then moves the clock. */
async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); }

describe('T-094 replacement through the real engine flow', () => {
  it('sends one 10 percent replacement when the original is stuck, and settles on the replacement that mines', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(9_500);
    expect(h.signed).toHaveLength(2);
    h.mine(h.hashOf(1));
    await tick(1_500);
    const [result] = await running;

    // fees: the replacement is exactly +10 percent on both, same nonce, same calldata, value and gas limit
    const first = parseTransaction(h.signed[0]!);
    const second = parseTransaction(h.signed[1]!);
    expect(second).toMatchObject({ nonce: first.nonce, to: first.to, data: first.data, gas: first.gas, maxFeePerGas: parseGwei('1.1'), maxPriorityFeePerGas: parseGwei('0.11') });
    expect(second.value ?? 0n).toBe(first.value ?? 0n);
    expect(first).toMatchObject({ maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('0.1') });

    // the replacement is signed and its attempt persisted BEFORE it is broadcast
    expect(h.log.indexOf('attempt:' + result!.executionId + ':attempt:replacement-1:signed')).toBeGreaterThan(-1);
    expect(h.log.indexOf('attempt:' + result!.executionId + ':attempt:replacement-1:signed')).toBeLessThan(h.log.indexOf('broadcast:1'));

    // the result and the receipt belong to the replacement
    const winnerAttemptId = broadcastAttemptId(`${result!.executionId}:replacement-1`, 0, 'accepted');
    expect(result).toMatchObject({ txHash: h.hashOf(1), submittedAttemptId: winnerAttemptId });
    expect(result!.attemptHashes?.[winnerAttemptId]).toBe(h.hashOf(1));
    expect(result!.attemptReplacements?.[winnerAttemptId]).toBe(`${result!.executionId}:attempt:signed`);
    expect(result!.replacedAttemptIds).toEqual([`${result!.executionId}:attempt:signed`, broadcastAttemptId(result!.executionId!, 0, 'accepted')]);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]).toMatchObject({ transactionAttemptId: winnerAttemptId, txHash: h.hashOf(1) });
    expect(h.reconciliations.at(-1)).toMatchObject({ transactionAttemptId: winnerAttemptId, state: 'matched' });
    // settled exactly once, from the winner's receipt
    expect(h.settled).toHaveLength(1);
  });

  it('reserves at the CEILING fee up front, once, and never grows it', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(9_500);
    h.mine(h.hashOf(1));
    await tick(1_500);
    await running;
    expect(h.reservations).toHaveLength(1);
    expect(h.reservations[0]).toMatchObject({ maxGasCostWei: GAS_LIMIT * parseGwei('1.3'), l2ExecutionGasWei: GAS_LIMIT * parseGwei('1.3'), priorityFeeComponentWei: parseGwei('0.13') });
    expect(h.log.filter((entry) => entry === 'reserve')).toHaveLength(1);
  });

  it('settles on the ORIGINAL if it mines after a replacement was already sent', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(9_500);
    expect(h.signed).toHaveLength(2);
    h.mine(h.hashOf(0));
    await tick(1_500);
    const [result] = await running;
    expect(result).toMatchObject({ txHash: h.hashOf(0) });
    expect(h.receipts[0]).toMatchObject({ txHash: h.hashOf(0), transactionAttemptId: broadcastAttemptId(result!.executionId!, 0, 'accepted') });
    expect(result!.replacedAttemptIds).toEqual([`${result!.executionId}:attempt:replacement-1:signed`, broadcastAttemptId(`${result!.executionId}:replacement-1`, 0, 'accepted')]);
    expect(h.settled).toHaveLength(1);
  });

  it('sends nothing extra when the original mines before it is stuck', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(3_000);
    h.mine(h.hashOf(0));
    await tick(1_500);
    const [result] = await running;
    expect(h.signed).toHaveLength(1);
    expect(h.broadcastCount()).toBe(1);
    expect(result).toMatchObject({ txHash: h.hashOf(0) });
    expect(result!.attemptHashes).toBeDefined();
    expect(result!.replacedAttemptIds).toBeUndefined();
  });

  it('is completely unchanged when replacement is not configured: one signature, one send, no extra fields', async () => {
    const h = harness(config({ replacement: false }));
    const running = h.run();
    await tick(30_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    const [result] = await running;
    expect(h.broadcastCount()).toBe(1);
    expect(result!.attemptHashes).toBeUndefined();
    expect(result!.attemptReplacements).toBeUndefined();
    expect(result!.replacedAttemptIds).toBeUndefined();
    expect(h.reservations[0]).toMatchObject({ maxGasCostWei: GAS_LIMIT * parseGwei('1') });
  });

  it('never replaces with zero bumps allowed', async () => {
    const h = harness(config({ bumps: 0 }));
    const running = h.run();
    await tick(30_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('stops after the allowed number of replacements', async () => {
    const h = harness(config({ bumps: 1 }));
    const running = h.run();
    await tick(40_000);
    expect(h.signed).toHaveLength(2);
    h.mine(h.hashOf(1));
    await tick(1_500);
    await running;
  });

  it('does not replace once the kill switch is engaged', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(4_000);
    h.engine.kill('test kill');
    await tick(10_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('does not replace when the drop changed since approval', async () => {
    const h = harness(config());
    const running = h.run();
    await tick(4_000);
    dropOnChain = { ...baseDrop(), mintPrice: 10n ** 15n };
    await tick(10_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('does not replace when the sender nonce is already consumed on chain', async () => {
    const h = harness(config(), { nonceOnChain: () => 5 });
    const running = h.run();
    await tick(15_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('refuses to replace when it cannot read whether anything mined (unknown is never treated as not mined)', async () => {
    const h = harness(config(), { receiptReadError: true });
    const running = h.run();
    await tick(30_000);
    expect(h.signed).toHaveLength(1);
    expect(h.broadcastCount()).toBe(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('after a replacement was sent, a receipt failure is not misread as a foreign replacement of our own nonce', async () => {
    let nonce = 4;
    const h = harness(config(), { nonceOnChain: () => nonce });
    const running = h.run();
    await tick(9_500);
    expect(h.signed).toHaveLength(2);
    nonce = 5; // our own replacement (or original) now holds the nonce
    await tick(10_000); // the ladder sees the consumed nonce and stops; only then are the receipt watchers started
    h.failWaiters(new Error('receipt wait failed'));
    await tick(1_500);
    const [result] = await running;
    expect(result).toMatchObject({ status: 'timeout' });
    expect(result!.lifecycleState).not.toBe('replaced');
    expect(result!.reconciliationState).not.toBe('replaced');
    expect(result!.attemptHashes).toBeDefined();
    expect(h.settled).toHaveLength(0);
    expect(h.log).not.toContain('release'); // a sent transaction keeps its reservation
  });

  it('re-runs the store live gate before every replacement and stops when it refuses (a revocation after the first send)', async () => {
    let revoked = false;
    const h = harness(config(), { reconfirmRefuses: () => revoked });
    const running = h.run();
    await tick(4_000);
    revoked = true; // the owner revokes enablement in the store after the first send
    await tick(20_000);
    expect(h.signed).toHaveLength(1);
    expect(h.log).toContain('reconfirm');
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('also re-runs the store live gate inside the admission gate right before signing', async () => {
    let calls = 0;
    const h = harness(config(), { reconfirmRefuses: () => { calls += 1; return calls === 2; } }); // passes the pre-check, refuses the in-gate re-run
    const running = h.run();
    await tick(20_000);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('refuses to replace when the store provider has no live gate to re-run (fail closed)', async () => {
    const h = harness(config(), { noReconfirm: true });
    const running = h.run();
    await tick(20_000);
    expect(h.signed).toHaveLength(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await running;
  });

  it('never starts a second ladder for the same execution in one process', async () => {
    const h = harness(config());
    const first = h.run();
    await tick(3_000);
    h.mine(h.hashOf(0));
    await tick(1_500);
    await first;
    expect(h.signed).toHaveLength(1);
    const second = h.run();
    await tick(40_000);
    expect(h.signed.length).toBeLessThanOrEqual(3); // the second run signs its own first transaction only; it must not run another ladder
    expect(h.log.filter((entry) => entry.startsWith('attempt:') && entry.includes('replacement-'))).toHaveLength(0);
    h.mine(h.hashOf(h.signed.length - 1));
    await tick(1_500);
    await second;
  });

  it('links a winning replacement to its signed attempt if its broadcast attempt could not be stored, never to the original', async () => {
    const h = harness(config(), { persistAttemptFails: (id) => id.includes('replacement-1:attempt') });
    const running = h.run();
    await tick(9_500);
    expect(h.signed).toHaveLength(2);
    h.mine(h.hashOf(1));
    await tick(1_500);
    const [result] = await running;
    expect(h.receipts[0]).toMatchObject({ txHash: h.hashOf(1), transactionAttemptId: `${result?.executionId ?? ''}:attempt:replacement-1:signed` });
  });

  it('a signer refusal ends replacing and the original is still watched to its result', async () => {
    const h = harness(config(), { signError: (call) => call === 1 });
    const running = h.run();
    await tick(20_000);
    expect(h.log.filter((entry) => entry.startsWith('sign:'))).toEqual(['sign:0', 'sign:1']);
    expect(h.broadcastCount()).toBe(1);
    h.mine(h.hashOf(0));
    await tick(1_500);
    const [result] = await running;
    expect(result).toMatchObject({ txHash: h.hashOf(0) });
  });

  it('a rejected replacement ends replacing but both hashes stay watched', async () => {
    const h = harness(config(), { broadcastOutcome: (call) => (call === 1 ? 'rejected' : 'accepted') });
    const running = h.run();
    await tick(30_000);
    expect(h.signed).toHaveLength(2);
    h.mine(h.hashOf(0));
    await tick(1_500);
    const [result] = await running;
    expect(result).toMatchObject({ txHash: h.hashOf(0) });
  });
});
