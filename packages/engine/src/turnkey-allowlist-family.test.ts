import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { allowlistLeaf, buildTree } from './allowlist.js';
import { ALLOWLIST_MINT_ABI, buildAllowlistMint, type VerifiedWalletProof } from './allowlist-authority.js';
import { OPENSEA_FEE_COLLECTOR, SEADROP_V1_ADDRESS } from './chains.js';
import { assertIndependentAllowlistAuthority, independentRpcEndpoints, type AllowlistAuthorityClient } from './turnkey-allowlist-authority.js';
import { canonicalPolicyDigest, turnkeyPolicyRef, validateTransactionIntent, validateTurnkeyPolicyAst, type TurnkeyPolicyAst } from './turnkey-policy.js';
import { turnkeyProviderPolicyExpressions } from './turnkey-policy-record.js';
import type { TransactionIntent } from './types.js';
const wallet = '0x1111111111111111111111111111111111111111' as Address;
const other = '0x2222222222222222222222222222222222222222' as Address;
const nft = '0x3333333333333333333333333333333333333333' as Address;
const params = { mintPrice: 0n, maxTotalMintableByWallet: 4n, startTime: 1n, endTime: 2_000_000_000n, dropStageIndex: 1n, maxTokenSupplyForStage: 100n, feeBps: 0n, restrictFeeRecipients: false };
const tree = buildTree([wallet, other].map((address) => allowlistLeaf(address, params)));
function proof(): VerifiedWalletProof { return { wallet, mintParams: params, proof: tree.proofFor(allowlistLeaf(wallet, params))!, source: { chainId: 4663, nftContract: nft, stageIndex: '1', sourceId: 'test', contentDigest: `sha256:${'a'.repeat(64)}` }, authority: { chainId: 4663, nftContract: nft, seaDrop: SEADROP_V1_ADDRESS, root: tree.root, blockNumber: 100n, blockHash: `0x${'b'.repeat(64)}` as Hex, observedAt: new Date().toISOString(), feeRecipient: OPENSEA_FEE_COLLECTOR } }; }
function policy(): TurnkeyPolicyAst { return { version: 1, effect: 'allow', scope: { provider: 'turnkey', environment: 'production', organizationId: 'org', userId: 'runtime', policyId: 'allowlist', keyIds: ['key'] }, transaction: { chainId: 4663, from: [wallet], to: SEADROP_V1_ADDRESS, valueWei: '0', data: '0x4300a4e6', gasLimitMax: '500000', maxFeePerGasMax: '200000000', maxPriorityFeePerGasMax: '100000000', accessList: [] }, family: { kind: 'seadrop-free-allowlist-v1', maxQuantity: 4 } }; }
function intent(p = proof()): TransactionIntent { const policyValue = policy(); return { chainId: 4663, from: wallet, to: SEADROP_V1_ADDRESS, value: 0n, data: buildAllowlistMint(p, wallet, 4).data, nonce: 1, gasLimit: 200000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n, campaignId: 'campaign', runId: 'run', policyRef: turnkeyPolicyRef('allowlist', canonicalPolicyDigest(policyValue)), familyContext: { nftContract: nft, feeRecipient: OPENSEA_FEE_COLLECTOR, allowlistProof: p, assertReady: () => undefined } }; }
const client = (changes: { root?: Hex; chain?: number; hash?: Hex; age?: number; fees?: string[] } = {}): AllowlistAuthorityClient => ({ getBlockNumber: async () => 105n, getChainId: async () => changes.chain ?? 4663, getBlock: async () => ({ hash: changes.hash ?? `0x${'d'.repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000) - (changes.age ?? 0)) }), readContract: async (args) => args.functionName === 'getAllowListMerkleRoot' ? changes.root ?? tree.root : changes.fees ?? [] });
describe('approved free allowlist policy family', () => {
  it('binds provider key, chain, method, free mint price, wallet recipient, quantity and fee limits', () => {
    const expression = turnkeyProviderPolicyExpressions(policy()).condition;
    expect(expression).toContain("eth.tx.data[0..10] == '0x4300a4e6'");
    expect(expression).toContain("eth.tx.data[266..330] == '0000000000000000000000000000000000000000000000000000000000000000'");
    expect(expression).toContain('eth.tx.chain_id == 4663');
    expect(expression).not.toContain('hex_to_uint');
    for (const chainId of [1, 8453, 4663] as const) expect(validateTurnkeyPolicyAst({ ...policy(), transaction: { ...policy().transaction, chainId } }).transaction.chainId).toBe(chainId);
    expect(() => validateTurnkeyPolicyAst({ ...policy(), transaction: { ...policy().transaction, chainId: 8453 }, family: { ...policy().family, maxQuantity: 5 } })).toThrow('TURNKEY_POLICY_FAMILY_INVALID');
    for (const changed of [{ gasLimitMax: '500001' }, { maxFeePerGasMax: '200000001' }, { maxPriorityFeePerGasMax: '100000001' }, { gasLimitMax: '0' }]) expect(() => validateTurnkeyPolicyAst({ ...policy(), transaction: { ...policy().transaction, ...changed } })).toThrow('TURNKEY_POLICY_FAMILY_FEE_LIMIT_INVALID');
  });
  it('accepts only a canonical own-wallet current free proof and bounded transaction', () => {
    const current = intent(); const ref = current.policyRef!;
    expect(() => validateTransactionIntent(current, policy(), ref)).not.toThrow();
    const decoded = decodeFunctionData({ abi: ALLOWLIST_MINT_ABI, data: current.data });
    expect(decoded.args[3]).toBe(4n);
    const invalid = [ { ...current, from: other }, { ...current, campaignId: undefined }, { ...current, value: 1n }, { ...current, data: `${current.data}00` as Hex }, { ...current, familyContext: { ...current.familyContext!, feeRecipient: other } }, { ...current, familyContext: { ...current.familyContext!, allowlistProof: { ...proof(), authority: { ...proof().authority, root: `0x${'c'.repeat(64)}` as Hex } } } } ];
    for (const changed of invalid) expect(() => validateTransactionIntent(changed, policy(), ref)).toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
  });
  it('requires both current independent RPCs to agree on chain, block, root and allowed recipient', async () => {
    const current = intent();
    await expect(assertIndependentAllowlistAuthority(current, [client(), client()])).resolves.toBeUndefined();
    await expect(assertIndependentAllowlistAuthority(current, [client()])).rejects.toThrow('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
    await expect(assertIndependentAllowlistAuthority(current, [client(), client({ root: `0x${'f'.repeat(64)}` })])).rejects.toThrow('TURNKEY_ALLOWLIST_RPC_DISAGREEMENT');
    await expect(assertIndependentAllowlistAuthority(current, [client({ root: `0x${'f'.repeat(64)}` }), client({ root: `0x${'f'.repeat(64)}` })])).rejects.toThrow('TURNKEY_ALLOWLIST_ROOT_CHANGED');
    await expect(assertIndependentAllowlistAuthority(current, [client(), client({ chain: 1 })])).rejects.toThrow('TURNKEY_ALLOWLIST_AUTHORITY_STALE');
    await expect(assertIndependentAllowlistAuthority(current, [client(), client({ age: 301 })])).rejects.toThrow('TURNKEY_ALLOWLIST_AUTHORITY_STALE');
    await expect(assertIndependentAllowlistAuthority({ ...current, familyContext: { ...current.familyContext!, allowlistProof: { ...proof(), mintParams: { ...params, restrictFeeRecipients: true } } } }, [client(), client()])).rejects.toThrow('TURNKEY_ALLOWLIST_FEE_RECIPIENT_INVALID');
  });
  it('does not count two paths or credentials on the same host as independent RPCs', () => {
    expect(() => independentRpcEndpoints(['https://first.example/a', 'https://first.example/b'])).toThrow('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
    expect(independentRpcEndpoints(['https://first.example/a', 'https://first.example/b', 'https://second.example/rpc'])).toEqual(['https://first.example/a', 'https://second.example/rpc']);
  });
  it('redacts transport failures before they can reach logs or result records', async () => {
    const failing = { ...client(), getBlockNumber: async () => { throw new Error('https://rpc.example/private-token?api_key=secret-value'); } };
    await expect(assertIndependentAllowlistAuthority(intent(), [client(), failing])).rejects.toThrow(/^TURNKEY_ALLOWLIST_AUTHORITY_UNAVAILABLE$/);
  });
  it('never invokes a provider for rejected local intent', () => {
    const provider = vi.fn();
    const current = intent();
    try { validateTransactionIntent({ ...current, data: '0x161ac21f' }, policy(), current.policyRef!); provider(); } catch { /* expected */ }
    expect(provider).not.toHaveBeenCalled();
  });
});
