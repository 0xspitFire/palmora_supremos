import { describe, expect, it } from 'vitest';
import { assertCustodyReadiness, type CustodyReadiness } from './custody.js';
import {
  COMPENSATING_ASSURANCE_KIND,
  computeWalletSetDigest,
  COMPENSATING_CONTROL_IDS,
  assertCompensatingControls,
  describeCustodyAssurance,
  evaluateCompensatingControls,
  type CompensatingAssuranceConfig,
  type CompensatingControlsEvidence,
} from './compensating-controls.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RECORD = `sha256:${'a'.repeat(64)}`;
const LOCK = `sha256:${'c'.repeat(64)}`;
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const WALLET_SET = computeWalletSetDigest([W1, W2]);

const config = (over: Partial<CompensatingAssuranceConfig> = {}): CompensatingAssuranceConfig => ({
  ceilings: { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n } },
  expected: { recordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: LOCK },
  ...over,
});

const evidence = (over: Partial<CompensatingControlsEvidence> = {}): CompensatingControlsEvidence => ({
  version: 1,
  chainId: 1,
  recordDigest: RECORD,
  walletSetDigest: WALLET_SET,
  lockfileDigest: LOCK,
  balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: [{ address: W1, balanceWei: '300000000000000' }, { address: W2, balanceWei: '0' }] },
  policyRecord: { digest: RECORD, issuedAt: iso(-2 * DAY), expiresAt: iso(5 * DAY) },
  providerProbe: { observedAt: iso(-MIN), status: 'ok', policyRecordDigest: RECORD },
  signatureChecks: { transactionMatch: true, signerRecovery: true },
  rehearsal: { recordedAt: iso(-DAY), policyRecordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: LOCK, broadcastAttempted: false },
  driftResponse: { killSwitchOnDrift: true },
  ...over,
});

const refusal = (value: CompensatingControlsEvidence | undefined, cfg: CompensatingAssuranceConfig | null = config()): string => {
  try { assertCompensatingControls(value, cfg === null ? undefined : { config: cfg }, NOW); } catch (error) { return (error as Error).message; }
  return 'ACCEPTED';
};

