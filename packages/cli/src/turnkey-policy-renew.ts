import {
  projectTurnkeyProviderPolicy,
  turnkeyProviderPolicyExpressions,
  type TurnkeyProviderPolicyProjection,
  type TurnkeyWalletReference,
} from '@mint-bot/engine';
import { robinhoodTurnkeyPolicy, type RobinhoodTurnkeyPolicyInput } from './turnkey-policy-template.js';

export interface TurnkeyPolicyRenewalInput extends Omit<RobinhoodTurnkeyPolicyInput, 'policyId'> {
  policyId?: string;
}

export interface TurnkeyPolicyRenewalPlan {
  readonly version: 1;
  readonly stage: 'provider-policy-required' | 'proposal-ready';
  readonly reusedProviderPolicy: boolean;
  readonly policy: ReturnType<typeof robinhoodTurnkeyPolicy>;
  readonly providerPolicy: {
    readonly effect: 'EFFECT_ALLOW';
    readonly consensus: string;
    readonly condition: string;
    readonly time: null;
  };
}

function sameExpression(left: TurnkeyProviderPolicyProjection, right: TurnkeyPolicyRenewalPlan['providerPolicy']): boolean {
  return left.effect === right.effect
    && left.consensus === right.consensus
    && left.condition === right.condition
    && left.time === right.time;
}

/**
 * Finds an already-created exact provider policy without granting policy-admin
 * authority to the runtime. No match returns the precise policy text the owner
 * must create/approve in Turnkey; it never broadens calldata or fee limits.
 */
export function planTurnkeyPolicyRenewal(input: TurnkeyPolicyRenewalInput, providerPolicyValues: readonly unknown[]): TurnkeyPolicyRenewalPlan {
  const providerPolicies = providerPolicyValues.map(projectTurnkeyProviderPolicy);
  const candidateIds = input.policyId ? [input.policyId] : providerPolicies.map((policy) => policy.policyId);
  const matches = candidateIds.flatMap((policyId) => {
    const policy = robinhoodTurnkeyPolicy({ ...input, policyId });
    const expressions = turnkeyProviderPolicyExpressions(policy);
    const expected = { effect: 'EFFECT_ALLOW' as const, ...expressions, time: null };
    const actual = providerPolicies.find((candidate) => candidate.policyId === policyId);
    return actual && sameExpression(actual, expected) ? [{ policy, providerPolicy: expected }] : [];
  });
  if (matches.length > 1) throw new Error('TURNKEY_RENEWAL_POLICY_AMBIGUOUS');
  if (input.policyId && matches.length === 0) throw new Error('TURNKEY_RENEWAL_POLICY_MISMATCH');
  if (matches[0]) return { version: 1, stage: 'proposal-ready', reusedProviderPolicy: true, ...matches[0] };

  const policy = robinhoodTurnkeyPolicy({ ...input, policyId: 'pending-provider-policy' });
  return {
    version: 1,
    stage: 'provider-policy-required',
    reusedProviderPolicy: false,
    policy,
    providerPolicy: { effect: 'EFFECT_ALLOW', ...turnkeyProviderPolicyExpressions(policy), time: null },
  };
}

export function renewalWallets(value: readonly TurnkeyWalletReference[]): readonly TurnkeyWalletReference[] {
  if (value.length === 0) throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
  return value.map((wallet, index) => {
    if (wallet.index !== index || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address) || !wallet.signWith) throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
    return { index, address: wallet.address.toLowerCase() as `0x${string}`, signWith: wallet.signWith };
  });
}
