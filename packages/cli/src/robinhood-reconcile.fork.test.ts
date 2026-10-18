import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type Hash, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RobinhoodFinalityObserver, SEADROP_V1_ADDRESS, SeaDropV1PublicStrategy } from '@mint-bot/engine';
import { DurableStore, ExecutionCoordinator, type AttemptRecord, type BackendState, type EngineAdapter, type RunRecord } from '@mint-bot/backend';
import { createNitroFinalitySources } from './robinhood-readonly.js';
import { parseGasUsedForL1, reconcileRobinhood, type ObservedFinality, type ObservedReceipt } from './robinhood-reconcile.js';

/**
 * T-035 piece 3: free-mint rehearsal of the Robinhood reconcile on a local Anvil fork of chain 4663.
 *
 * A fresh wallet that exists only on the fork mints one FREE public SeaDrop NFT. The real receipt is then reconciled with
 * `reconcileRobinhood` and the real `ExecutionCoordinator`, and the settled amount is compared with the wallet's real balance change.
 * Limits, stated plainly: a fork has no Ethereum L1 behind it, so the "posted" and "Ethereum-final" stages are supplied by a
 * stub observer (the real Nitro sources are also run and must NOT report final), and Anvil does not return `gasUsedForL1`, so the
 * final-stage cases inject that one field (the live value was checked against the public RPC on 2026-10-17: `0x1e9` hex string).
 *
 * Runs only through `pnpm ops:robinhood-rehearsal --nft 0x<open FREE drop>`, which sets:
 *   ANVIL_REHEARSAL_RPC_URL (loopback), REHEARSAL_CHAIN=robinhood, REHEARSAL_NFT.
 */
const rpcUrl = process.env.ANVIL_REHEARSAL_RPC_URL;
const nft = process.env.REHEARSAL_NFT as Address | undefined;
const isLoopback = (url: string | undefined): boolean => {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname); } catch { return false; }
};
const enabled = isLoopback(rpcUrl) && process.env.REHEARSAL_CHAIN === 'robinhood' && Boolean(nft);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `RPC_${method}_FAILED`);
  return body.result;
}

