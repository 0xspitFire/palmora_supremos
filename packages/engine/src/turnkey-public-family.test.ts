import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, zeroAddress, type Address } from 'viem';
import { SEADROP_V1_ADDRESS } from './chains.js';
import { canonicalPolicyDigest, turnkeyPolicyRef, validateTransactionIntent, validateTurnkeyPolicyAst, type TurnkeyPolicyAst } from './turnkey-policy.js';
import { turnkeyProviderPolicyExpressions } from './turnkey-policy-record.js';
import type { TransactionIntent } from './types.js';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const nft = '0x2222222222222222222222222222222222222222' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;
const abi = parseAbi(['function mintPublic(address,address,address,uint256)']);
const data = (quantity: bigint, minter: Address = zeroAddress) => encodeFunctionData({ abi, functionName: 'mintPublic', args: [nft, recipient, minter, quantity] });
function policy(chainId: 1 | 8453 | 4663): TurnkeyPolicyAst {
  return { version: 1, effect: 'allow', scope: { provider: 'turnkey', environment: 'production', organizationId: 'org', userId: 'runtime', policyId: 'public', keyIds: ['key'] }, transaction: { chainId, from: [wallet], to: SEADROP_V1_ADDRESS, valueWei: '0', data: '0x161ac21f', gasLimitMax: '500000', maxFeePerGasMax: '200000000', maxPriorityFeePerGasMax: '100000000', accessList: [] }, family: { kind: 'seadrop-free-public-v1', maxQuantity: chainId === 8453 ? 4 : 10 } };
}
function intent(p: TurnkeyPolicyAst): TransactionIntent {
  return { chainId: p.transaction.chainId, from: wallet, to: SEADROP_V1_ADDRESS, nonce: 1, value: 0n, data: data(1n), gasLimit: 100000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n, accessList: [], policyRef: turnkeyPolicyRef('public', canonicalPolicyDigest(p)), campaignId: 'campaign', runId: 'run', familyContext: { nftContract: nft, feeRecipient: recipient, assertReady: () => undefined } };
}

describe('bounded free public family', () => {
  it.each([1, 8453, 4663] as const)('binds chain %s and provider quantity/sponsor/value limits', (chainId) => {
    const p = validateTurnkeyPolicyAst(policy(chainId));
    const expr = turnkeyProviderPolicyExpressions(p).condition;
    expect(expr).toContain(`eth.tx.chain_id == ${chainId}`);
    expect(expr).toContain('eth.tx.value == 0');
    expect(expr).toContain("eth.tx.data[0..10] == '0x161ac21f'");
    expect(expr).toContain("eth.tx.data[138..202] == '" + '0'.repeat(64) + "'");
    expect(expr).not.toContain('hex_to_uint');
    const tx = intent(p);
    expect(() => validateTransactionIntent(tx, p, tx.policyRef!)).not.toThrow();
    expect(() => validateTransactionIntent({ ...tx, data: data(BigInt(p.family!.maxQuantity)) }, p, tx.policyRef!)).not.toThrow();
    for (const changed of [{ value: 1n }, { chainId: chainId === 1 ? 4663 as const : 1 as const }, { data: data(BigInt(p.family!.maxQuantity + 1)) }, { data: data(1n, wallet) }, { data: `${tx.data}00` as `0x${string}` }, { to: nft }, { maxFeePerGas: 200000001n }, { familyContext: undefined }]) {
      expect(() => validateTransactionIntent({ ...tx, ...changed }, p, tx.policyRef!)).toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
    }
    const badPadding = `${tx.data.slice(0, 10)}01${tx.data.slice(12)}` as `0x${string}`;
    expect(() => validateTransactionIntent({ ...tx, data: badPadding }, p, tx.policyRef!)).toThrow('TURNKEY_POLICY_INTENT_BLOCKED');
  });

  it.each([1, 8453, 4663] as const)('refuses wider quantities or fees for chain %s', (chainId) => {
    const p = policy(chainId);
    expect(() => validateTurnkeyPolicyAst({ ...p, family: { ...p.family, maxQuantity: chainId === 8453 ? 5 : 11 } })).toThrow('TURNKEY_POLICY_FAMILY_INVALID');
    for (const limits of [{ gasLimitMax: '500001' }, { gasLimitMax: '0' }, { maxFeePerGasMax: '200000001' }, { maxFeePerGasMax: '0' }, { maxPriorityFeePerGasMax: '100000001' }]) {
      expect(() => validateTurnkeyPolicyAst({ ...p, transaction: { ...p.transaction, ...limits } })).toThrow('TURNKEY_POLICY_FAMILY_FEE_LIMIT_INVALID');
    }
  });
});
