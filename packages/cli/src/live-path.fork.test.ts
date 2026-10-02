import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, parseAbi, parseGwei, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PERSONAL_LIVE_FLEET_POLICY, PersonalLiveReadinessService, acceptEthereumChainEvidence, buildEthereumChainEvidence, ethereumChainEvidencePhrase, recordWalletSimulations, type ValidatedCampaign } from '@mint-bot/backend';
import type { Signer, TransactionIntent } from '@mint-bot/engine';
import { checkDrop } from './drop-check.js';
import { EngineIntelligencePort } from './intelligence-adapter.js';
import { assertLivePrepareAllowed, buildLivePlan, liveConfirmationPhrase, liveFreeCampaignFields } from './live-plan.js';
import { createPersonalLiveProbes } from './personal-live-cli.js';
import { createCliRuntime } from './runtime.js';

/**
 * Full rehearsal of the Personal Live path on a local Ethereum fork (T-027, D-043): plan, chain evidence, campaign,
 * simulation records, readiness, approve, arm, run, then the receipts and the ledger. Fresh wallets exist only on the
 * fork; nothing real is spent and no secret is read. The CLI glue itself (argument parsing and printing) is not
 * exercised; every gate and number it uses is.
 *
 *   ANVIL_REHEARSAL_RPC_URL  loopback RPC of an Ethereum fork (anvil --fork-url <public node> --port 8546)
 *   REHEARSAL_CHAIN          ethereum
 *   REHEARSAL_NFT            an OPEN, FREE SeaDrop public drop on that fork
 */
const rpcUrl = process.env.ANVIL_REHEARSAL_RPC_URL;
const nft = process.env.REHEARSAL_NFT as Address | undefined;
const loopback = (() => { try { const url = new URL(rpcUrl ?? ''); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; } })();
const enabled = loopback && !!nft && (process.env.REHEARSAL_CHAIN ?? 'ethereum') === 'ethereum';
const balanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `RPC_${method}_FAILED`);
  return body.result;
}

