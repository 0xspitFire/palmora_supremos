import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '@mint-bot/database';
import { CanonicalStoreBridge } from './canonical-store.js';
import { ExecutionCoordinator } from './coordinator.js';
import { campaignInputDigest } from './evidence.js';
import type { AttemptRecord, Campaign, EngineAdapter, ExecutionResult, ReceiptRecord, RunRecord } from './types.js';

// Runtime guardrail harness (T-001). Drives the canonical admission path against a loopback Anvil
// Ethereum fork and proves caps gate real side effects: per-run cap, per-wallet daily cap, and
// pending worst-case exposure reserved at admission (D-019). Run with `pnpm ops:guardrail-fork`.

const rpcUrl = process.env.ANVIL_ETHEREUM_RPC_URL;
const nft = process.env.ETHEREUM_SEADROP_NFT;
const feeRecipient = process.env.ETHEREUM_SEADROP_FEE_RECIPIENT;
const mintValueEnv = process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI;
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const MINT_PUBLIC_SELECTOR = '0x161ac21f'; // mintPublic(address,address,address,uint256)
const NOW = '2026-09-29T00:00:00.000Z';
const FEE = 50_000_000_000_000_000n; // 0.05 ETH worst-case fee budget per wallet; real SeaDrop mints cost far less.
const GAS_LIMIT = 300_000n;

function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

