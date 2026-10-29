import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi, type Address } from 'viem';
import { canonicalPolicyDigest, SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import { robinhoodTurnkeyPolicy } from './turnkey-policy-template.js';

const wallets = [
  { index: 0, address: '0x1111111111111111111111111111111111111111' as Address, signWith: 'key-1' },
  { index: 1, address: '0x2222222222222222222222222222222222222222' as Address, signWith: 'key-2' },
];
const input = { environment: 'production' as const, organizationId: 'org', userId: 'user', policyId: 'policy-rh', wallets, nftContract: '0x3333333333333333333333333333333333333333' as Address, feeRecipient: '0x4444444444444444444444444444444444444444' as Address, quantity: 1, gasLimitMax: '500000', maxFeePerGasGwei: '0.2', maxPriorityFeePerGasGwei: '0.1' };

describe('Robinhood Turnkey policy template', () => {
  it('binds chain, full fleet, SeaDrop target, exact free calldata and fee ceilings', () => {
    const policy = robinhoodTurnkeyPolicy(input);
    expect(policy.transaction).toMatchObject({ chainId: 4663, from: wallets.map((wallet) => wallet.address), to: SEADROP_V1_ADDRESS.toLowerCase(), valueWei: '0', gasLimitMax: '500000', maxFeePerGasMax: '200000000', maxPriorityFeePerGasMax: '100000000' });
    const decoded = decodeFunctionData({ abi: parseAbi(['function mintPublic(address,address,address,uint256)']), data: policy.transaction.data });
    expect(decoded.args).toEqual([input.nftContract, input.feeRecipient, '0x0000000000000000000000000000000000000000', 1n]);
    expect(canonicalPolicyDigest(policy)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects excessive quantity and inverted fee bounds', () => {
    expect(() => robinhoodTurnkeyPolicy({ ...input, quantity: 16 })).toThrow('TURNKEY_ROBINHOOD_POLICY_LIMIT_INVALID');
    expect(() => robinhoodTurnkeyPolicy({ ...input, maxFeePerGasGwei: '0.05' })).toThrow('TURNKEY_ROBINHOOD_POLICY_FEE_INVALID');
  });

  it('can create the bounded family without binding a future NFT contract', () => {
    const policy = robinhoodTurnkeyPolicy({ ...input, policyFamily: true });
    expect(policy.family).toEqual({ kind: 'robinhood-seadrop-public-v1', maxQuantity: 1 });
    expect(policy.transaction.data).toBe('0x161ac21f');
  });
});