describe.skipIf(!enabled)('Robinhood reconcile on a fork (free mint, T-035 piece 3)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const NOW = '2026-10-17T00:00:00.000Z';
  let client: ReturnType<typeof createPublicClient>;
  let txHash: Hash;
  let balanceDelta: bigint;
  let attempt: AttemptRecord;
  const run: RunRecord = { id: 'run1', intentId: 'int1', campaignId: 'c1', mode: 'live', requestDigest: 'd', state: 'Active', createdAt: NOW, updatedAt: NOW };

  beforeAll(async () => {
    client = createPublicClient({ transport: http(rpcUrl!) });
    expect(await client.getChainId()).toBe(4663);
    await rpc('anvil_setBalance', [account.address, '0x56BC75E2D63100000']);
    await rpc('anvil_setNextBlockBaseFeePerGas', ['0x2faf080']);
    await rpc('evm_mine');
    const strategy = new SeaDropV1PublicStrategy();
    const drop = await strategy.readDrop(client as never, nft!, 4663);
    expect(drop.mintPrice, 'the rehearsal drop must be free').toBe(0n);
    const data = strategy.buildCalldata(drop, account.address, 1);
    const before = await client.getBalance({ address: account.address });
    const signed = await account.signTransaction({ type: 'eip1559', chainId: 4663, to: SEADROP_V1_ADDRESS, value: 0n, data, nonce: 0, gas: 600_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n });
    txHash = (await rpc('eth_sendRawTransaction', [signed as Hex])) as Hash;
    await rpc('evm_mine');
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe('success');
    balanceDelta = before - (await client.getBalance({ address: account.address }));
    expect(balanceDelta).toBe(receipt.gasUsed * receipt.effectiveGasPrice); // a free mint costs gas only
    attempt = { id: 'att1', executionId: 'exe1', runId: 'run1', wallet: account.address, nonce: 0, hash: txHash, state: 'Submitted', createdAt: NOW, updatedAt: NOW };
  }, 90_000);

  afterAll(() => undefined);

  const readReceipt = (injectL1: boolean) => async (hash: string): Promise<ObservedReceipt> => {
    const receipt = await client.getTransactionReceipt({ hash: hash as Hash });
    const raw = (receipt as unknown as { gasUsedForL1?: unknown }).gasUsedForL1;
    return { status: receipt.status === 'success' ? 'success' : 'reverted', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasUsedForL1: parseGasUsedForL1(injectL1 ? '0x1e9' : raw) };
  };
  const reconcile = (observe: (input: { txHash: string; txBlockNumber: bigint }) => Promise<ObservedFinality>, injectL1: boolean) =>
    reconcileRobinhood({ run, attempts: [attempt], mintPriceWei: 0n, quantity: 1, readReceipt: readReceipt(injectL1), observe });
  const stage = (value: ObservedFinality) => async () => value;

  it('the real Nitro sources never report Ethereum-final on a fork (there is no L1), so nothing settles', async () => {
    const observer = new RobinhoodFinalityObserver(createNitroFinalitySources(client as never), 1);
    const update = await reconcile(async (input) => {
      const observation = await observer.observe({ txHash: input.txHash as Hash, txBlockNumber: input.txBlockNumber });
      return { stage: observation.stage === 'ethereum_final' || observation.stage === 'posted' ? observation.stage : 'soft', canonical: observation.canonical, ready: observation.ready };
    }, true);
    expect(['soft', 'posted', 'unknown']).toContain(update.result);
    expect(update.receipts).toHaveLength(0);
  });

  it('soft and posted settle nothing; final without the L1 gas proof settles nothing (fails closed)', async () => {
    expect((await reconcile(stage({ stage: 'soft', canonical: true, ready: false }), true)).result).toBe('soft');
    expect((await reconcile(stage({ stage: 'posted', canonical: true, ready: false }), true)).result).toBe('posted');
    const unproven = await reconcile(stage({ stage: 'ethereum_final', canonical: true, ready: true }), false);
    expect(unproven.result).toBe('unknown');
    expect(unproven.receipts).toHaveLength(0);
  });

  it('a reorg is reported as reorged', async () => {
    const update = await reconcile(stage({ stage: 'soft', canonical: false, ready: false }), true);
    expect(update.result).toBe('reorged');
    expect(update.receipts.every((item) => item.state === 'Reorged')).toBe(true);
  });

  it('final: the amount settled through the real coordinator equals the wallet\'s real balance change', async () => {
    class Store extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }
    const store = new Store();
    await store.transaction((state: BackendState) => {
      state.runs.push({ ...run });
      state.intents.push({ id: 'int1', runId: 'run1', campaignId: 'c1', campaignSnapshot: { chainId: 4663, mintPriceWei: 0n, quantity: 1 }, wallets: [account.address] } as never);
      state.attempts.push({ ...attempt });
      state.reservations.push({ id: 'res1', runId: 'run1', campaignId: 'c1', chainId: 4663, wallet: account.address, amountWei: balanceDelta * 10n, accountingDate: '2026-10-17', status: 'reserved', createdAt: NOW, updatedAt: NOW });
    });
    const adapter: EngineAdapter = {
      prepare: async () => { throw new Error('unused'); },
      execute: async () => { throw new Error('unused'); },
      reconcile: () => reconcile(stage({ stage: 'ethereum_final', canonical: true, ready: true }), true),
    };
    await new ExecutionCoordinator(store, adapter).reconcile();
    const state = store.snapshot();
    expect(state.reservations[0]).toMatchObject({ status: 'settled', actualAmountWei: balanceDelta });
    expect(state.runs[0]?.state).toBe('Completed');
  });
});
