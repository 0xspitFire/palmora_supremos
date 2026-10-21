/**
 * D-058 / D-059: `turnkey-compensating-controls` custody assurance.
 *
 * This is NOT Turnkey Verifiable Cloud (TVC) attestation and must never be displayed or interpreted as "TVC verified".
 * It is valid only when ALL seven controls are present and current. A missing, stale, mismatched or unknown control makes the
 * whole profile invalid and the refusal names that control. Nothing here weakens a cap, reservation, simulation, kill switch,
 * finality or custody rule; it only adds conditions that must hold before a Turnkey-custodied live run may arm.
 *
 * Wei amounts travel as decimal strings so the evidence survives JSON persistence.
 */
export const COMPENSATING_ASSURANCE_KIND = 'turnkey-compensating-controls' as const;

export const COMPENSATING_CONTROL_IDS = [
  'bounded-balances',
  'policy-record',
  'provider-probe',
  'signature-verification',
  'rehearsal',
  'trust-center-review',
  'drift-response',
] as const;
export type CompensatingControlId = (typeof COMPENSATING_CONTROL_IDS)[number];

/** Balance and probe observations must be this fresh when a run arms or executes. */
export const COMPENSATING_OBSERVATION_MAX_AGE_MS = 10 * 60 * 1000;
/** The Trust Center review is valid for 90 days plus a fixed seven-day grace period. */
export const TRUST_CENTER_REVIEW_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const TRUST_CENTER_REVIEW_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BalanceCeiling { walletMaxWei: bigint; fleetMaxWei: bigint }
/** Per chain id, in that chain's native unit. A chain with no entry cannot arm. */
export type BalanceCeilings = Readonly<Record<number, BalanceCeiling>>;

export interface CompensatingControlsEvidence {
  version: 1;
  chainId: number;
  /** Digest of the owner-signed canonical policy record this evidence belongs to. */
  recordDigest: string;
  /** Digest of the exact wallet set (sorted lowercase addresses) the record covers. */
  walletSetDigest: string;
  /** Digest of the dependency lockfile, so an SDK or provider-library change invalidates the rehearsal. */
  lockfileDigest: string;
  balances?: { observedAt: string; expiresAt: string; wallets: Array<{ address: string; balanceWei: string }> };
  policyRecord?: { digest: string; issuedAt: string; expiresAt: string };
  providerProbe?: { observedAt: string; status: 'ok'; policyRecordDigest: string };
  signatureChecks?: { transactionMatch: boolean; signerRecovery: boolean };
  rehearsal?: { recordedAt: string; policyRecordDigest: string; walletSetDigest: string; lockfileDigest: string; broadcastAttempted: boolean };
  trustCenter?: { reviewedAt: string; documents: Array<{ name: string; date: string; sha256: string }> };
  driftResponse?: { killSwitchOnDrift: boolean };
}

/** What the arming code expects, supplied by the service configuration (never by the evidence itself). */
export interface CompensatingAssuranceConfig {
  ceilings: BalanceCeilings;
  /** Normally the same digests the owner-signed record was created from. */
  expected: { recordDigest: string; walletSetDigest: string; lockfileDigest: string };
  /**
   * Wallets (lowercase address) that a funded run may hold above the idle ceiling, with the run's own envelope in wei.
   * Absent means the idle ceilings apply (D-059 item 2). The funding envelope itself is built by a later task.
   */
  runEnvelopeWei?: Readonly<Record<string, string>>;
}

/** What a caller knows about the run being armed or executed. The chain and the wallets come from the campaign, never from the evidence. */
export interface CompensatingAssuranceContext {
  config: CompensatingAssuranceConfig;
  chainId?: number;
  wallets?: readonly string[];
}

export interface ControlResult { id: CompensatingControlId; ok: boolean; reason?: string }

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const HEX_SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d{1,40}$/;

const time = (value: unknown): number | undefined => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);
const sameDigest = (left: string | undefined, right: string | undefined): boolean => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

function bigintOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : undefined;
}

