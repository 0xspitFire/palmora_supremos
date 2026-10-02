import { describe, expect, it } from 'vitest';
import { describeFeePolicy, feePolicyConfirmationPhrase } from './fee-policy.js';

const approved = { maxTotalFeeWei: '400000000000000', freeCapWei: '400000000000000' };

describe('fee-policy command text (D-042)', () => {
  it('names both numbers in the confirmation phrase, so a stale phrase does not match', () => {
    expect(feePolicyConfirmationPhrase(approved)).toBe('APPLY-FEE-POLICY free 0.0004 max 0.0004');
    expect(feePolicyConfirmationPhrase({ ...approved, freeCapWei: '300000000000000' })).not.toBe(feePolicyConfirmationPhrase(approved));
  });

  it('explains each state in plain words and only offers a phrase when a change is possible', () => {
    expect(describeFeePolicy({ fleetPolicyConfigured: false, stored: null, approved: null, matchesApproved: false })).toMatchObject({ state: 'no_approved_policy' });
    expect(describeFeePolicy({ fleetPolicyConfigured: true, stored: null, approved, matchesApproved: false })).toMatchObject({ state: 'missing', confirmation: 'APPLY-FEE-POLICY free 0.0004 max 0.0004' });
    const same = describeFeePolicy({ fleetPolicyConfigured: true, stored: approved, approved, matchesApproved: true });
    expect(same.state).toBe('ok');
    expect(same.confirmation).toBeUndefined();
    const stale = describeFeePolicy({ fleetPolicyConfigured: true, stored: { maxTotalFeeWei: '34', freeCapWei: '40' }, approved, matchesApproved: false });
    expect(stale.state).toBe('differs');
    expect(stale.message).toContain('Reservations already made are not changed');
    expect(stale.confirmation).toBe('APPLY-FEE-POLICY free 0.0004 max 0.0004');
  });
});
