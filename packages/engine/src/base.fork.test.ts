import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { getChainConfig, SEADROP_V1_ADDRESS } from './chains.js';

type Rpc = (method: string, params?: unknown[]) => Promise<any>;
let fork: Rpc;
let setupError: Error | undefined;
const enabled = process.env.MINT_BOT_FORK_REPLAY === 'true';
const rpcUrl = process.env.ANVIL_BASE_RPC_URL;
const blockText = process.env.BASE_FORK_BLOCK;
const txHash = process.env.BASE_SEADROP_TX_HASH;
const nft = process.env.BASE_SEADROP_NFT;
const feeRecipient = process.env.BASE_SEADROP_FEE_RECIPIENT;
const mintValue = process.env.BASE_SEADROP_MINT_VALUE_WEI;
const quantityText = process.env.BASE_SEADROP_QUANTITY;
const mintPublicAbi = [{ type: 'function', name: 'mintPublic', stateMutability: 'payable', inputs: [
  { name: 'nftContract', type: 'address' }, { name: 'feeRecipient', type: 'address' },
  { name: 'minterIfNotPayer', type: 'address' }, { name: 'quantity', type: 'uint256' },
], outputs: [] }] as const;

async function makeRpc(url: string): Promise<Rpc> {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? `RPC error: ${method}`);
    return body.result;
  };
}

function requireSetup(): void { if (setupError) throw new Error(`Archive-backed Base fork unavailable: ${setupError.message}`); }

async function accounts(): Promise<string[]> {
  const values = await fork('eth_accounts') as string[];
  const code = await Promise.all(values.map((address) => fork('eth_getCode', [address, 'latest'])));
  return values.filter((_, index) => code[index] === '0x');
}

describe.skipIf(!enabled || !rpcUrl || !blockText || !txHash || !nft || !feeRecipient || !mintValue || !quantityText)('Base archive-backed fork replay', () => {
  beforeAll(async () => {
    try {
      const parsed = new URL(rpcUrl!);
      if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.port !== '8547') throw new Error('ANVIL_BASE_RPC_URL must target loopback port 8547');
      if (!/^\d+$/.test(blockText!) || !/^\d+$/.test(mintValue!) || !/^\d+$/.test(quantityText!)) throw new Error('Base numeric fixtures are invalid');
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash!) || !/^0x[0-9a-fA-F]{40}$/.test(nft!) || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient!)) throw new Error('Base fixture identity is invalid');
      fork = await makeRpc(rpcUrl!);
      if (!String(await fork('web3_clientVersion')).toLowerCase().includes('anvil')) throw new Error('Local Base endpoint is not Anvil');
      if (await fork('eth_chainId') !== '0x2105') throw new Error('Fork chain mismatch: expected 8453');
    } catch (error) { setupError = error instanceof Error ? error : new Error('fork setup failed'); }
  });

  it('replays the successful public SeaDrop transaction and receipt', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [txHash]);
    const receipt = await fork('eth_getTransactionReceipt', [txHash]);
    expect(receipt?.status).toBe('0x1');
    expect(BigInt(receipt?.blockNumber)).toBe(BigInt(blockText!));
    expect(tx?.to.toLowerCase()).toBe(SEADROP_V1_ADDRESS.toLowerCase());
    expect(BigInt(tx?.value)).toBe(BigInt(mintValue!));
    const decoded = decodeFunctionData({ abi: mintPublicAbi, data: tx.input as Hex });
    expect(decoded.functionName).toBe('mintPublic');
    expect(decoded.args[0].toLowerCase()).toBe(nft?.toLowerCase());
    expect(decoded.args[1].toLowerCase()).toBe(feeRecipient?.toLowerCase());
    expect(decoded.args[3]).toBe(BigInt(quantityText!));
  });

  it('rejects an invalid mint value without writing state', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [txHash]);
    await expect(fork('eth_call', [{ from: tx.from, to: tx.to, data: tx.input, value: `0x${(BigInt(tx.value) - 1n).toString(16)}` }, tx.blockNumber])).rejects.toThrow();
  });

  it('rejects replaying the already-consumed wallet allocation', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [txHash]);
    await expect(fork('eth_call', [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, 'latest'])).rejects.toThrow();
  });

  it('records one winner for a same-nonce replacement', async () => {
    requireSetup();
    const from = (await accounts())[0]!;
    await fork('evm_setAutomine', [false]);
    try {
      const nonce = await fork('eth_getTransactionCount', [from, 'pending']);
      const first = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x3b9aca00', nonce }]);
      const replacement = await fork('eth_sendTransaction', [{ from, to: from, value: '0x0', gas: '0x5208', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x77359400', nonce }]);
      await fork('anvil_mine', ['0x1']);
      const receipts = await Promise.all([fork('eth_getTransactionReceipt', [first]), fork('eth_getTransactionReceipt', [replacement])]);
      expect(receipts.filter(Boolean)).toHaveLength(1);
    } finally { await fork('evm_setAutomine', [true]); }
  });

  it('observes receipt disappearance after a local reorg', async () => {
    requireSetup();
    const from = (await accounts())[0]!;
    const snapshot = await fork('evm_snapshot');
    const hash = await fork('eth_sendTransaction', [{ from, to: '0x000000000000000000000000000000000000dEaD', value: '0x0', gas: '0x5208', gasPrice: await fork('eth_gasPrice') }]);
    await fork('evm_mine');
    expect((await fork('eth_getTransactionReceipt', [hash]))?.status).toBe('0x1');
    await fork('evm_revert', [snapshot]);
    expect(await fork('eth_getTransactionReceipt', [hash])).toBeNull();
  });

  it('anchors staged finality without treating the fork as L1-final proof', async () => {
    requireSetup();
    const receipt = await fork('eth_getTransactionReceipt', [txHash]);
    expect((await fork('eth_getBlockByNumber', [receipt.blockNumber, false]))?.hash).toBeDefined();
    const config = getChainConfig(8453);
    expect(config.finalityPolicy.stages).toEqual(['soft', 'posted', 'ethereum_final']);
    expect(config.verificationStatus).toBe('unverified');
    expect(config.executionEnabled).toBe(false);
  });
});

