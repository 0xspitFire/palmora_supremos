import { describe, expect, it } from 'vitest';
import { assertFeePolicyApplyAllowed, assertTipMatchesStoredPolicy, describeFeePolicy, feePolicyConfirmationPhrase, plainFeePolicyMessage, type FeePolicyStatusView } from './fee-policy.js';

const approved = { maxTotalFeeWei: '400000000000000', freeCapWei: '400000000000000', tipWei: '100000000' };
const PHRASE = 'APPLY-FEE-POLICY free 0.0004 max 0.0004 tip 0.1';
const stale = { maxTotalFeeWei: '34', freeCapWei: '40', tipWei: '20' };
const status = (overrides: Partial<FeePolicyStatusView> = {}): FeePolicyStatusView => ({ fleetPolicyConfigured: true, stored: stale, approved, matchesApproved: false, ...overrides });

describe('fee-policy command text (D-042)', () => {
  it('names all three numbers in the confirmation phrase, so a stale phrase does not match', () => {
    expect(feePolicyConfirmationPhrase(approved)).toBe(PHRASE);
    expect(feePolicyConfirmationPhrase({ ...approved, freeCapWei: '300000000000000' })).not.toBe(PHRASE);
    expect(feePolicyConfirmationPhrase({ ...approved, tipWei: '200000000' })).not.toBe(PHRASE);
  });

  it('explains each state in plain words and only offers a phrase when a change is possible', () => {
    expect(describeFeePolicy(status({ fleetPolicyConfigured: false, stored: null, approved: null }))).toMatchObject({ state: 'no_approved_policy' });
    expect(describeFeePolicy(status({ stored: null }))).toMatchObject({ state: 'missing', confirmation: PHRASE });
    const same = describeFeePolicy(status({ stored: approved, matchesApproved: true }));
    expect(same.state).toBe('ok');
    expect(same.confirmation).toBeUndefined();
    const differs = describeFeePolicy(status());
    expect(differs.state).toBe('differs');
    expect(differs.message).toContain('Reservations already made are not changed');
    expect(differs.message).toContain('tip 0.00000002 gwei');
    expect(differs.confirmation).toBe(PHRASE);
  });
});

describe('every gate on replacing the stored fee policy', () => {
  it('passes only with an approved policy and the exact phrase', () => {
    expect(() => assertFeePolicyApplyAllowed({ status: status(), confirm: PHRASE })).not.toThrow();
  });

  it('refuses a missing, empty, wrong, stale or differently cased phrase', () => {
    for (const confirm of [undefined, '', 'yes', PHRASE.toLowerCase(), `${PHRASE} `, 'APPLY-FEE-POLICY free 0.0004 max 0.0004 tip 0.2']) {
      expect(() => assertFeePolicyApplyAllowed({ status: status(), confirm })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    }
  });

  it('refuses when no approved policy is configured, even with a phrase', () => {
    expect(() => assertFeePolicyApplyAllowed({ status: status({ fleetPolicyConfigured: false, approved: null }), confirm: PHRASE })).toThrow('FLEET_SPEND_POLICY_REQUIRED');
    expect(() => assertFeePolicyApplyAllowed({ status: status({ approved: null }), confirm: PHRASE })).toThrow('FLEET_SPEND_POLICY_REQUIRED');
  });
});

describe('live campaign tip and plain error text', () => {
  it('requires the tip to equal the stored one, because later campaigns read the stored tip', () => {
    expect(() => assertTipMatchesStoredPolicy(status({ stored: approved, matchesApproved: true }), 100_000_000n)).not.toThrow();
    expect(() => assertTipMatchesStoredPolicy(status({ stored: approved, matchesApproved: true }), 200_000_000n)).toThrow('TIP_DIFFERS_FROM_STORED_POLICY');
    expect(() => assertTipMatchesStoredPolicy(status({ stored: null }), 1n)).not.toThrow();
  });

  it('turns known codes into plain sentences and leaves other messages alone', () => {
    expect(plainFeePolicyMessage('FLEET_SPEND_POLICY_REQUIRED')).toContain('No approved spending policy');
    expect(plainFeePolicyMessage('CANONICAL_STORE_REQUIRED')).toContain('normal database store');
    expect(plainFeePolicyMessage('SOMETHING_ELSE: details')).toBe('SOMETHING_ELSE: details');
  });
});
