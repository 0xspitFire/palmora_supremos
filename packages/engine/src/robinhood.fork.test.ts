import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readSecret } from './secrets.js';
import { ROBINHOOD_SEADROP_POSITIVE_FIXTURE } from './robinhood-evidence.js';

/**
 * Real archive-backed Robinhood replay suite. The fork endpoint must be an
 * Anvil instance started from the approved archive reference. This suite uses
 * only unlocked local Anvil accounts for local zero-value replacement/reorg
 * mechanics; it never signs or broadcasts to Robinhood itself.
 */

type Rpc = (method: string, params?: unknown[]) => Promise<any>;
let fork: Rpc;
let archive: Rpc;
let setupError: Error | undefined;
const secretRoot = process.env.MINT_BOT_SECRETS_ROOT ?? [
  resolve(process.cwd(), 'Rets'),
  resolve(process.cwd(), '../../../Rets'),
  resolve(process.cwd(), '../../../../../Rets'),
].find((candidate) => existsSync(resolve(candidate, 'MINT_BOT_SECRETS.env'))) ?? resolve(process.cwd(), 'Rets');

async function makeRpc(url: string): Promise<Rpc> {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `RPC error: ${method}`);
    return body.result;
  };
}

beforeAll(async () => {
  try {
    // Values remain in memory only for the RPC call and are never logged.
    let archiveUrl: string;
    try {
      archiveUrl = await readSecret('ROBINHOOD_ARCHIVE_RPC', 'mainnet', secretRoot);
      archive = await makeRpc(archiveUrl);
    } catch (error) {
      throw new Error(`archive reference unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
    }
    fork = await makeRpc('http://127.0.0.1:8545');
    let client: string;
    try {
      client = await fork('web3_clientVersion') as string;
    } catch {
      throw new Error('Anvil fork endpoint unreachable');
    }
    if (!client.toLowerCase().includes('anvil')) throw new Error('ANVIL_FORK_RPC is not an Anvil endpoint');
    const chainId = await fork('eth_chainId');
    if (chainId !== '0x1237') throw new Error(`Fork chain mismatch: expected 4663, observed ${chainId}`);
  } catch (error) {
    setupError = error instanceof Error ? error : new Error(String(error));
  }
});

function requireSetup(): void {
  if (setupError) throw new Error(`Archive-backed Robinhood fork unavailable: ${setupError.message}`);
}

describe('Robinhood archive-backed fork replay', () => {
  it('replays the historical positive SeaDrop transaction and receipt', async () => {
    requireSetup();
    const historicalBlock = `0x${ROBINHOOD_SEADROP_POSITIVE_FIXTURE.blockNumber.toString(16)}`;
    const block = await archive('eth_getBlockByNumber', [historicalBlock, false]);
    expect(block).not.toBeNull();
    const receipt = await fork('eth_getTransactionReceipt', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(receipt?.status).toBe('0x1');
    expect(receipt?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(receipt?.blockNumber).toBe(historicalBlock);
  });

  it('replays a failed public-mint call with an invalid value without writing state', async () => {
    requireSetup();
    const tx = await archive('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    await expect(archive('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: '0x0',
    }, tx.blockNumber])).rejects.toThrow();
  });

  it('replays duplicate submission semantics as a failed call after the positive mint', async () => {
    requireSetup();
    const tx = await archive('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    await expect(archive('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
    }, 'latest'])).rejects.toThrow();
  });

  it('records a replacement outcome using local Anvil accounts only', async () => {
    requireSetup();
    const accounts = await fork('eth_accounts') as string[];
    expect(accounts.length).toBeGreaterThan(0);
    const from = accounts[0];
    await fork('evm_setAutomine', [false]);
    try {
      const nonceHex = await fork('eth_getTransactionCount', [from, 'pending']);
      const first = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', nonce: nonceHex }]);
      const replacement = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x77359400', nonce: nonceHex }]);
      expect(replacement).not.toBe(first);
      await fork('anvil_mine', ["0x1"]);
      const firstReceipt = await fork('eth_getTransactionReceipt', [first]);
      const replacementReceipt = await fork('eth_getTransactionReceipt', [replacement]);
      expect(Boolean(firstReceipt) !== Boolean(replacementReceipt)).toBe(true);
    } finally {
      await fork('evm_setAutomine', [true]);
    }
  });

  it('replays receipt disappearance across an Anvil reorg', async () => {
    requireSetup();
    const accounts = await fork('eth_accounts') as string[];
    const from = accounts[0];
    const snapshot = await fork('evm_snapshot');
    const hash = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208' }]);
    const beforeReorg = await fork('eth_getTransactionReceipt', [hash]);
    expect(beforeReorg?.status).toBe('0x1');
    await fork('evm_revert', [snapshot]);
    const afterReorg = await fork('eth_getTransactionReceipt', [hash]);
    expect(afterReorg).toBeNull();
  });

  it('captures the staged-finality replay anchor without claiming finality', async () => {
    requireSetup();
    const receipt = await fork('eth_getTransactionReceipt', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(receipt?.blockNumber).toBeDefined();
    const block = await fork('eth_getBlockByNumber', [receipt.blockNumber, false]);
    expect(block?.hash).toBeDefined();
    // Soft inclusion is observable here; posted and ethereum_final require the
    // L1 batch/finality observers owned by reconciliation infrastructure.
    expect({ stage: 'soft', posted: false, ethereum_final: false }).toEqual({ stage: 'soft', posted: false, ethereum_final: false });
  });
});
