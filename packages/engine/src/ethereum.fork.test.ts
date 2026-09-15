import { describe, expect, it } from 'vitest';
import { encodeFunctionData, zeroAddress, type Address } from 'viem';

const rpcUrl = process.env.ANVIL_ETHEREUM_RPC_URL;
const nft = process.env.ETHEREUM_SEADROP_NFT as Address | undefined;
const feeRecipient = process.env.ETHEREUM_SEADROP_FEE_RECIPIENT as Address | undefined;
const mintValueWei = process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI;
const seaDrop = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as Address;
const mintPublicAbi = [{
  type: 'function',
  name: 'mintPublic',
  stateMutability: 'payable',
  inputs: [
    { name: 'nftContract', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'minterIfNotPayer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
  ],
  outputs: [],
}] as const;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  if (!rpcUrl) throw new Error('ANVIL_ETHEREUM_RPC_URL_REQUIRED');
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? `RPC_${method}_FAILED`);
  return body.result;
}

async function receipt(hash: string): Promise<{ status: string } | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await rpc('eth_getTransactionReceipt', [hash]) as { status: string } | null;
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

describe.skipIf(!rpcUrl || !nft || !feeRecipient || !mintValueWei)('Ethereum three-wallet SeaDrop fork', () => {
  it('executes the same public SeaDrop intent from three independent unlocked Anvil wallets', async () => {
    expect(await rpc('eth_chainId')).toBe('0x1');
    const accounts = await rpc('eth_accounts') as string[];
    const code = await Promise.all(accounts.map((account) => rpc('eth_getCode', [account, 'latest'])));
    const senders = accounts.filter((_, index) => code[index] === '0x');
    expect(senders.length).toBeGreaterThanOrEqual(3);
    const data = encodeFunctionData({ abi: mintPublicAbi, functionName: 'mintPublic', args: [nft!, feeRecipient!, zeroAddress, 1n] });
    const hashes = await Promise.all(senders.slice(0, 3).map((from) => rpc('eth_sendTransaction', [{
      from,
      to: seaDrop,
      value: `0x${BigInt(mintValueWei!).toString(16)}`,
      data,
    }]) as Promise<string>));
    const receipts = await Promise.all(hashes.map((hash) => receipt(hash)));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((item) => item?.status === '0x1')).toBe(true);
  });
});
