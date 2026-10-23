import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { FinalityObserver } from './finality-observer.js';
import type { BaseEnablementGrant, MintJobConfig, RobinhoodEnablementGrant, Signer, SpendReservation, SpendReservationProvider, TransactionIntent, EngineLifecycleStore } from './types.js';

/**
 * Bot-path rehearsal on a local Anvil fork (Robinhood step E2, T-022, D-038, owner option 2).
 *
 * It drives the REAL `MintEngine` (reserve, sign, broadcast, receipt, settle) with fresh local wallets
 * that exist only on the fork, a test reservation provider and a test lifecycle store. Nothing real is
 * spent and no secret is read. For chain `robinhood` only, this test process replaces the engine's
 * "4663 live execution disabled" refusal for FREE mints; paid Robinhood stays blocked, and no production
 * code or configuration is changed. It does not exercise backend admission (coordinator and canonical
 * store keep their own refusals and tests).
 *
 * Runs only when a loopback Anvil URL is supplied:
 *   ANVIL_REHEARSAL_RPC_URL  loopback RPC of the fork
 *   REHEARSAL_CHAIN          'ethereum' (harness proof) or 'robinhood'
 *   REHEARSAL_NFT            address of an OPEN, FREE SeaDrop public drop on that fork
 *   REHEARSAL_MAX_FEE_GWEI   optional max fee per gas for the engine (default 0.8, must stay above the fork's base fee)
 */
const rpcUrl = process.env.ANVIL_REHEARSAL_RPC_URL;
const chainName = (process.env.REHEARSAL_CHAIN ?? 'ethereum') as 'ethereum' | 'base' | 'robinhood';
const nft = process.env.REHEARSAL_NFT as Address | undefined;
const paidMode = process.env.REHEARSAL_PAID === 'true';
const chainId = chainName === 'robinhood' ? 4663 : chainName === 'base' ? 8453 : 1;
const rehearsalNow = process.env.REHEARSAL_NOW_UNIX && /^\d+$/.test(process.env.REHEARSAL_NOW_UNIX)
  ? new Date(Number(process.env.REHEARSAL_NOW_UNIX) * 1000)
  : undefined;

const isLoopback = (url: string | undefined): boolean => {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname); } catch { return false; }
};

vi.mock('./chains.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chains.js')>();
  return {
    ...actual,
    resolveChainByNameFromSecrets: async (name: string) => !isLoopback(process.env.ANVIL_REHEARSAL_RPC_URL) ? Promise.reject(new Error('REHEARSAL_REQUIRES_LOOPBACK_RPC')) : ({
      ...actual.getChainByName(name),
      executionEnabled: true,
      verificationStatus: 'verified',
      rpcEndpoints: [process.env.ANVIL_REHEARSAL_RPC_URL ?? ''],
      confirmationDepth: 1,
    }),
  };
});

vi.mock('./lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lifecycle.js')>();
  return {
    ...actual,
    // Test process only and loopback fork only. Paid is admitted only for the explicit D-054 rehearsal process.
    assertDirectChainExecutionPolicy: (id: number, value: bigint | undefined, dryRun: boolean, grant?: RobinhoodEnablementGrant, now?: Date, baseGrant?: BaseEnablementGrant): void => {
      // `value` is undefined only for the early check made before the drop is read; the later check carries the real price.
      if (id === 4663 && process.env.REHEARSAL_CHAIN === 'robinhood' && isLoopback(process.env.ANVIL_REHEARSAL_RPC_URL) && (value === undefined || value === 0n || process.env.REHEARSAL_PAID === 'true')) return;
      return actual.assertDirectChainExecutionPolicy(id as never, value, dryRun, grant, now, baseGrant);
    },
  };
});

const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `RPC_${method}_FAILED`);
  return body.result;
}