function checkBalances(evidence: CompensatingControlsEvidence, config: CompensatingAssuranceConfig, now: number): string | undefined {
  const ceiling = config.ceilings[evidence.chainId];
  if (!ceiling || ceiling.walletMaxWei <= 0n || ceiling.fleetMaxWei <= 0n) return 'NO_BALANCE_CEILING_FOR_CHAIN';
  const balances = evidence.balances;
  if (!balances) return 'MISSING';
  const observed = time(balances.observedAt);
  const expires = time(balances.expiresAt);
  if (observed === undefined || expires === undefined || expires <= now || observed > now || expires <= observed) return 'STALE';
  if (now - observed > COMPENSATING_OBSERVATION_MAX_AGE_MS) return 'STALE';
  if (!Array.isArray(balances.wallets) || balances.wallets.length === 0) return 'NO_WALLETS_OBSERVED';
  const seen = new Set<string>();
  let fleet = 0n;
  for (const wallet of balances.wallets) {
    if (!wallet || typeof wallet.address !== 'string' || !ADDRESS.test(wallet.address)) return 'INVALID_WALLET';
    const address = wallet.address.toLowerCase();
    if (seen.has(address)) return 'DUPLICATE_WALLET';
    seen.add(address);
    const balance = bigintOf(wallet.balanceWei);
    if (balance === undefined) return 'INVALID_BALANCE';
    const envelope = bigintOf(config.runEnvelopeWei?.[address]);
    const walletLimit = envelope !== undefined && envelope > ceiling.walletMaxWei ? envelope : ceiling.walletMaxWei;
    if (balance > walletLimit) return 'WALLET_ABOVE_LIMIT';
    fleet += balance;
  }
  let fleetLimit = ceiling.fleetMaxWei;
  if (config.runEnvelopeWei) {
    let envelopeTotal = 0n;
    for (const address of seen) {
      const envelope = bigintOf(config.runEnvelopeWei[address]);
      envelopeTotal += envelope !== undefined && envelope > ceiling.walletMaxWei ? envelope : ceiling.walletMaxWei;
    }
    if (envelopeTotal > fleetLimit) fleetLimit = envelopeTotal;
  }
  if (fleet > fleetLimit) return 'FLEET_ABOVE_LIMIT';
  return undefined;
}

function checkPolicyRecord(evidence: CompensatingControlsEvidence, config: CompensatingAssuranceConfig, now: number): string | undefined {
  const record = evidence.policyRecord;
  if (!record) return 'MISSING';
  if (!SHA256.test(record.digest) || !sameDigest(record.digest, config.expected.recordDigest) || !sameDigest(evidence.recordDigest, config.expected.recordDigest)) return 'DIGEST_MISMATCH';
  if (!sameDigest(evidence.walletSetDigest, config.expected.walletSetDigest)) return 'WALLET_SET_MISMATCH';
  const issued = time(record.issuedAt);
  const expires = time(record.expiresAt);
  if (issued === undefined || expires === undefined || expires <= issued || issued > now) return 'INVALID_TIME';
  if (expires <= now) return 'EXPIRED';
  return undefined;
}

function checkProbe(evidence: CompensatingControlsEvidence, config: CompensatingAssuranceConfig, now: number): string | undefined {
  const probe = evidence.providerProbe;
  if (!probe) return 'MISSING';
  if (probe.status !== 'ok') return 'NOT_OK';
  if (!sameDigest(probe.policyRecordDigest, config.expected.recordDigest)) return 'DIGEST_MISMATCH';
  const observed = time(probe.observedAt);
  if (observed === undefined || observed > now) return 'INVALID_TIME';
  if (now - observed > COMPENSATING_OBSERVATION_MAX_AGE_MS) return 'STALE';
  return undefined;
}

function checkSignatureChecks(evidence: CompensatingControlsEvidence): string | undefined {
  const checks = evidence.signatureChecks;
  if (!checks) return 'MISSING';
  if (checks.transactionMatch !== true || checks.signerRecovery !== true) return 'NOT_ENFORCED';
  return undefined;
}

function checkRehearsal(evidence: CompensatingControlsEvidence, config: CompensatingAssuranceConfig, now: number): string | undefined {
  const rehearsal = evidence.rehearsal;
  if (!rehearsal) return 'MISSING';
  if (rehearsal.broadcastAttempted !== false) return 'BROADCAST_ATTEMPTED';
  if (!sameDigest(rehearsal.policyRecordDigest, config.expected.recordDigest)) return 'DIGEST_MISMATCH';
  if (!sameDigest(rehearsal.walletSetDigest, config.expected.walletSetDigest)) return 'WALLET_SET_MISMATCH';
  if (!sameDigest(rehearsal.lockfileDigest, config.expected.lockfileDigest) || !sameDigest(evidence.lockfileDigest, config.expected.lockfileDigest)) return 'DEPENDENCIES_CHANGED';
  const recorded = time(rehearsal.recordedAt);
  const issued = time(evidence.policyRecord?.issuedAt);
  if (recorded === undefined || recorded > now) return 'INVALID_TIME';
  if (issued === undefined || recorded < issued) return 'OLDER_THAN_RECORD';
  return undefined;
}

