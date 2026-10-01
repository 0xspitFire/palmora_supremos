import { describe, expect, it } from 'vitest';
import { concatHex, keccak256, type Hex } from 'viem';
import { allowlistLeaf, buildTree, checkAllowlist, parsePublishedList, verifyProof, type MintParams, type PublishedEntry } from './allowlist-check.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';
const OUTSIDER = '0x5555555555555555555555555555555555555555';
const params = (overrides: Partial<MintParams> = {}): MintParams => ({ mintPrice: 0n, maxTotalMintableByWallet: 2n, startTime: 1_800_000_000n, endTime: 0n, dropStageIndex: 1n, maxTokenSupplyForStage: 1000n, feeBps: 500n, restrictFeeRecipients: true, ...overrides });
const entries: PublishedEntry[] = [A, B, C].map((address) => ({ address, mintParams: params() }));
const tree = buildTree(entries.map((entry) => allowlistLeaf(entry.address, entry.mintParams)));
const wrongRoot = keccak256('0x01');

describe('allowlist merkle helpers', () => {
  it('verifies proofs the way the contract does (sorted pairs), for even and odd list sizes', () => {
    const l1 = allowlistLeaf(A, params());
    const l2 = allowlistLeaf(B, params());
    const pair = BigInt(l1) <= BigInt(l2) ? keccak256(concatHex([l1, l2])) : keccak256(concatHex([l2, l1]));
    expect(buildTree([l1, l2]).root).toBe(pair);
    expect(verifyProof([l2], pair, l1)).toBe(true);
    expect(verifyProof([l1], pair, l1)).toBe(false);
    for (const entry of entries) {
      const leaf = allowlistLeaf(entry.address, entry.mintParams);
      expect(verifyProof(tree.proofFor(leaf)!, tree.root, leaf)).toBe(true);
    }
    expect(tree.proofFor(allowlistLeaf(OUTSIDER, params()))).toBeNull();
  });

  it('changes the leaf when any mint parameter changes, so a wallet cannot reuse another stage’s proof', () => {
    expect(allowlistLeaf(A, params())).not.toBe(allowlistLeaf(A, params({ mintPrice: 1n })));
    expect(allowlistLeaf(A, params())).not.toBe(allowlistLeaf(A, params({ restrictFeeRecipients: false })));
    expect(allowlistLeaf(A, params())).not.toBe(allowlistLeaf(B, params()));
  });
});

describe('checkAllowlist (read-only, own wallets)', () => {
  const full = { kind: 'full-list' as const, entries };

  it('says eligible for listed wallets and not_listed only when the list rebuilds into the on-chain root', () => {
    const report = checkAllowlist({ contract: D, wallets: [A, OUTSIDER], onChainRoot: tree.root, list: full });
    expect(report.wallets[0]).toMatchObject({ wallet: A, verdict: 'eligible', entry: { priceWei: '0', maxPerWallet: '2', closesAt: 'no end' } });
    expect(report.wallets[1]).toMatchObject({ wallet: OUTSIDER, verdict: 'not_listed' });
    expect(report.summary).toBe('1 of 2 wallet(s) eligible, 1 not listed, 0 unknown.');
  });

  it('never says not_listed when the published list does not match the chain (fail closed to unknown)', () => {
    const report = checkAllowlist({ contract: D, wallets: [A, OUTSIDER], onChainRoot: wrongRoot, list: full });
    expect(report.wallets.map((wallet) => wallet.verdict)).toEqual(['unknown', 'unknown']);
    expect(report.wallets[0]!.reason).toContain('out of date');
    expect(report.wallets[1]!.reason).toContain('cannot show this wallet is excluded');
  });

  it('treats a proofs-only file as evidence for listed wallets and unknown for the rest', () => {
    const leaf = allowlistLeaf(A, params());
    const proofs = { kind: 'proofs' as const, entries: [{ address: A, mintParams: params(), proof: tree.proofFor(leaf)! }] };
    const report = checkAllowlist({ contract: D, wallets: [A, B], onChainRoot: tree.root, list: proofs });
    expect(report.wallets.map((wallet) => wallet.verdict)).toEqual(['eligible', 'unknown']);
    const bad = checkAllowlist({ contract: D, wallets: [A], onChainRoot: tree.root, list: { kind: 'proofs', entries: [{ address: A, mintParams: params(), proof: [wrongRoot as Hex] }] } });
    expect(bad.wallets[0]!.verdict).toBe('unknown');
  });

  it('answers unknown when the chain cannot be read, has no allowlist, or no list was supplied', () => {
    expect(checkAllowlist({ contract: D, wallets: [A], onChainRoot: null, list: full }).wallets[0]!.verdict).toBe('unknown');
    expect(checkAllowlist({ contract: D, wallets: [A], onChainRoot: `0x${'0'.repeat(64)}`, list: full }).wallets[0]!.reason).toContain('no allowlist set on chain');
    expect(checkAllowlist({ contract: D, wallets: [A], onChainRoot: tree.root, list: null }).wallets[0]!.reason).toContain('No published allowlist');
    expect(checkAllowlist({ contract: D, wallets: ['nope'], onChainRoot: tree.root, list: full }).wallets[0]!.verdict).toBe('unknown');
  });
});

describe('published list parsing', () => {
  it('accepts entries with or without proofs and refuses malformed files', () => {
    const text = JSON.stringify([{ address: A, mintParams: { mintPrice: '0', maxTotalMintableByWallet: 2, startTime: 1, endTime: 0, dropStageIndex: 1, maxTokenSupplyForStage: 10, feeBps: 500, restrictFeeRecipients: true } }]);
    expect(parsePublishedList(text)).toMatchObject({ kind: 'full-list', entries: [{ address: A }] });
    expect(() => parsePublishedList('not json')).toThrow('ALLOWLIST_FILE_NOT_JSON');
    expect(() => parsePublishedList('[]')).toThrow('ALLOWLIST_FILE_SHAPE_INVALID');
    expect(() => parsePublishedList(JSON.stringify([{ address: 'bad', mintParams: {} }]))).toThrow('ALLOWLIST_ENTRY_INVALID');
    expect(() => parsePublishedList(JSON.stringify([{ address: A, mintParams: { mintPrice: '-1' } }]))).toThrow('ALLOWLIST_ENTRY_INVALID');
    expect(() => parsePublishedList(JSON.stringify([{ address: A, mintParams: { mintPrice: 0, maxTotalMintableByWallet: 1, startTime: 0, endTime: 0, dropStageIndex: 1, maxTokenSupplyForStage: 1, feeBps: 0 }, proof: ['0x12'] }]))).toThrow('ALLOWLIST_ENTRY_INVALID');
  });
});