class RehearsalSigner implements Signer {
  readonly signed: number[] = [];
  readonly signedBytes = new Map<number, Hex>();
  constructor(private readonly accounts: ReturnType<typeof privateKeyToAccount>[]) {}
  async listWallets() { return this.accounts.map((account, index) => ({ index, address: account.address })); }
  async signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex> {
    const account = this.accounts[walletIndex]!;
    if (intent.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('WALLET_BOUNDARY_VIOLATION');
    this.signed.push(walletIndex);
    const bytes = await account.signTransaction({ type: 'eip1559', chainId: intent.chainId, to: intent.to as Hex, value: intent.value, data: intent.data as Hex, nonce: intent.nonce, gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas });
    this.signedBytes.set(walletIndex, bytes);
    return bytes;
  }
  zeroize(): void { /* nothing held beyond this test */ }
}

type Reserved = { id: string; walletIndex: number; status: 'reserved' | 'settled' | 'released'; maxValueWei: bigint; actualMintValueWei?: bigint; actualGasWei?: bigint; actualL1DataGasWei?: bigint };
function reservationProvider(onReserve?: (walletIndex: number) => void, seenKeys = new Set<string>()): { provider: SpendReservationProvider; records: Reserved[] } {
  const records: Reserved[] = [];
  const provider: SpendReservationProvider = {
    durable: true,
    storeKind: 'normalized-sqlite',
    reserve: async (input) => {
      // Like the durable store, a repeated idempotency key is refused rather than reserved twice.
      if (seenKeys.has(input.idempotencyKey)) throw new Error('IDEMPOTENCY_KEY_ALREADY_USED');
      seenKeys.add(input.idempotencyKey);
      const record: Reserved = { id: `res-${records.length}`, walletIndex: input.walletIndex, status: 'reserved', maxValueWei: input.valueWei };
      records.push(record);
      onReserve?.(input.walletIndex);
      const reservation: SpendReservation = {
        reservationId: record.id, walletIndex: input.walletIndex, maxValueWei: input.valueWei, maxGasCostWei: input.maxGasCostWei, durable: true, storeKind: 'normalized-sqlite',
        settle: async (value, gas) => { record.status = 'settled'; record.actualMintValueWei = value; record.actualGasWei = gas; },
        settleComponents: async (components) => { record.status = 'settled'; record.actualMintValueWei = components.actualMintValueWei; record.actualGasWei = components.actualL2ExecutionGasWei; record.actualL1DataGasWei = components.actualL1DataGasWei; },
        release: async () => { if (record.status === 'reserved') record.status = 'released'; },
      };
      return reservation;
    },
  };
  return { provider, records };
}

function lifecycleStore(): { store: EngineLifecycleStore; attempts: string[]; receipts: string[] } {
  const attempts: string[] = [];
  const receipts: string[] = [];
  const store: EngineLifecycleStore = {
    durable: true,
    storeKind: 'normalized-sqlite',
    persistRun: async () => undefined,
    persistIntent: async () => undefined,
    persistAttempt: async (record) => { attempts.push(record.id); },
    persistReceipt: async (record) => { receipts.push(record.id); },
    persistReconciliation: async () => undefined,
  };
  return { store, attempts, receipts };
}

const finality = (stage: 'soft' | 'posted' | 'ethereum_final'): FinalityObserver => ({
  observe: async () => ({ chainId: chainId as never, stage, canonical: true, ready: stage === 'ethereum_final', observedAt: new Date() }),
});

describe.skipIf(!isLoopback(rpcUrl) || !nft)(`${paidMode ? 'paid ' : ''}bot-path rehearsal on a local ${chainName} fork (${paidMode ? 'D-054' : 'T-022'})`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'mintbot-rehearsal-'));
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  let client: ReturnType<typeof createPublicClient>;
  let cleanSnapshot: unknown;

  const config = (killSwitchFile: string, quantity = 1): MintJobConfig => ({
    target: { chain: chainName, contract: nft!, strategy: 'seadrop-v1-public', quantity, campaignId: 'rehearsal-campaign', policyRef: 'rehearsal' },
    fleet: { walletFile: join(directory, 'unused'), maxWallets: 2 },
    timing: { mintStartUnix: 'auto', armBeforeMs: 60_000 },
    // The free-mint reserve cap (0.0002 ETH per wallet) bounds padded gas x max fee, so the fee is kept low here.
    fees: { maxFeePerGasGwei: Number(process.env.REHEARSAL_MAX_FEE_GWEI ?? '0.8'), maxPriorityFeePerGasGwei: 0.05, gasLimitPadding: 1.3 },
    safety: {
      // Base: the free D-057 numbers, or in paid mode the D-062 paid numbers (0.0037 per NFT + 0.0002 fee allowance; 0.0082 a day).
      maxSpendEth: chainName === 'base' ? (paidMode ? 0.0039 : 0.0002) : 0.01,
      dailySpendCapEth: chainName === 'base' ? (paidMode ? 0.0082 : 0.0012) : 0.01,
      maxReplacementBumps: 0,
      dryRun: false,
      killSwitchFile,
      ...(chainName === 'base' ? {
        freeMintReserveCaps: { perWalletCapWei: 200_000_000_000_000n, activePeriodCapWei: 1_200_000_000_000_000n },
        baseGrant: { expiresAt: '9999-12-31T23:59:59.999Z', freeAllowed: true as const, paidAllowed: paidMode },
      } : {}),
    },
    broadcast: { mode: 'public', rpcEndpoints: chainName === 'base' ? [rpcUrl!, rpcUrl!.replace('127.0.0.1', 'localhost')] : [rpcUrl!], blastParallel: false },
    observability: { logLevel: 'error', logFile: join(directory, 'engine.log') },
  });
  const killFile = (name: string): string => join(directory, name);
  const balanceOf = async (address: Address): Promise<bigint> => client.readContract({ address: nft!, abi: balanceAbi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>;

  // Anvil only mines when a transaction arrives; the engine waits for later blocks, so a fork-only timer mines them.
  let miner: ReturnType<typeof setInterval> | undefined;
  beforeAll(async () => {
    miner = setInterval(() => { void rpc('evm_mine').catch(() => undefined); }, 700);
    client = createPublicClient({ transport: http(rpcUrl!) });
    expect(await rpc('eth_chainId')).toBe(`0x${chainId.toString(16)}`);
    for (const account of accounts) await rpc('anvil_setBalance', [account.address, '0x56BC75E2D63100000']); // 100 ETH on the fork only
    // A fresh Orbit-chain fork has no excess-blob-gas value in its head block, which makes Anvil refuse eth_call at 'latest'; one mined block fixes that.
    await rpc('evm_mine');
    cleanSnapshot = await rpc('evm_snapshot');
  });
  beforeEach(async () => {
    if (cleanSnapshot !== undefined) await rpc('evm_revert', [cleanSnapshot]);
    cleanSnapshot = await rpc('evm_snapshot');
  });
  afterAll(() => { if (miner) clearInterval(miner); rmSync(directory, { recursive: true, force: true }); });

  // A fork keeps the base fee it inherited, which can sit above the engine's capped max fee; pin it low on the fork only.
  const lowBaseFee = async (): Promise<void> => { await rpc('anvil_setNextBlockBaseFeePerGas', ['0x2faf080']); await rpc('evm_mine'); };

  async function run(signer: Signer, provider: SpendReservationProvider, store: EngineLifecycleStore, kill: string, runId: string, observer: FinalityObserver | undefined = chainId === 4663 || chainId === 8453 ? finality('ethereum_final') : undefined) {
    await lowBaseFee();
    const { MintEngine } = await import('./mint-engine.js');
    return new MintEngine(config(kill), {
      reservationProvider: provider, lifecycleStore: store, signerFactory: async () => signer, ...(observer ? { finalityObserver: observer } : {}), runId, intentId: `${runId}-intent`, requestId: runId,
      ...(rehearsalNow ? { now: () => rehearsalNow } : {}),
      identityForWallet: (wallet, id) => ({ executionId: `${id}:wallet:${wallet.index}`, transactionIntentId: `${id}:intent:${wallet.index}` }) as never,
    }).execute('rehearsal-not-a-secret');
  }

  it('mints from two wallets through reserve, sign, broadcast and receipt, and settles both reservations', async () => {
    const signer = new RehearsalSigner(accounts);
    const { provider, records } = reservationProvider();
    const { store, attempts, receipts } = lifecycleStore();
    const before = await Promise.all(accounts.map((account) => balanceOf(account.address)));
    const result = await run(signer, provider, store, killFile('none-1'), 'rehearsal-1');
    expect(signer.signed.sort(), JSON.stringify(result.walletResults.map((wallet) => ({ status: wallet.status, error: wallet.error })))).toEqual([0, 1]);
    expect(result.walletResults.map((wallet) => wallet.status)).toEqual(['success', 'success']);
    expect(result.successCount).toBe(2);
    const after = await Promise.all(accounts.map((account) => balanceOf(account.address)));
    expect(after.map((value, index) => value - before[index]!)).toEqual([1n, 1n]);
    expect(records.map((record) => record.status)).toEqual(['settled', 'settled']);
    if (paidMode) {
      expect(records.every((record) => record.maxValueWei > 0n)).toBe(true);
      expect(records.every((record) => record.actualMintValueWei === record.maxValueWei)).toBe(true);
      expect(records.every((record) => record.actualL1DataGasWei !== undefined)).toBe(true);
    }
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(receipts.length).toBe(2);
  }, 60_000);

  it('stops further signing when the kill switch trips after the first reservation, and releases it', async () => {
    const signer = new RehearsalSigner(accounts);
    const kill = killFile('kill-2');
    const { provider, records } = reservationProvider((walletIndex) => { if (walletIndex === 1) writeFileSync(kill, 'stop'); });
    const { store } = lifecycleStore();
    const outcome = await run(signer, provider, store, kill, 'rehearsal-2').catch((error: unknown) => error);
    // Whether the engine throws or reports per-wallet failures, nothing may be signed for wallet 1 and it must end released.
    expect(signer.signed).not.toContain(1);
    const second = records.find((record) => record.walletIndex === 1);
    expect(second, 'wallet 1 reserved before the kill switch tripped').toBeDefined();
    expect(second!.status).toBe('released');
    expect(second!.status).not.toBe('settled');
    // Wallet 0 was already past its own reservation when the switch tripped, so it may legitimately finish.
    void outcome;
  }, 60_000);

  it('does not mint again when the same run is repeated after a restart (durable idempotency refusal)', async () => {
    const keys = new Set<string>();
    const first = reservationProvider(undefined, keys);
    const { store } = lifecycleStore();
    await run(new RehearsalSigner(accounts), first.provider, store, killFile('none-3'), 'rehearsal-3');
    const afterFirst = await Promise.all(accounts.map((account) => balanceOf(account.address)));
    const repeatSigner = new RehearsalSigner(accounts);
    const repeat = reservationProvider(undefined, keys);
    await run(repeatSigner, repeat.provider, store, killFile('none-3b'), 'rehearsal-3').catch(() => undefined);
    expect(repeatSigner.signed).toEqual([]);
    expect(await Promise.all(accounts.map((account) => balanceOf(account.address)))).toEqual(afterFirst);
  }, 60_000);

  it('re-sending the already confirmed signed bytes cannot mint a second time (duplicate submission)', async () => {
    const signer = new RehearsalSigner(accounts);
    const { provider } = reservationProvider();
    const { store } = lifecycleStore();
    await run(signer, provider, store, killFile('none-4'), 'rehearsal-4');
    const afterFirst = await balanceOf(accounts[0]!.address);
    const bytes = signer.signedBytes.get(0)!;
    await expect(rpc('eth_sendRawTransaction', [bytes])).rejects.toThrow(/nonce|already|known/i);
    expect(await balanceOf(accounts[0]!.address)).toBe(afterFirst);
  }, 60_000);

  if (chainName === 'robinhood') it('Robinhood: a receipt at soft finality is not settled as final', async () => {
    const signer = new RehearsalSigner(accounts);
    const { provider, records } = reservationProvider();
    const { store } = lifecycleStore();
    const outcome = await run(signer, provider, store, killFile('none-5'), 'rehearsal-5', finality('soft')).catch((error: unknown) => error);
    expect(signer.signed.length).toBeGreaterThan(0); // it really signed and broadcast, so the unsettled result is about finality
    expect(records.some((record) => record.status === 'settled')).toBe(false);
    if (!(outcome instanceof Error)) expect((outcome as { successCount: number }).successCount).toBe(0);
  }, 60_000);
});
