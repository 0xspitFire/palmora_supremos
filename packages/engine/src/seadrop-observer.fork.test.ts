import { describe, expect, it } from 'vitest';
import { createPublicClient, encodeFunctionData, http, zeroAddress, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { ChainFactsReader } from './chain-facts.js';
import { SeaDropObserver } from './seadrop-observer.js';

// T-004: proves the SeaDrop event ABI against real Ethereum data on a loopback
// archive-backed Anvil fork. Run with `node scripts/ethereum-fork-replay.mjs packages/engine/src/seadrop-observer.fork.test.ts`.
const rpcUrl = process.env.ANVIL_ETHEREUM_RPC_URL;
const nft = process.env.ETHEREUM_SEADROP_NFT as Address | undefined;
const feeRecipient = process.env.ETHEREUM_SEADROP_FEE_RECIPIENT as Address | undefined;
const mintValueEnv = process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI;
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as Address;
const mintPublicAbi = [{ type: 'function', name: 'mintPublic', stateMutability: 'payable', inputs: [{ name: 'nftContract', type: 'address' }, { name: 'feeRecipient', type: 'address' }, { name: 'minterIfNotPayer', type: 'address' }, { name: 'quantity', type: 'uint256' }], outputs: [] }] as const;

function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname); } catch { return false; }
}

describe.skipIf(!isLoopback(rpcUrl) || !nft || !feeRecipient || mintValueEnv === undefined)('SeaDropObserver on an Ethereum fork', () => {
  it('decodes a real SeaDrop public mint with zero undecodable logs, including a watched recipient', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) }) as PublicClient;
    const request = client.request as unknown as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    const accounts = await request({ method: 'eth_accounts' }) as Address[];
    let minter: Address | undefined;
    for (const account of accounts) if ((await client.getCode({ address: account })) === undefined) { minter = account; break; }
    expect(minter).toBeDefined();
    const before = await client.getBlockNumber();
    const hash = await request({ method: 'eth_sendTransaction', params: [{ from: minter!, to: SEADROP, value: `0x${BigInt(mintValueEnv!).toString(16)}`, data: encodeFunctionData({ abi: mintPublicAbi, functionName: 'mintPublic', args: [nft!, feeRecipient!, zeroAddress, 1n] }) }] });
    const receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    expect(receipt.status).toBe('success');

    const observer = new SeaDropObserver(new ChainFactsReader(client, { chainId: 1, sourceRef: 'fork' }), { confirmations: 0n });
    const outcome = await observer.scan(before + 1n, receipt.blockNumber, [minter!]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.undecodable).toBe(0);
    expect(outcome.result.mints).toEqual([expect.objectContaining({ nftContract: nft!.toLowerCase(), minter: minter!.toLowerCase(), quantity: 1n, unitMintPriceWei: BigInt(mintValueEnv!) })]);
    expect(outcome.result.watchedMints).toEqual([expect.objectContaining({ nftContract: nft!.toLowerCase(), recipient: minter!.toLowerCase() })]);
  }, 120_000);
});
