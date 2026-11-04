import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { allowlistLeaf, buildTree } from '../allowlist.js';
import { ALLOWLIST_MINT_ABI, qualifyWalletProofs } from '../allowlist-authority.js';
import { SEADROP_V1_ADDRESS } from '../chains.js';
import { describeDropChange } from '../drop-recheck.js';
import { SeaDropV1AllowlistStrategy } from './seadrop-v1-allowlist.js';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;
const NFT = '0x3333333333333333333333333333333333333333' as Address;
const NOW = new Date('2026-11-04T12:00:00Z');
const p = { mintPrice: 0n, maxTotalMintableByWallet: 1n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false };

describe('own-wallet SeaDrop allowlist strategy', () => {
  it('keeps each wallet\'s distinct ABI parameters and proof, and stops on root drift', async () => {
    const entries = [{ address: A, mintParams: p }, { address: B, mintParams: { ...p, maxTotalMintableByWallet: 3n } }];
    const tree = buildTree(entries.map((e) => allowlistLeaf(e.address, e.mintParams)));
    const text = JSON.stringify(entries, (_k, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    const proofs = qualifyWalletProofs({ text, source: { chainId: 1, nftContract: NFT, stageIndex: '1', sourceId: 'project', contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}` }, authority: { chainId: 1, nftContract: NFT, seaDrop: SEADROP_V1_ADDRESS, root: tree.root, blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}` as Hex, observedAt: NOW.toISOString(), feeRecipient: B }, wallets: [A, B], now: NOW });
    const strategy = new SeaDropV1AllowlistStrategy(async () => proofs, () => NOW);
    const client = { readContract: vi.fn(async () => 0n), estimateGas: vi.fn(async () => 100_000n) };
    const drop = await strategy.readDrop(client as unknown as PublicClient, NFT, 1);
    const first = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: strategy.buildCalldata(drop, A, 1) });
    const second = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: strategy.buildCalldata(drop, B, 1) });
    expect(first.args[4].maxTotalMintableByWallet).toBe(1n);
    expect(second.args[4].maxTotalMintableByWallet).toBe(3n);
    expect(first.args[5]).not.toEqual(second.args[5]);
    expect(drop.maxTotalMintableByWallet).toBe(1);
    await expect(strategy.estimateGas(client as unknown as PublicClient, drop, B, 1)).resolves.toBe(100_000n);
    expect(() => strategy.buildCalldata(drop, NFT, 1)).toThrow('ALLOWLIST_OWN_WALLET_PROOF_REQUIRED');
    expect(describeDropChange(drop, { ...drop, extra: { ...drop.extra, allowlistRoot: `0x${'b'.repeat(64)}` } }, { valid: true, errors: [], warnings: [] })).toContain('contract settings');
  });
});