// Anvil fork errors can quote the upstream archive URL; never let one reach a test failure message.
const redactUrls = (text: string): string => text.replace(/\b(?:https?|wss?):\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])[^\s"'`)]+/gi, '[REDACTED_URL]');

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  if (!isLoopback(rpcUrl)) throw new Error('LOOPBACK_ANVIL_REQUIRED');
  const response = await fetch(rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(`RPC_${method}_FAILED: ${redactUrls(body.error?.message ?? String(response.status))}`);
  return body.result as T;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;
const word = (value: string): string => value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const mintData = (): string => `${MINT_PUBLIC_SELECTOR}${word(nft!)}${word(feeRecipient!)}${word('0x0')}${word('1')}`;
const nonceOf = async (wallet: string): Promise<bigint> => BigInt(await rpc<string>('eth_getTransactionCount', [wallet, 'pending']));
const balanceOf = async (wallet: string): Promise<bigint> => BigInt(await rpc<string>('eth_getBalance', [wallet, 'latest']));

async function eoaAccounts(): Promise<string[]> {
  const accounts = await rpc<string[]>('eth_accounts');
  const code = await Promise.all(accounts.map((account) => rpc<string>('eth_getCode', [account, 'latest'])));
  return accounts.filter((_, index) => code[index] === '0x');
}

interface RawReceipt { status: string; blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice: string }
async function waitReceipt(hash: string): Promise<RawReceipt> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const receipt = await rpc<RawReceipt | null>('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('RECEIPT_TIMEOUT');
}

type Mode = 'observe' | 'pending' | 'unobserved' | 'throws';

// Fork-backed engine: sends a real SeaDrop public mint from each admitted Anvil EOA.
// 'observe' returns a confirmed receipt; 'pending' leaves the tx unmined; 'unobserved' mines it but reports
// no receipt; 'throws' mines it and then fails like a transport timeout after broadcast.
class ForkEngine implements EngineAdapter {
  public mode: Mode = 'observe';
  public executeCalls = 0;
  public constructor(private readonly store: () => CanonicalStoreBridge, private readonly mintValue: bigint) {}

  public async prepare(): Promise<ExecutionResult> { return { executionIds: [], attempts: [], receipts: [], state: 'Prepared' }; }

  public async execute(request: { runId: string; wallets: readonly string[] }): Promise<ExecutionResult> {
    this.executeCalls += 1;
    const attempts: AttemptRecord[] = [];
    const receipts: ReceiptRecord[] = [];
    for (const wallet of request.wallets) {
      const executionId = `fork-${request.runId}-${wallet.toLowerCase()}`;
      const nonce = Number(await nonceOf(wallet));
      const hash = await rpc<string>('eth_sendTransaction', [{ from: wallet, to: SEADROP, value: hex(this.mintValue), data: mintData(), gas: hex(GAS_LIMIT) }]);
      const at = new Date().toISOString();
      const attempt: AttemptRecord = { id: `attempt-${executionId}`, executionId, runId: request.runId, wallet, nonce, hash, state: 'Pending', createdAt: at, updatedAt: at };
      if (this.mode === 'observe') {
        const raw = await waitReceipt(hash);
        attempt.state = raw.status === '0x1' ? 'Confirmed' : 'Failed';
        receipts.push(this.receipt(raw, attempt));
      } else if (this.mode === 'unobserved') {
        await waitReceipt(hash); // mined on chain, but the engine reports an unknown outcome
      } else if (this.mode === 'throws') {
        await waitReceipt(hash);
        throw new Error('ENGINE_TRANSPORT_TIMEOUT');
      }
      attempts.push(attempt);
    }
    const state = attempts.every((item) => item.state === 'Confirmed') ? 'Confirmed' : 'Pending';
    return { executionIds: attempts.map((item) => item.executionId), attempts, receipts, state };
  }

  public async reconcile(run: RunRecord): Promise<{ result: 'confirmed' | 'unknown'; attempts: AttemptRecord[]; receipts: ReceiptRecord[] }> {
    const known = this.store().snapshot().attempts.filter((item) => item.runId === run.id && item.hash);
    if (known.length === 0) return { result: 'unknown', attempts: [], receipts: [] };
    const attempts: AttemptRecord[] = [];
    const receipts: ReceiptRecord[] = [];
    for (const attempt of known) {
      const raw = await rpc<RawReceipt | null>('eth_getTransactionReceipt', [attempt.hash]);
      if (!raw) return { result: 'unknown', attempts: [], receipts: [] };
      const confirmed: AttemptRecord = { ...attempt, state: raw.status === '0x1' ? 'Confirmed' : 'Failed', updatedAt: new Date().toISOString() };
      attempts.push(confirmed);
      receipts.push(this.receipt(raw, confirmed));
    }
    return { result: 'confirmed', attempts, receipts };
  }

  private receipt(raw: RawReceipt, attempt: AttemptRecord): ReceiptRecord {
    const gasUsed = BigInt(raw.gasUsed);
    const effectiveGasPrice = BigInt(raw.effectiveGasPrice);
    return {
      id: `receipt-${attempt.executionId}`, executionId: attempt.executionId, runId: attempt.runId, transactionAttemptId: attempt.id,
      state: raw.status === '0x1' ? 'Confirmed' : 'Failed', finalityStage: 'ethereum_final', finalitySource: 'anvil-fork',
      blockNumber: BigInt(raw.blockNumber), blockHash: raw.blockHash, gasUsed, effectiveGasPrice,
      actualSpendWei: gasUsed * effectiveGasPrice + (raw.status === '0x1' ? this.mintValue : 0n), observedAt: new Date().toISOString(),
    };
  }
}

interface Harness { directory: string; dbPath: string; db: SqliteDatabase; store: CanonicalStoreBridge; engine: ForkEngine; coordinator: ExecutionCoordinator }

// Runs only under the strict fork launcher, which sets MINT_BOT_FORK_REPLAY and a loopback Anvil URL.
const ready = process.env.MINT_BOT_FORK_REPLAY === 'true' && !!nft && !!feeRecipient && mintValueEnv !== undefined && isLoopback(rpcUrl);

describe.skipIf(!ready)('Runtime guardrail harness on an Ethereum Anvil fork', () => {
  const mintValue = BigInt(mintValueEnv ?? '0');
  const paid = mintValue > 0n;
  const exposure = mintValue + FEE; // reservation per wallet: mint * quantity(1) + fee budget; admission buffers are zero
  let wallets: string[] = [];
  let h: Harness;
  let campaignCounter = 0;

  beforeEach(async () => {
    expect(await rpc<string>('eth_chainId')).toBe('0x1');
    wallets = await eoaAccounts();
    expect(wallets.length).toBeGreaterThanOrEqual(2);
    const directory = await mkdtemp(join(tmpdir(), 'mint-guardrail-'));
    const dbPath = join(directory, 'state.sqlite');
    const db = openDatabase(dbPath);
    seedChain(db);
    const store = new CanonicalStoreBridge(db, { now: () => new Date(NOW) });
    await store.open();
    const engine = new ForkEngine(() => h.store, mintValue);
    h = { directory, dbPath, db, store, engine, coordinator: new ExecutionCoordinator(store, engine) };
    await store.transaction((state) => { state.runtime = readyRuntime(); });
  });

  afterEach(async () => {
    await rpc('evm_setAutomine', [true]);
    h.store.close();
    await rm(h.directory, { recursive: true, force: true });
  });

  function seedChain(db: SqliteDatabase): void {
    const evidence = JSON.stringify({ seaDropCompatible: true, positiveLivePath: true, archiveForkPassed: true, reconciliationPassed: true, finalityPassed: true, endpointIdentity: 'ETH_FEED_REFERENCE', sourceBlock: 1, sourceBlockHash: '0xblock', expiresAt: '2099-01-01T00:00:00.000Z', acceptedAt: NOW, acceptedBy: 'guardrail-harness', approvalProof: 'harness-proof', strategyVersion: 'seadrop-v1-public@1' });
    db.prepare('INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('profile-1', 1, 'Ethereum', '[]', 2, NOW);
    db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('verification-1', 'profile-1', 'verified', 1, null, 'ETH_ARCHIVE_REFERENCE', 'ETH_FEED_REFERENCE', evidence, NOW, 'guardrail-harness', NOW);
    db.prepare('UPDATE chain_profile SET execution_enabled = 1, verification_status = ?, verification_evidence_json = ?, verification_approved_by = ?, verification_approved_at = ? WHERE id = ?').run('verified', evidence, 'guardrail-harness', NOW, 'profile-1');
    db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('fee-1', 'profile-1', 'harness-1', 'ordering', FEE.toString(), FEE.toString(), '20', 2, paid ? 1 : 0, 1, NOW, 'allowed');
  }

  function readyRuntime() {
    const custody = { provider: 'turnkey' as const, providerIdentity: 'harness-org', policyReference: 'turnkey-harness-policy', policyDigest: `0x${'1'.repeat(64)}`, policyStatus: 'approved' as const, healthStatus: 'healthy' as const, attestationStatus: 'verified' as const, evidenceId: 'custody-evidence-harness', observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' };
    return { startupState: 'Ready' as const, blockingReasons: [], dependencies: { engine: true, chain: true, backup: true, notifications: true }, operational: { secretStoreReference: 'HARNESS', storePath: 'state.sqlite', signerReady: true, custody, killSwitchEngaged: false, notificationReady: true, chainVerification: 'verified' as const, lastReconciliationAt: NOW, observedAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z' } };
  }

  // Creates a campaign with the given caps, links the wallets, records per-wallet simulations, and arms a live run.
  async function armLive(caps: { maxRunWei: bigint; dailyCapWei: bigint }, runWallets: readonly string[], store = h.store, coordinator = h.coordinator): Promise<RunRecord> {
    campaignCounter += 1;
    const id = `guardrail-campaign-${campaignCounter}`;
    const feePolicy = paid
      ? { kind: 'paid' as const, configuredPriorityFeeWei: 20n, l2ExecutionGasBudgetWei: FEE - 20n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: FEE }
      : { kind: 'free' as const, configuredPriorityFeeWei: 20n, freeTotalSpendCapWei: FEE, l2ExecutionGasBudgetWei: FEE - 20n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: FEE };
    const campaign: Campaign = { id, state: 'Draft', chainId: 1, contract: SEADROP, strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, spendPolicy: { maxRunWei: caps.maxRunWei, dailyCapWei: caps.dailyCapWei, gasCeilingWei: FEE }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, evidenceId: 'verification-1', checkedAt: NOW, sourceBlock: 1n, endpointReference: 'ETH_FEED_REFERENCE' }, mintPriceWei: mintValue, feePolicy, broadcastMode: 'public', createdAt: NOW, updatedAt: NOW };
    await store.transaction((state) => { state.campaigns.push(campaign); });
    for (const wallet of runWallets) {
      const walletId = `wallet-${wallet.toLowerCase()}`;
      h.db.prepare('INSERT OR IGNORE INTO wallet (id, chain_profile_id, address, key_reference, created_at) VALUES (?, ?, ?, ?, ?)').run(walletId, 'profile-1', wallet, `harness-key-${walletId}`, NOW);
      h.db.prepare('INSERT OR IGNORE INTO campaign_wallet (campaign_id, wallet_id, enabled, selected_at) VALUES (?, ?, 1, ?)').run(id, walletId, NOW);
    }
    const persisted = store.snapshot().campaigns.find((item) => item.id === id);
    if (!persisted) throw new Error('CAMPAIGN_NOT_PERSISTED');
    const simulationIds = runWallets.map((wallet) => `simulation-${id}-${wallet.toLowerCase()}`);
    await store.transaction((state) => {
      const checkedAt = new Date().toISOString();
      runWallets.forEach((wallet, index) => state.simulations.push({ id: simulationIds[index]!, campaignId: id, wallet, inputDigest: campaignInputDigest(persisted), success: true, sourceBlock: 1n, sourceBlockHash: '0xblock', checkedAt, expiresAt: new Date(Date.now() + 600_000).toISOString(), worstCaseFeeWei: FEE }));
    });
    return coordinator.arm({ campaign: persisted, wallets: [...runWallets], simulationIds, evidenceAt: NOW }, 'live');
  }

  function reservations(runId: string): Array<{ status: string; amount: bigint; settled: bigint | null }> {
    const rows = h.db.prepare('SELECT r.status, COALESCE(r.reserved_amount_wei, r.amount_wei) AS amount, r.settled_amount_wei AS settled FROM spend_reservation r JOIN execution e ON e.id = r.execution_id WHERE e.run_id = ? ORDER BY r.id').all(runId) as Array<{ status: string; amount: string; settled: string | null }>;
    return rows.map((row) => ({ status: row.status, amount: BigInt(row.amount), settled: row.settled === null ? null : BigInt(row.settled) }));
  }

  function walletExposure(wallet: string): bigint {
    const row = h.db.prepare("SELECT COALESCE(SUM(CAST(COALESCE(reserved_amount_wei, amount_wei) AS INTEGER)), 0) AS total FROM spend_reservation WHERE wallet_id = ? AND usage_date = ? AND status IN ('reserved', 'settled')").get(`wallet-${wallet.toLowerCase()}`, NOW.slice(0, 10)) as { total: number | bigint };
    return BigInt(row.total);
  }

  it('S1: rejects a run whose total exposure exceeds the per-run cap by 1 wei, before any broadcast', async () => {
    const [a, b] = wallets as [string, string];
    const run = await armLive({ maxRunWei: 2n * exposure - 1n, dailyCapWei: 10n * exposure }, [a, b]);
    const before = await Promise.all([nonceOf(a), nonceOf(b)]);
    await expect(h.coordinator.execute(run.id, [a, b])).rejects.toThrow(/^SPEND_CAP_EXCEEDED$/);
    expect(h.engine.executeCalls).toBe(0);
    expect(reservations(run.id)).toEqual([]);
    expect(await Promise.all([nonceOf(a), nonceOf(b)])).toEqual(before);
  });

  it('S2: rejects a second run that exceeds the per-wallet daily cap by 1 wei, before any broadcast', async () => {
    const a = wallets[0]!;
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await h.coordinator.execute(first.id, [a]);
    expect(reservations(first.id).map((item) => item.status)).toEqual(['settled']);
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    const nonceBefore = await nonceOf(a);
    await expect(h.coordinator.execute(second.id, [a])).rejects.toThrow('DAILY_SPEND_CAP_EXCEEDED');
    expect(h.engine.executeCalls).toBe(1);
    expect(reservations(second.id)).toEqual([]);
    expect(await nonceOf(a)).toBe(nonceBefore);
  });

  it('S3: admits a run exactly at the caps and settles the real on-chain spend within the reservation', async () => {
    const a = wallets[0]!;
    const run = await armLive({ maxRunWei: exposure, dailyCapWei: exposure }, [a]);
    const balanceBefore = await balanceOf(a);
    await h.coordinator.execute(run.id, [a]);
    const spent = balanceBefore - await balanceOf(a);
    expect(h.store.snapshot().receipts.filter((item) => item.runId === run.id).map((item) => item.state)).toEqual(['Confirmed']);
    const [reservation] = reservations(run.id);
    expect(reservation?.status).toBe('settled');
    expect(reservation?.amount).toBe(exposure);
    expect(reservation?.settled).toBe(spent);
    expect(spent).toBeGreaterThan(0n);
    expect(spent).toBeLessThanOrEqual(exposure);
    expect(walletExposure(a)).toBe(exposure);
  });

  it('S4: counts a pending (unmined) submission toward the daily cap, then settles it after mining', async () => {
    const a = wallets[0]!;
    await rpc('evm_setAutomine', [false]);
    h.engine.mode = 'pending';
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await h.coordinator.execute(first.id, [a]);
    expect(reservations(first.id).map((item) => item.status)).toEqual(['reserved']);
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await expect(h.coordinator.execute(second.id, [a])).rejects.toThrow('DAILY_SPEND_CAP_EXCEEDED');
    expect(h.engine.executeCalls).toBe(1);
    await rpc('evm_mine');
    await rpc('evm_setAutomine', [true]);
    await h.coordinator.reconcile();
    const [settled] = reservations(first.id);
    expect(settled?.status).toBe('settled');
    expect(settled?.settled).toBeLessThanOrEqual(exposure);
  });

  it('S5: keeps an ambiguous submission (mined but unobserved) reserved and counted toward the cap', async () => {
    const a = wallets[0]!;
    h.engine.mode = 'unobserved';
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await h.coordinator.execute(first.id, [a]);
    expect(reservations(first.id).map((item) => item.status)).toEqual(['reserved']);
    expect(walletExposure(a)).toBe(exposure);
    h.engine.mode = 'observe';
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await expect(h.coordinator.execute(second.id, [a])).rejects.toThrow('DAILY_SPEND_CAP_EXCEEDED');
    expect(h.engine.executeCalls).toBe(1);
  });

  it('S5b: keeps exposure reserved when the engine fails after broadcast (transport timeout)', async () => {
    const a = wallets[0]!;
    h.engine.mode = 'throws';
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await expect(h.coordinator.execute(first.id, [a])).rejects.toThrow('ENGINE_TRANSPORT_TIMEOUT');
    expect(reservations(first.id).map((item) => item.status)).toEqual(['reserved']);
    expect(walletExposure(a)).toBe(exposure);
    h.engine.mode = 'observe';
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    await expect(h.coordinator.execute(second.id, [a])).rejects.toThrow(/^DAILY_SPEND_CAP_EXCEEDED$/);
    expect(h.engine.executeCalls).toBe(1);
  });

  // S6a/S6b run in one Node process, where admissions execute sequentially; they prove cross-connection
  // cap accounting, not safety under truly parallel writers (tracked in Docs/Live/checklist.md).
  it('S6a: concurrent admissions on one store cannot jointly exceed the daily cap', async () => {
    const a = wallets[0]!;
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    const nonceBefore = await nonceOf(a);
    const results = await Promise.allSettled([h.coordinator.execute(first.id, [a]), h.coordinator.execute(second.id, [a])]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(String(rejected?.reason)).toContain('DAILY_SPEND_CAP_EXCEEDED');
    expect(walletExposure(a)).toBeLessThanOrEqual(2n * exposure - 1n);
    expect(await nonceOf(a)).toBe(nonceBefore + 1n);
  });

  it('S6b: admissions from two connections to the same database cannot jointly exceed the daily cap', async () => {
    const a = wallets[0]!;
    const first = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    const second = await armLive({ maxRunWei: exposure, dailyCapWei: 2n * exposure - 1n }, [a]);
    const otherStore = new CanonicalStoreBridge(openDatabase(h.dbPath), { now: () => new Date(NOW) });
    await otherStore.open();
    try {
      const otherCoordinator = new ExecutionCoordinator(otherStore, h.engine);
      const nonceBefore = await nonceOf(a);
      const results = await Promise.allSettled([h.coordinator.execute(first.id, [a]), otherCoordinator.execute(second.id, [a])]);
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult | undefined;
      expect(String(rejected?.reason)).toContain('DAILY_SPEND_CAP_EXCEEDED');
      expect(walletExposure(a)).toBeLessThanOrEqual(2n * exposure - 1n);
      expect(await nonceOf(a)).toBe(nonceBefore + 1n);
    } finally {
      otherStore.close();
    }
  });
});