class LocalSigner implements Signer {
  constructor(private readonly accounts: ReturnType<typeof privateKeyToAccount>[]) {}
  async listWallets() { return this.accounts.map((account, index) => ({ index, address: account.address })); }
  async signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex> {
    const account = this.accounts[walletIndex]!;
    if (intent.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('WALLET_BOUNDARY_VIOLATION');
    return account.signTransaction({ type: 'eip1559', chainId: intent.chainId, to: intent.to as Hex, value: intent.value, data: intent.data as Hex, nonce: intent.nonce, gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas });
  }
  zeroize(): void { /* nothing retained beyond this test */ }
}

describe.skipIf(!enabled)('Personal Live path on a local Ethereum fork (T-027)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mintbot-live-path-'));
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const wallets = accounts.map((account) => account.address);
  let miner: ReturnType<typeof setInterval> | undefined;

  beforeAll(async () => {
    expect(await rpc('eth_chainId')).toBe('0x1');
    for (const wallet of wallets) await rpc('anvil_setBalance', [wallet, '0x16345785D8A0000']); // 0.1 ETH on the fork only
    await rpc('anvil_setNextBlockBaseFeePerGas', ['0x2faf080']); // 0.05 gwei, so a low max fee clears it on the fork
    await rpc('evm_mine');
    miner = setInterval(() => { void rpc('evm_mine').catch(() => undefined); }, 700);
  });
  afterAll(() => { if (miner) clearInterval(miner); rmSync(directory, { recursive: true, force: true }); });

  it('goes from a ready plan to settled receipts through every recorded gate', async () => {
    // A secrets folder that points the engine at the fork (loopback only), exactly as the owner's folder points it at their RPC.
    const secretRoot = join(directory, 'secrets');
    await mkdir(secretRoot, { recursive: true });
    writeFileSync(join(secretRoot, 'MINT_BOT_SECRETS.env'), `ETHEREUM_RPC_URL=${rpcUrl}\n`);
    const walletFile = join(directory, 'wallet-file.json');
    writeFileSync(walletFile, JSON.stringify({ wallets: wallets.map((address, index) => ({ index, address })) }));
    const backupStatusPath = join(directory, 'backup-status.json');
    writeFileSync(backupStatusPath, JSON.stringify({ status: 'ok', recordedAt: new Date().toISOString() }));
    const killSwitchFile = join(directory, 'killswitch');
    const statePath = join(directory, 'state.sqlite');
    const signer = new LocalSigner(accounts);
    const adapter = { walletList: () => signer.listWallets(), signerFactory: async () => signer, passphraseProvider: async () => 'rehearsal-not-a-secret', killSwitchFile, secretRoot, logFile: join(directory, 'engine.log'), maxFeePerGasGwei: 0.8, gasLimitPadding: 1.3, maxReplacementBumps: 0 };
    const runtime = await createCliRuntime(directory, undefined, statePath, adapter, { allowTurnkey: false, acceptPersonalLiveLocalCustody: true });

    // 1. The plan: drop open and free, both wallets funded, test mint passes.
    const port = EngineIntelligencePort.fromRpcUrl(rpcUrl!);
    const report = await checkDrop(port, nft!, wallets, { simulate: true });
    const plan = buildLivePlan(report, { killSwitchPresent: false, custody: 'local' });
    expect(plan.blockers).toEqual([]);
    expect(plan.verdict).toBe('ready');
    const confirm = liveConfirmationPhrase(nft!, plan.totalMaxExposureEth);

    // 2. Chain evidence, accepted by typed phrase.
    const client = createPublicClient({ transport: http(rpcUrl!) });
    const block = await client.getBlock({ blockTag: 'latest' });
    await acceptEthereumChainEvidence(runtime.store, buildEthereumChainEvidence({ now: new Date(), sourceBlock: block.number, sourceBlockHash: block.hash, strategy: 'seadrop-v1-public' }), ethereumChainEvidencePhrase(block.number));
    const evidence = runtime.store.snapshot().chainEvidence.find((item) => item.status === 'accepted')!;

    // 3. The campaign (what live-prepare records), gated by the exact phrase and the wallet file.
    const ready = assertLivePrepareAllowed({ plan, contract: nft!, confirm, priorityFeeGwei: 0.1, walletFileAddresses: wallets });
    const fields = liveFreeCampaignFields({ quantity: plan.quantity, wallets: ready.length, tipWei: parseGwei('0.1') });
    const campaign = await runtime.application.createCampaign({
      chainId: 1, contract: nft!, strategy: 'seadrop-v1-public', quantity: fields.quantity, dryRun: false, maxRunWei: fields.maxRunWei, dailyCapWei: fields.dailyCapWei, gasCeilingWei: fields.gasCeilingWei, broadcastMode: 'public',
      chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, evidenceId: evidence.id, checkedAt: evidence.checkedAt, sourceBlock: evidence.sourceBlock, endpointReference: evidence.endpointIdentity },
      mintPriceWei: fields.mintPriceWei, feePolicy: fields.feePolicy,
    });

    // 4. Simulation records and readiness (what record-simulation and live-readiness record write).
    const ids = await recordWalletSimulations(runtime.store, campaign, report.wallets.map((row) => ({ wallet: row.wallet, success: row.verdict === 'ready' })), { blockNumber: block.number, blockHash: block.hash });
    const probes = createPersonalLiveProbes({ client, walletFile, backupStatusPath, killSwitchFile, telegramHealthy: async () => true });
    const readiness = await new PersonalLiveReadinessService(runtime.store, probes).record({ wallets, confirmedBy: 'owner-cli', storePath: statePath, secretStoreReference: 'SECRET_STORE_PATH' });
    if (!readiness.recorded) throw new Error(`READINESS_NOT_RECORDED ${JSON.stringify(readiness.failures)}`);

    // 5. Approve, arm, run.
    const validated: ValidatedCampaign = { campaign, wallets, simulationIds: ids, evidenceAt: new Date().toISOString() };
    await runtime.application.command('approve', { validated });
    const armed = await runtime.application.command('arm', { validated, mode: 'live' });
    const before = await Promise.all(wallets.map((wallet) => client.readContract({ address: nft!, abi: balanceAbi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>));
    const result = await runtime.application.command('run', { runId: armed.id, wallets });
    const after = await Promise.all(wallets.map((wallet) => client.readContract({ address: nft!, abi: balanceAbi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>));

    // 6. Receipts, reservations and the ledger.
    expect(result.state).toBeTruthy();
    expect(after.map((value, index) => value - before[index]!)).toEqual(wallets.map(() => BigInt(plan.quantity)));
    const state = runtime.store.snapshot();
    const reservations = state.reservations.filter((item) => item.runId === armed.id);
    expect(reservations).toHaveLength(2);
    expect(reservations.every((item) => item.status === 'settled')).toBe(true);
    expect(reservations.every((item) => item.amountWei <= PERSONAL_LIVE_FLEET_POLICY.freeFeeAllowanceWei)).toBe(true);
    expect(state.receipts.filter((item) => item.runId === armed.id)).toHaveLength(2);
  }, 240_000);
});