function checkTrustCenter(evidence: CompensatingControlsEvidence, now: number): string | undefined {
  const review = evidence.trustCenter;
  if (!review) return 'MISSING';
  const reviewed = time(review.reviewedAt);
  if (reviewed === undefined || reviewed > now) return 'INVALID_TIME';
  if (now - reviewed > TRUST_CENTER_REVIEW_MAX_AGE_MS + TRUST_CENTER_REVIEW_GRACE_MS) return 'EXPIRED';
  if (!Array.isArray(review.documents) || review.documents.length === 0) return 'NO_DOCUMENTS';
  for (const document of review.documents) {
    if (!document || typeof document.name !== 'string' || !document.name || document.name.length > 200 || /[\r\n]/.test(document.name)) return 'INVALID_DOCUMENT';
    if (time(document.date) === undefined || typeof document.sha256 !== 'string' || !HEX_SHA256.test(document.sha256)) return 'INVALID_DOCUMENT';
  }
  return undefined;
}

function checkDriftResponse(evidence: CompensatingControlsEvidence): string | undefined {
  if (!evidence.driftResponse) return 'MISSING';
  if (evidence.driftResponse.killSwitchOnDrift !== true) return 'NOT_ENFORCED';
  return undefined;
}

/** Evaluates every control and returns one result each, so a readout can name exactly what is missing. Never throws. */
export function evaluateCompensatingControls(evidence: CompensatingControlsEvidence | undefined, config: CompensatingAssuranceConfig, nowDate = new Date()): ControlResult[] {
  const now = nowDate.getTime();
  const run = (id: CompensatingControlId, check: () => string | undefined): ControlResult => {
    if (!evidence) return { id, ok: false, reason: 'MISSING' };
    let reason: string | undefined;
    try { reason = check(); } catch { reason = 'INVALID'; }
    return reason === undefined ? { id, ok: true } : { id, ok: false, reason };
  };
  return [
    run('bounded-balances', () => checkBalances(evidence!, config, now)),
    run('policy-record', () => checkPolicyRecord(evidence!, config, now)),
    run('provider-probe', () => checkProbe(evidence!, config, now)),
    run('signature-verification', () => checkSignatureChecks(evidence!)),
    run('rehearsal', () => checkRehearsal(evidence!, config, now)),
    run('trust-center-review', () => checkTrustCenter(evidence!, now)),
    run('drift-response', () => checkDriftResponse(evidence!)),
  ];
}

/** Fails closed unless all seven controls are current. The error names the first failing control. */
export function assertCompensatingControls(evidence: CompensatingControlsEvidence | undefined, context: CompensatingAssuranceContext | undefined, nowDate = new Date()): void {
  if (!context) throw new Error('CUSTODY_COMPENSATING_ASSURANCE_NOT_ACCEPTED');
  const config = context.config;
  if (!evidence || evidence.version !== 1) throw new Error('COMPENSATING_CONTROL_EVIDENCE_REQUIRED');
  if (typeof evidence.chainId !== 'number' || !Number.isInteger(evidence.chainId)) throw new Error('COMPENSATING_CONTROL_CHAIN_REQUIRED');
  if (context.chainId !== undefined && evidence.chainId !== context.chainId) throw new Error('COMPENSATING_CONTROL_CHAIN_MISMATCH');
  if (context.wallets) {
    const observed = new Set((evidence.balances?.wallets ?? []).map((wallet) => String(wallet?.address).toLowerCase()));
    if (context.wallets.some((wallet) => !observed.has(wallet.toLowerCase()))) throw new Error('COMPENSATING_CONTROL_WALLET_NOT_COVERED');
  }
  const failed = evaluateCompensatingControls(evidence, config, nowDate).find((result) => !result.ok);
  if (failed) throw new Error(`COMPENSATING_CONTROL_${failed.id.toUpperCase().replace(/-/g, '_')}_${failed.reason ?? 'FAILED'}`);
}

/** Plain label for any display of custody assurance. The compensated profile is never described as TVC verified. */
export function describeCustodyAssurance(kind: string | undefined, attestationStatus: string): string {
  if (kind === COMPENSATING_ASSURANCE_KIND) return 'Compensating controls (not TVC attestation)';
  return attestationStatus === 'verified' ? 'TVC attestation verified' : `TVC attestation ${attestationStatus}`;
}
