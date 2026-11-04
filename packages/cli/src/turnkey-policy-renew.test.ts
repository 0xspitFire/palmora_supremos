import { describe, expect, it } from 'vitest';
import { turnkeyProviderPolicyExpressions, type TurnkeyProviderPolicyProjection } from '@mint-bot/engine';
import { planTurnkeyPolicyRenewal } from './turnkey-policy-renew.js';
import { robinhoodTurnkeyPolicy } from './turnkey-policy-template.js';

const input = {
  environment: 'production' as const,
  organizationId: 'org',
  userId: 'runtime-user',
  wallets: [{ index: 0, address: '0x1111111111111111111111111111111111111111' as const, signWith: 'key-1' }],
  nftContract: '0x2222222222222222222222222222222222222222' as const,
  feeRecipient: '0x3333333333333333333333333333333333333333' as const,
  quantity: 1,
  gasLimitMax: '500000',
  maxFeePerGasGwei: '0.2',
  maxPriorityFeePerGasGwei: '0.1',
};

function providerPolicy(policyId: string, condition?: string): TurnkeyProviderPolicyProjection {
  const desired = robinhoodTurnkeyPolicy({ ...input, policyId });
  const expressions = turnkeyProviderPolicyExpressions(desired);
  return {
    policyId,
    policyName: 'exact mint',
    effect: 'EFFECT_ALLOW',
    createdAt: { seconds: '1', nanos: '0' },
    updatedAt: { seconds: '2', nanos: '0' },
    notes: '',
    consensus: expressions.consensus,
    condition: condition ?? expressions.condition,
    time: null,
  };
}

describe('Turnkey policy renewal planner', () => {
  it('reuses an exact policy regardless of provider metadata', () => {
    // Both are exact and therefore ambiguous: duplicate exact grants must be cleaned up explicitly.
    expect(() => planTurnkeyPolicyRenewal(input, [providerPolicy('old-drop'), providerPolicy('exact-drop')])).toThrow('TURNKEY_RENEWAL_POLICY_AMBIGUOUS');
  });

  it('reuses the sole exact policy and refuses an explicitly named mismatch', () => {
    const exact = providerPolicy('exact-drop');
    const plan = planTurnkeyPolicyRenewal(input, [providerPolicy('broad', 'true'), exact]);
    expect(plan.stage).toBe('proposal-ready');
    expect(plan.reusedProviderPolicy).toBe(true);
    expect(plan.policy.scope.policyId).toBe('exact-drop');
    expect(() => planTurnkeyPolicyRenewal({ ...input, policyId: 'broad' }, [providerPolicy('broad', 'true')])).toThrow('TURNKEY_RENEWAL_POLICY_MISMATCH');
  });

  it('returns exact creation text when no reusable policy exists', () => {
    const plan = planTurnkeyPolicyRenewal(input, [providerPolicy('broad', 'true')]);
    expect(plan.stage).toBe('provider-policy-required');
    expect(plan.reusedProviderPolicy).toBe(false);
    expect(plan.policy.scope.policyId).toBe('pending-provider-policy');
    expect(plan.providerPolicy.condition).toBe(turnkeyProviderPolicyExpressions(plan.policy).condition);
  });
});


it('renews a free allowlist family without a collection and reuses only its exact provider expression', () => {
  const family = { ...input, allowlistFamily: true, chainId: 4663 as const, quantity: 4 };
  const built = robinhoodTurnkeyPolicy({ ...family, policyId: 'family-policy' });
  const existing: TurnkeyProviderPolicyProjection = { policyId: 'family-policy', policyName: 'family', effect: 'EFFECT_ALLOW', createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, notes: '', ...turnkeyProviderPolicyExpressions(built), time: null };
  const plan = planTurnkeyPolicyRenewal(family, [existing]);
  expect(plan.stage).toBe('proposal-ready');
  expect(plan.policy.family?.kind).toBe('seadrop-free-allowlist-v1');
  expect(plan.policy.transaction.data).toBe('0x4300a4e6');
  expect(() => planTurnkeyPolicyRenewal({ ...family, quantity: 5, policyId: 'family-policy' }, [existing])).toThrow('TURNKEY_RENEWAL_POLICY_MISMATCH');
});
