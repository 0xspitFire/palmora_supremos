import type { OperationalReadiness } from './types.js';

export type ApprovedCustodyProvider = 'turnkey' | 'kms';
export type CustodyProvider = ApprovedCustodyProvider | 'local' | 'custom';
export type CustodyHealthStatus = 'healthy' | 'unhealthy' | 'unknown';
export type CustodyAttestationStatus = 'verified' | 'failed' | 'unknown';
export type CustodyPolicyStatus = 'approved' | 'rejected' | 'unknown';

/** Non-secret, provider-bound evidence emitted by a custody health probe. */
export interface CustodyReadiness {
  provider: CustodyProvider;
  providerIdentity: string;
  policyReference: string;
  policyDigest: string;
  policyStatus: CustodyPolicyStatus;
  healthStatus: CustodyHealthStatus;
  attestationStatus: CustodyAttestationStatus;
  evidenceId: string;
  observedAt: string;
  expiresAt: string;
}

export interface CustodyPolicyBinding {
  provider: ApprovedCustodyProvider;
  providerIdentity: string;
  policyReference: string;
  policyDigest: string;
}

const DIGEST = /^0x[0-9a-f]{64}$/i;
const SECRET_NAME = /(?:private|secret|credential|token|password|mnemonic|seed|api[_-]?key)/i;

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertReference(value: string, code: string): void {
  if (!value || value.length > 256 || /[\r\n]/.test(value) || SECRET_NAME.test(value)) throw new Error(code);
}

export function assertCustodyReadiness(
  evidence: CustodyReadiness | undefined,
  now = new Date(),
  expected?: CustodyPolicyBinding,
): void {
  if (!evidence) throw new Error('CUSTODY_EVIDENCE_REQUIRED');
  if (evidence.provider !== 'turnkey' && evidence.provider !== 'kms') throw new Error('CUSTODY_PROVIDER_UNAPPROVED');
  assertReference(evidence.providerIdentity, 'CUSTODY_PROVIDER_IDENTITY_REQUIRED');
  assertReference(evidence.policyReference, 'CUSTODY_POLICY_REFERENCE_REQUIRED');
  const policyPrefix = evidence.provider === 'turnkey' ? /^turnkey[:\/-]/i : /^(?:kms|aws-kms)[:\/-]/i;
  if (!policyPrefix.test(evidence.policyReference)) throw new Error('CUSTODY_POLICY_PROVIDER_MISMATCH');
  if (!DIGEST.test(evidence.policyDigest)) throw new Error('CUSTODY_POLICY_DIGEST_REQUIRED');
  if (evidence.policyStatus !== 'approved') throw new Error('CUSTODY_POLICY_NOT_APPROVED');
  if (evidence.healthStatus !== 'healthy') throw new Error('CUSTODY_HEALTH_NOT_READY');
  if (evidence.attestationStatus !== 'verified') throw new Error('CUSTODY_ATTESTATION_REQUIRED');
  assertReference(evidence.evidenceId, 'CUSTODY_EVIDENCE_ID_REQUIRED');
  if (!validTimestamp(evidence.observedAt) || !validTimestamp(evidence.expiresAt)) throw new Error('CUSTODY_EVIDENCE_TIME_INVALID');
  const observed = Date.parse(evidence.observedAt);
  const expires = Date.parse(evidence.expiresAt);
  if (expires <= now.getTime() || observed > now.getTime() || expires <= observed) throw new Error('CUSTODY_EVIDENCE_STALE');
  if (expected) {
    if (evidence.provider !== expected.provider || evidence.providerIdentity !== expected.providerIdentity) throw new Error('CUSTODY_PROVIDER_MISMATCH');
    if (evidence.policyReference !== expected.policyReference || evidence.policyDigest.toLowerCase() !== expected.policyDigest.toLowerCase()) throw new Error('CUSTODY_POLICY_MISMATCH');
  }
}

export function assertLiveOperationalReadiness(
  operational: OperationalReadiness | undefined,
  now = new Date(),
  expected?: CustodyPolicyBinding,
): void {
  if (!operational) throw new Error('RUNTIME_READINESS_REQUIRED');
  if (operational.signerReady !== true) throw new Error('SIGNER_NOT_READY');
  assertCustodyReadiness(operational.custody, now, expected);
  if (operational.killSwitchEngaged) throw new Error('KILL_SWITCH_ENGAGED');
  if (!operational.notificationReady) throw new Error('NOTIFICATION_NOT_READY');
  if (operational.chainVerification !== 'verified') throw new Error('CHAIN_VERIFICATION_REQUIRED');
  if (!validTimestamp(operational.observedAt) || !validTimestamp(operational.expiresAt) || Date.parse(operational.expiresAt) <= now.getTime()) throw new Error('RUNTIME_PROBE_STALE');
  if (!validTimestamp(operational.lastReconciliationAt) || Date.parse(operational.lastReconciliationAt) > now.getTime()) throw new Error('RECONCILIATION_REQUIRED');
}
