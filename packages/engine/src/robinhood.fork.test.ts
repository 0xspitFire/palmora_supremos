import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { ROBINHOOD_SEADROP_POSITIVE_FIXTURE } from './robinhood-evidence.js';
import { getChainConfig } from './chains.js';

/**
 * Real archive-backed Robinhood replay suite. The fork endpoint must be an
 * Anvil instance started from the approved archive reference. This suite uses
 * only unlocked local Anvil accounts for local zero-value replacement/reorg
 * mechanics; it never signs or broadcasts to Robinhood itself.
 */

type Rpc = (method: string, params?: unknown[]) => Promise<any>;
let fork: Rpc;
let setupError: Error | undefined;
const replayEnabled = process.env.MINT_BOT_FORK_REPLAY === 'true';
const rpcUrl = process.env.ANVIL_ROBINHOOD_RPC_URL ?? process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const forkBlockText = process.env.ROBINHOOD_FORK_BLOCK;
const nft = process.env.ROBINHOOD_SEADROP_NFT;
const feeRecipient = process.env.ROBINHOOD_SEADROP_FEE_RECIPIENT;
const mintValueWei = process.env.ROBINHOOD_SEADROP_MINT_VALUE_WEI;
const mintSignedAbi = [{
  type: 'function',
  name: 'mintSigned',
  stateMutability: 'payable',
  inputs: [
    { name: 'nftContract', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'minterIfNotPayer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
    {
      name: 'mintParams',
      type: 'tuple',
      components: [
        { name: 'mintPrice', type: 'uint256' },
        { name: 'maxTotalMintableByWallet', type: 'uint256' },
        { name: 'startTime', type: 'uint256' },
        { name: 'endTime', type: 'uint256' },
        { name: 'dropStageIndex', type: 'uint256' },
        { name: 'maxTotalMintableByWalletPerStage', type: 'uint256' },
        { name: 'feeBps', type: 'uint256' },
        { name: 'restrictFeeRecipients', type: 'bool' },
      ],
    },
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
  outputs: [],
}] as const;

async function localEoaAccounts(): Promise<string[]> {
  const accounts = await fork('eth_accounts') as string[];
  const code = await Promise.all(accounts.map((account) => fork('eth_getCode', [account, 'latest'])));
  return accounts.filter((_, index) => code[index] === '0x');
}

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

function requireSetup(): void {
  if (setupError) throw new Error(`Archive-backed Robinhood fork unavailable: ${setupError.message}`);
}

describe.skipIf(!replayEnabled || !forkBlockText || !nft || !feeRecipient || !mintValueWei)('Robinhood archive-backed fork replay', () => {
  beforeAll(async () => {
    try {
      const parsedUrl = new URL(rpcUrl);
      if (parsedUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) {
        throw new Error('ANVIL_ROBINHOOD_RPC_URL must target loopback Anvil');
      }
      if (!/^\d+$/.test(forkBlockText!)) throw new Error('ROBINHOOD_FORK_BLOCK must be a decimal block number');
      if (!/^0x[0-9a-fA-F]{40}$/.test(nft!) || !/^0x[0-9a-fA-F]{40}$/.test(feeRecipient!)) throw new Error('Robinhood NFT and fee-recipient inputs must be addresses');
      if (!/^\d+$/.test(mintValueWei!)) throw new Error('ROBINHOOD_SEADROP_MINT_VALUE_WEI must be an integer');
      if (BigInt(forkBlockText!) < ROBINHOOD_SEADROP_POSITIVE_FIXTURE.blockNumber) throw new Error('ROBINHOOD_FORK_BLOCK must include the approved positive fixture');
      fork = await makeRpc(rpcUrl);
      let client: string;
      try {
        client = await fork('web3_clientVersion') as string;
      } catch {
        throw new Error('Anvil fork endpoint unreachable');
      }
      if (!client.toLowerCase().includes('anvil')) throw new Error('Local Robinhood endpoint is not Anvil');
      const chainId = await fork('eth_chainId');
      if (chainId !== '0x1237') throw new Error('Fork chain mismatch: expected 4663');
    } catch (error) {
      setupError = error instanceof Error ? error : new Error('fork setup failed');
    }
  });

  it('replays the historical positive SeaDrop transaction and receipt', async () => {
    requireSetup();
    const historicalBlock = `0x${ROBINHOOD_SEADROP_POSITIVE_FIXTURE.blockNumber.toString(16)}`;
    const block = await fork('eth_getBlockByNumber', [historicalBlock, false]);
    expect(block).not.toBeNull();
    const receipt = await fork('eth_getTransactionReceipt', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(receipt?.status).toBe('0x1');
    expect(receipt?.transactionHash.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash.toLowerCase());
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    expect(BigInt(tx?.value)).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.mintAmountWei);
    expect(typeof tx?.input).toBe('string');
    expect(tx?.input.length).toBeGreaterThan(10);
    expect(nft?.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.nftContract.toLowerCase());
    expect(BigInt(mintValueWei!)).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.mintAmountWei);
    const decoded = decodeFunctionData({ abi: mintSignedAbi, data: tx.input as Hex });
    expect(decoded.functionName).toBe('mintSigned');
    expect(decoded.args?.[0].toLowerCase()).toBe(nft?.toLowerCase());
    expect(decoded.args?.[1].toLowerCase()).toBe(feeRecipient?.toLowerCase());
    expect(decoded.args?.[3]).toBe(1n);
    expect(decoded.args?.[6]).toMatch(/^0x[0-9a-fA-F]+$/);
    expect((decoded.args?.[6] as string).length).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.signatureHexLength);
    expect(receipt?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(receipt?.blockNumber).toBe(historicalBlock);
  });

  it('replays a failed signed-mint call with an invalid value without writing state', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.from.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.wallet.toLowerCase());
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    expect(tx?.input.length).toBeGreaterThan(10);
    await expect(fork('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: '0x1',
    }, tx.blockNumber])).rejects.toThrow();
  });

  it('replays duplicate submission semantics as a failed call after the positive mint', async () => {
    requireSetup();
    const tx = await fork('eth_getTransactionByHash', [ROBINHOOD_SEADROP_POSITIVE_FIXTURE.txHash]);
    expect(tx).not.toBeNull();
    expect(tx?.chainId).toBe('0x1237');
    expect(tx?.to.toLowerCase()).toBe(ROBINHOOD_SEADROP_POSITIVE_FIXTURE.seaDropAddress.toLowerCase());
    await expect(fork('eth_call', [{
      from: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
    }, 'latest'])).rejects.toThrow();
  });

  it('records a replacement outcome using local Anvil accounts only', async () => {
    requireSetup();
    const accounts = await localEoaAccounts();
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
    const accounts = await localEoaAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    const from = accounts[0];
    const snapshot = await fork('evm_snapshot');
    const gasPrice = await fork('eth_gasPrice');
    // Use a plain recipient. Forked Anvil accounts may carry EIP-7702 code;
    // sending to that account as the recipient would execute delegated code
    // and turn this neutral reorg probe into an unrelated contract revert.
    const recipient = '0x000000000000000000000000000000000000dEaD';
    const hash = await fork('eth_sendTransaction', [{ from, to: recipient, value: '0x0', gas: '0x5208', gasPrice }]);
    // The approved Anvil invocation may run with automine disabled; explicitly
    // mine so the test proves receipt disappearance rather than pending state.
    await fork('evm_mine');
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
    const policy = getChainConfig(4663).finalityPolicy;
    expect(policy.stages).toEqual(['soft', 'posted', 'ethereum_final']);
  });
});
