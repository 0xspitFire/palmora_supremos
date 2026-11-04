import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { allowlistLeaf } from './allowlist.js';
import { ALLOWLIST_MINT_ABI, buildAllowlistMint, qualifyWalletProofs } from './allowlist-authority.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const nft = '0x2222222222222222222222222222222222222222' as Address;
const other = '0x3333333333333333333333333333333333333333' as Address;
const now = new Date('2026-11-04T12:00:00Z');
const params = { mintPrice: 0n, maxTotalMintableByWallet: 4n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false };
const text = JSON.stringify([{ address: wallet, mintParams: params, proof: [] }], (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
const source = { chainId: 1 as const, nftContract: nft, stageIndex: '1', sourceId: 'project', contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}` };
const authority = { chainId: 1 as const, nftContract: nft, seaDrop: SEADROP_V1_ADDRESS, root: allowlistLeaf(wallet, params), blockNumber: 100n, blockHash: `0x${'a'.repeat(64)}` as Hex, observedAt: now.toISOString(), feeRecipient: other };
const qualify = () => qualifyWalletProofs({ text, source, authority, wallets: [wallet, other], now });
describe('two independent allowlist authorities', () => {
  it('builds the exact SeaDrop allowlist call only for an owned wallet with a verified leaf', () => {
    const proofs = qualify();
    expect(proofs).toHaveLength(1);
    const mint = buildAllowlistMint(proofs[0]!, wallet, 4, now);
    expect(mint.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: mint.data });
    expect(decoded.args[3]).toBe(4n);
    expect(decoded.args[4]).toEqual(params);
  });
  it('rejects borrowed proofs, quantity overflow, stale authority and early execution', () => {
    const p = qualify()[0]!;
    expect(() => buildAllowlistMint(p, other, 1, now)).toThrow('ALLOWLIST_WALLET_PROOF_INVALID');
    expect(() => buildAllowlistMint(p, wallet, 5, now)).toThrow('ALLOWLIST_WALLET_PROOF_INVALID');
    expect(() => buildAllowlistMint(p, wallet, 1, new Date(now.getTime() + 60_001))).toThrow();
    expect(() => buildAllowlistMint({ ...p, mintParams: { ...params, startTime: 2_000_000_000n } }, wallet, 1, now)).toThrow();
  });
  it('refuses changed root, wrong chain/contract/stage and tampered bytes', () => {
    expect(qualifyWalletProofs({ text, source, authority: { ...authority, root: `0x${'b'.repeat(64)}` }, wallets: [wallet], now })).toEqual([]);
    for (const changed of [{ ...source, chainId: 8453 as const }, { ...source, nftContract: other }]) expect(() => qualifyWalletProofs({ text, source: changed, authority, wallets: [wallet], now })).toThrow();
    expect(qualifyWalletProofs({ text, source: { ...source, stageIndex: '2' }, authority, wallets: [wallet], now })).toEqual([]);
    expect(() => qualifyWalletProofs({ text: `${text} `, source, authority, wallets: [wallet], now })).toThrow('ALLOWLIST_CONTENT_DIGEST_MISMATCH');
  });
});