describe('turnkey-compensating-controls (D-058, D-059)', () => {
  it('accepts only when all six controls are present and current', () => {
    expect(refusal(evidence())).toBe('ACCEPTED');
    const results = evaluateCompensatingControls(evidence(), config(), NOW);
    expect(results.map((result) => result.id)).toEqual([...COMPENSATING_CONTROL_IDS]);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('refuses every control when it is missing, and names the control', () => {
    const missing: Array<[keyof CompensatingControlsEvidence, string]> = [
      ['balances', 'COMPENSATING_CONTROL_BOUNDED_BALANCES_MISSING'],
      ['policyRecord', 'COMPENSATING_CONTROL_POLICY_RECORD_MISSING'],
      ['providerProbe', 'COMPENSATING_CONTROL_PROVIDER_PROBE_MISSING'],
      ['signatureChecks', 'COMPENSATING_CONTROL_SIGNATURE_VERIFICATION_MISSING'],
      ['rehearsal', 'COMPENSATING_CONTROL_REHEARSAL_MISSING'],
      ['driftResponse', 'COMPENSATING_CONTROL_DRIFT_RESPONSE_MISSING'],
    ];
    for (const [key, code] of missing) {
      const value = evidence();
      delete value[key];
      expect(refusal(value)).toBe(code);
    }
  });

  it('refuses when the evidence or the acceptance is absent (fail closed)', () => {
    expect(refusal(undefined)).toBe('COMPENSATING_CONTROL_EVIDENCE_REQUIRED');
    expect(refusal(evidence(), null)).toBe('CUSTODY_COMPENSATING_ASSURANCE_NOT_ACCEPTED');
    expect(refusal({ ...evidence(), version: 2 as never })).toBe('COMPENSATING_CONTROL_EVIDENCE_REQUIRED');
  });

  describe('balances (control 1)', () => {
    /** Builds evidence and configuration for exactly this fleet, so the signed wallet set matches what was observed. */
    const fleet = (wallets: Array<{ address: string; balanceWei: string }>, cfgOver: Partial<CompensatingAssuranceConfig> = {}, observedAt = iso(-MIN), expiresAt = iso(9 * MIN)) => {
      let digest: string;
      try { digest = computeWalletSetDigest(wallets.map((wallet) => wallet.address)); } catch { digest = computeWalletSetDigest([W1]); }
      return refusal(
        evidence({ walletSetDigest: digest, balances: { observedAt, expiresAt, wallets }, rehearsal: { recordedAt: iso(-DAY), policyRecordDigest: RECORD, walletSetDigest: digest, lockfileDigest: LOCK, broadcastAttempted: false } }),
        config({ expected: { recordDigest: RECORD, walletSetDigest: digest, lockfileDigest: LOCK }, ...cfgOver }),
      );
    };
    const one = (balanceWei: string) => [{ address: W1, balanceWei }];

    it('refuses a chain with no configured ceiling', () => {
      expect(refusal(evidence({ chainId: 8453 }))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_NO_BALANCE_CEILING_FOR_CHAIN');
      expect(refusal(evidence(), config({ ceilings: { 1: { walletMaxWei: 0n, fleetMaxWei: 0n } } }))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_NO_BALANCE_CEILING_FOR_CHAIN');
    });

    it('refuses a wallet above the idle ceiling and a fleet above the fleet ceiling', () => {
      expect(fleet(one('400000000000001'))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
      const six = Array.from({ length: 6 }, (_, index) => ({ address: `0x${String(index + 1).repeat(40)}`, balanceWei: '400000000000000' }));
      expect(fleet(six)).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_FLEET_ABOVE_LIMIT');
    });

    it('allows exactly the ceiling', () => {
      expect(fleet(one('400000000000000'))).toBe('ACCEPTED');
    });

    it('refuses balances that do not cover exactly the signed wallet set (a subset cannot understate the fleet)', () => {
      expect(refusal(evidence({ balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: one('0') } }))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_SET_MISMATCH');
      const extra = [{ address: W1, balanceWei: '0' }, { address: W2, balanceWei: '0' }, { address: '0x3333333333333333333333333333333333333333', balanceWei: '0' }];
      expect(refusal(evidence({ balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: extra } }))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_SET_MISMATCH');
    });

    it('refuses stale, future, expired or malformed observations', () => {
      expect(fleet(one('0'), {}, iso(-11 * MIN))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_STALE');
      expect(fleet(one('0'), {}, iso(MIN))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_STALE');
      expect(fleet(one('0'), {}, iso(-2 * MIN), iso(-MIN))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_STALE');
      expect(fleet(one('-1'))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_INVALID_BALANCE');
      expect(fleet([{ address: 'nope', balanceWei: '0' }])).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_INVALID_WALLET');
      expect(refusal(evidence({ balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets: [] } }))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_NO_WALLETS_OBSERVED');
      expect(fleet([{ address: W1, balanceWei: '0' }, { address: W1.toUpperCase().replace('0X', '0x'), balanceWei: '0' }])).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_DUPLICATE_WALLET');
    });

    it('lets a funded run hold its own envelope above the idle ceiling but never above the chain bound, and never lowers the idle ceiling', () => {
      const bounded = { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n, runEnvelopeMaxWei: 1_000_000_000_000_000n } };
      const withEnvelope = { ceilings: bounded, runEnvelopeWei: { [W1]: '900000000000000' } };
      expect(fleet(one('900000000000000'), withEnvelope)).toBe('ACCEPTED');
      expect(fleet(one('900000000000001'), withEnvelope)).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
      expect(fleet(one('900000000000000'))).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
      // an envelope request above the chain's hard bound is clipped to the bound
      expect(fleet(one('1000000000000000'), { ceilings: bounded, runEnvelopeWei: { [W1]: '5000000000000000' } })).toBe('ACCEPTED');
      expect(fleet(one('1000000000000001'), { ceilings: bounded, runEnvelopeWei: { [W1]: '5000000000000000' } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
      // without a configured hard bound an envelope cannot raise the idle ceiling at all
      expect(fleet(one('400000000000001'), { runEnvelopeWei: { [W1]: '900000000000000' } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
      expect(fleet(one('400000000000000'), { ceilings: bounded, runEnvelopeWei: { [W1]: '1' } })).toBe('ACCEPTED');
      expect(fleet(one('900000000000000'), { ceilings: bounded, runEnvelopeWei: { [W2]: '900000000000000' } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
    });
  });

  describe('funded-run requirements (D-059 item 3)', () => {
    const fleetOf = (wallets: Array<{ address: string; balanceWei: string }>, cfgOver: Partial<CompensatingAssuranceConfig>) => {
      const digest = computeWalletSetDigest(wallets.map((wallet) => wallet.address));
      return refusal(
        evidence({ walletSetDigest: digest, balances: { observedAt: iso(-MIN), expiresAt: iso(9 * MIN), wallets }, rehearsal: { recordedAt: iso(-DAY), policyRecordDigest: RECORD, walletSetDigest: digest, lockfileDigest: LOCK, broadcastAttempted: false } }),
        config({ expected: { recordDigest: RECORD, walletSetDigest: digest, lockfileDigest: LOCK }, ...cfgOver }),
      );
    };
    const bounded = { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n, runEnvelopeMaxWei: 1_000_000_000_000_000n, runEnvelopeFleetMaxWei: 2_500_000_000_000_000n } };
    const many = (count: number, balanceWei: string) => Array.from({ length: count }, (_, index) => ({ address: `0x${String(index + 1).repeat(40)}`, balanceWei }));
    const envelopes = (wallets: Array<{ address: string }>, value: string) => Object.fromEntries(wallets.map((wallet) => [wallet.address.toLowerCase(), value]));

    it('refuses to arm until the requested funding has arrived, and accepts exactly the requirement', () => {
      const minimumBalanceWei = { [W1]: '300000000000000' };
      expect(fleetOf([{ address: W1, balanceWei: '299999999999999' }], { minimumBalanceWei })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_FUNDING_NOT_ARRIVED');
      expect(fleetOf([{ address: W1, balanceWei: '300000000000000' }], { minimumBalanceWei })).toBe('ACCEPTED');
      expect(fleetOf([{ address: W1, balanceWei: '300000000000000' }], { minimumBalanceWei: { [W1]: 'abc' } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_INVALID_MINIMUM');
    });

    it('bounds the whole fleet while funded, and without a fleet bound the idle fleet ceiling cannot be raised', () => {
      const four = many(4, '600000000000000');
      expect(fleetOf(four, { ceilings: bounded, runEnvelopeWei: envelopes(four, '600000000000000') })).toBe('ACCEPTED');
      const five = many(5, '600000000000000');
      expect(fleetOf(five, { ceilings: bounded, runEnvelopeWei: envelopes(five, '600000000000000') })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_FLEET_ABOVE_LIMIT');
      const noFleetBound = { 1: { ...bounded[1], runEnvelopeFleetMaxWei: undefined } };
      expect(fleetOf(four, { ceilings: noFleetBound as never, runEnvelopeWei: envelopes(four, '600000000000000') })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_FLEET_ABOVE_LIMIT');
    });

    it('a hard envelope bound below the idle ceiling never lowers the idle ceiling', () => {
      const low = { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n, runEnvelopeMaxWei: 1n } };
      expect(fleetOf([{ address: W1, balanceWei: '400000000000000' }], { ceilings: low, runEnvelopeWei: { [W1]: '900000000000000' } })).toBe('ACCEPTED');
      expect(fleetOf([{ address: W1, balanceWei: '400000000000001' }], { ceilings: low, runEnvelopeWei: { [W1]: '900000000000000' } })).toBe('COMPENSATING_CONTROL_BOUNDED_BALANCES_WALLET_ABOVE_LIMIT');
    });
  });

  describe('policy record (control 2)', () => {
    it('refuses an expired, mismatched or not-yet-issued record', () => {
      expect(refusal(evidence({ policyRecord: { digest: RECORD, issuedAt: iso(-2 * DAY), expiresAt: iso(-MIN) } }))).toBe('COMPENSATING_CONTROL_POLICY_RECORD_EXPIRED');
      expect(refusal(evidence({ policyRecord: { digest: `sha256:${'e'.repeat(64)}`, issuedAt: iso(-DAY), expiresAt: iso(DAY) } }))).toBe('COMPENSATING_CONTROL_POLICY_RECORD_DIGEST_MISMATCH');
      expect(refusal(evidence({ recordDigest: `sha256:${'e'.repeat(64)}` }))).toBe('COMPENSATING_CONTROL_POLICY_RECORD_DIGEST_MISMATCH');
      expect(refusal(evidence({ walletSetDigest: `sha256:${'e'.repeat(64)}` }))).toBe('COMPENSATING_CONTROL_POLICY_RECORD_WALLET_SET_MISMATCH');
      expect(refusal(evidence({ policyRecord: { digest: RECORD, issuedAt: iso(MIN), expiresAt: iso(DAY) } }))).toBe('COMPENSATING_CONTROL_POLICY_RECORD_INVALID_TIME');
    });
  });

  describe('provider probe (control 3)', () => {
    it('refuses a stale, not-ok or other-record probe', () => {
      expect(refusal(evidence({ providerProbe: { observedAt: iso(-11 * MIN), status: 'ok', policyRecordDigest: RECORD } }))).toBe('COMPENSATING_CONTROL_PROVIDER_PROBE_STALE');
      expect(refusal(evidence({ providerProbe: { observedAt: iso(-MIN), status: 'failed' as never, policyRecordDigest: RECORD } }))).toBe('COMPENSATING_CONTROL_PROVIDER_PROBE_NOT_OK');
      expect(refusal(evidence({ providerProbe: { observedAt: iso(-MIN), status: 'ok', policyRecordDigest: `sha256:${'e'.repeat(64)}` } }))).toBe('COMPENSATING_CONTROL_PROVIDER_PROBE_DIGEST_MISMATCH');
    });
  });

  describe('signature verification (control 4) and drift response (control 7)', () => {
    it('refuses when the signer does not enforce transaction match and signer recovery, or the kill switch is not tied to drift', () => {
      expect(refusal(evidence({ signatureChecks: { transactionMatch: true, signerRecovery: false } }))).toBe('COMPENSATING_CONTROL_SIGNATURE_VERIFICATION_NOT_ENFORCED');
      expect(refusal(evidence({ signatureChecks: { transactionMatch: false, signerRecovery: true } }))).toBe('COMPENSATING_CONTROL_SIGNATURE_VERIFICATION_NOT_ENFORCED');
      expect(refusal(evidence({ driftResponse: { killSwitchOnDrift: false } }))).toBe('COMPENSATING_CONTROL_DRIFT_RESPONSE_NOT_ENFORCED');
    });
  });

  describe('rehearsal (control 5)', () => {
    it('refuses a rehearsal that is older than the record, was for another record, wallet set or dependencies, or broadcast', () => {
      const base = { recordedAt: iso(-DAY), policyRecordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: LOCK, broadcastAttempted: false };
      expect(refusal(evidence({ rehearsal: { ...base, recordedAt: iso(-3 * DAY) } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_OLDER_THAN_RECORD');
      expect(refusal(evidence({ rehearsal: { ...base, policyRecordDigest: `sha256:${'e'.repeat(64)}` } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_DIGEST_MISMATCH');
      expect(refusal(evidence({ rehearsal: { ...base, walletSetDigest: `sha256:${'e'.repeat(64)}` } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_WALLET_SET_MISMATCH');
      expect(refusal(evidence({ rehearsal: { ...base, lockfileDigest: `sha256:${'e'.repeat(64)}` } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_DEPENDENCIES_CHANGED');
      expect(refusal(evidence({ rehearsal: { ...base, broadcastAttempted: true } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_BROADCAST_ATTEMPTED');
    });

    it('is invalidated when the dependency lockfile changes after the rehearsal', () => {
      expect(refusal(evidence(), config({ expected: { recordDigest: RECORD, walletSetDigest: WALLET_SET, lockfileDigest: `sha256:${'f'.repeat(64)}` } }))).toBe('COMPENSATING_CONTROL_REHEARSAL_DEPENDENCIES_CHANGED');
    });
  });

  describe('Trust Center review (removed, D-071)', () => {
    it('is no longer one of the controls, and nothing about a review is needed to arm', () => {
      expect([...COMPENSATING_CONTROL_IDS]).not.toContain('trust-center-review');
      expect(COMPENSATING_CONTROL_IDS).toHaveLength(6);
      expect(refusal(evidence())).toBe('ACCEPTED');
    });
  });

  describe('custody integration', () => {
    const custody = (over: Partial<CustodyReadiness> = {}): CustodyReadiness => ({
      provider: 'turnkey',
      providerIdentity: 'turnkey-org',
      policyReference: 'turnkey:policy-1',
      policyDigest: `0x${'1'.repeat(64)}`,
      policyStatus: 'approved',
      healthStatus: 'healthy',
      attestationStatus: 'unknown',
      evidenceId: 'evidence-1',
      observedAt: iso(-MIN),
      expiresAt: iso(10 * MIN),
      assuranceKind: COMPENSATING_ASSURANCE_KIND,
      compensatingControls: evidence(),
      ...over,
    });
    const binding = { provider: 'turnkey' as const, providerIdentity: 'turnkey-org', policyReference: 'turnkey:policy-1', policyDigest: `0x${'1'.repeat(64)}` };
    const check = (value: CustodyReadiness, ctx?: Parameters<typeof assertCustodyReadiness>[4], expected: typeof binding | null = binding): string => {
      try { assertCustodyReadiness(value, NOW, expected ?? undefined, undefined, ctx); } catch (error) { return (error as Error).message; }
      return 'ACCEPTED';
    };
    const accepted = { config: config(), chainId: 1, wallets: [W1, W2] };

    it('is refused unless the service explicitly accepts the compensated kind', () => {
      expect(check(custody())).toBe('CUSTODY_COMPENSATING_ASSURANCE_NOT_ACCEPTED');
      expect(check(custody(), accepted)).toBe('ACCEPTED');
    });

    it('requires the expected policy binding for the compensated kind, and still enforces it', () => {
      expect(check(custody(), accepted, null)).toBe('CUSTODY_EXPECTED_POLICY_REQUIRED');
      expect(check(custody(), accepted, { ...binding, policyDigest: `0x${'2'.repeat(64)}` })).toBe('CUSTODY_POLICY_MISMATCH');
    });

    it('refuses an empty armed wallet list (nothing would be checked)', () => {
      expect(check(custody(), { ...accepted, wallets: [] })).toBe('COMPENSATING_CONTROL_WALLETS_REQUIRED');
    });

    it('is never accepted as TVC verified, or for another provider, or under an unknown kind', () => {
      expect(check(custody({ attestationStatus: 'verified' }), accepted)).toBe('CUSTODY_COMPENSATED_MUST_NOT_CLAIM_TVC');
      expect(check(custody({ provider: 'kms', policyReference: 'kms:key-1' }), accepted)).toBe('CUSTODY_COMPENSATING_ASSURANCE_PROVIDER_MISMATCH');
      expect(check(custody({ assuranceKind: 'something-else' as never }), accepted)).toBe('CUSTODY_ASSURANCE_KIND_UNKNOWN');
    });

    it('does not weaken the legacy path: TVC attestation is still required without the compensated kind', () => {
      const legacy = custody({ assuranceKind: undefined, compensatingControls: undefined });
      expect(check(legacy, accepted)).toBe('CUSTODY_ATTESTATION_REQUIRED');
      expect(check({ ...legacy, attestationStatus: 'verified' }, accepted)).toBe('ACCEPTED');
    });

    it('binds the evidence to the campaign chain and wallets', () => {
      expect(check(custody(), { ...accepted, chainId: 8453 })).toBe('COMPENSATING_CONTROL_CHAIN_MISMATCH');
      expect(check(custody(), { ...accepted, wallets: [W1, '0x3333333333333333333333333333333333333333'] })).toBe('COMPENSATING_CONTROL_WALLET_NOT_COVERED');
    });

    it('still requires an approved policy and healthy provider, and one missing control invalidates the profile', () => {
      expect(check(custody({ policyStatus: 'rejected' }), accepted)).toBe('CUSTODY_POLICY_NOT_APPROVED');
      expect(check(custody({ healthStatus: 'unhealthy' }), accepted)).toBe('CUSTODY_HEALTH_NOT_READY');
      const value = evidence();
      delete value.rehearsal;
      expect(check(custody({ compensatingControls: value }), accepted)).toBe('COMPENSATING_CONTROL_REHEARSAL_MISSING');
    });
  });

  it('never describes the compensated profile as TVC verified', () => {
    expect(describeCustodyAssurance(COMPENSATING_ASSURANCE_KIND, 'unknown')).toBe('Compensating controls (not TVC attestation)');
    expect(describeCustodyAssurance(COMPENSATING_ASSURANCE_KIND, 'verified')).not.toMatch(/TVC attestation verified/);
    expect(describeCustodyAssurance(undefined, 'verified')).toBe('TVC attestation verified');
  });
});
