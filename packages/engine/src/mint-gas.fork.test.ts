import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, encodeFunctionData, http, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

// T-007: measures real SeaDrop public-mint gas on a loopback archive-backed Ethereum fork, to check
// the D-033 free-mint fee allowance (0.0004 ETH). Run with `pnpm ops:gas-fork`. Never broadcasts to a real chain.
const rpcUrl = process.env.ANVIL_ETHEREUM_RPC_URL;
const nft = process.env.ETHEREUM_SEADROP_NFT as Address | undefined;
const feeRecipient = process.env.ETHEREUM_SEADROP_FEE_RECIPIENT as Address | undefined;
const mintValueEnv = process.env.ETHEREUM_SEADROP_MINT_VALUE_WEI;
const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as Address;
const ABI = parseAbi([
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address nftContract) view returns ((uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
]);
const ALLOWANCE_WEI = 400_000_000_000_000n;
const PADDING_NUM = 12n;
const PADDING_DEN = 10n;

function loopback(url: string | undefined): boolean {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname); } catch { return false; }
}

describe.skipIf(!loopback(rpcUrl) || !nft || !feeRecipient || mintValueEnv === undefined)('SeaDrop public mint gas on an Ethereum fork (T-007)', () => {
  it('measures gas for 1 NFT and for the largest allowed quantity, and the fee level the allowance covers', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) }) as PublicClient;
    const request = client.request as unknown as (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    const drop = await client.readContract({ address: SEADROP, abi: ABI, functionName: 'getPublicDrop', args: [nft!] });
    const unitPrice = BigInt(mintValueEnv!);
    const accounts = await request({ method: 'eth_accounts' }) as Address[];
    const eoas: Address[] = [];
    for (const account of accounts) if ((await client.getCode({ address: account })) === undefined) eoas.push(account);
    expect(eoas.length).toBeGreaterThanOrEqual(2);
    const maxQuantity = drop.maxTotalMintableByWallet > 0 ? Math.min(5, drop.maxTotalMintableByWallet) : 5;
    const quantities = [...new Set([1, maxQuantity])];
    const rows: Array<{ quantity: number; gasUsed: string; estimateGas: string; effectiveGasPriceWei: string }> = [];
    for (const [index, quantity] of quantities.entries()) {
      const from = eoas[index]!;
      const data = encodeFunctionData({ abi: ABI, functionName: 'mintPublic', args: [nft!, feeRecipient!, zeroAddress, BigInt(quantity)] }) as Hex;
      const value = unitPrice * BigInt(quantity);
      const estimate = await client.estimateGas({ account: from, to: SEADROP, data, value });
      const hash = await request({ method: 'eth_sendTransaction', params: [{ from, to: SEADROP, data, value: `0x${value.toString(16)}` }] }) as Hex;
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      rows.push({ quantity, gasUsed: receipt.gasUsed.toString(), estimateGas: estimate.toString(), effectiveGasPriceWei: receipt.effectiveGasPrice.toString() });
    }
    // Worst case the bot reserves: gasLimit (estimate × 1.2) × max fee. Break-even max fee = allowance / gasLimit.
    const summary = rows.map((row) => {
      const paddedLimit = (BigInt(row.estimateGas) * PADDING_NUM + PADDING_DEN - 1n) / PADDING_DEN; // rounds up, as the engine does (Math.ceil)
      const breakEvenWeiUnpadded = ALLOWANCE_WEI / BigInt(row.gasUsed);
      const breakEvenWeiPadded = ALLOWANCE_WEI / paddedLimit;
      return { ...row, paddedGasLimit: paddedLimit.toString(), breakEvenMaxFeeGweiUsed: (Number(breakEvenWeiUnpadded) / 1e9).toFixed(3), breakEvenMaxFeeGweiPadded: (Number(breakEvenWeiPadded) / 1e9).toFixed(3) };
    });
    const evidence = { measuredAt: new Date().toISOString(), forkBlock: process.env.ETHEREUM_FORK_BLOCK ?? null, nft, unitPriceWei: unitPrice.toString(), maxTotalMintableByWallet: drop.maxTotalMintableByWallet, allowanceWei: ALLOWANCE_WEI.toString(), rows: summary };
    writeFileSync(join(tmpdir(), 'mintbot-gas-evidence.json'), JSON.stringify(evidence, null, 2));
    for (const row of summary) expect(BigInt(row.gasUsed)).toBeGreaterThan(21_000n);
  }, 180_000);
});
