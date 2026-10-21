import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COMPENSATING_CONTROL_IDS,
  computeWalletSetDigest,
  evaluateCompensatingControls,
  type CompensatingAssuranceConfig,
  type CompensatingControlsEvidence,
  type ControlResult,
} from '@mint-bot/backend';

/**
 * D-058 / D-059 evidence assembly for `turnkey-compensating-controls`. Everything here is read-only except
 * `engageKillSwitchFile`, which only ever makes the system safer. Nothing here signs, broadcasts, funds or enables anything.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Digest of the exact wallet set (same function the arm gate uses). */
export const walletSetDigest = computeWalletSetDigest;

/** Digest of the dependency lockfile at the project root, so an SDK or provider-library change invalidates the rehearsal. */
export async function lockfileDigest(projectRoot: string): Promise<string> {
  const content = await readFile(join(projectRoot, 'pnpm-lock.yaml')).catch(() => undefined);
  if (!content || content.length === 0) throw new Error('COMPENSATING_LOCKFILE_UNAVAILABLE');
  return `sha256:${sha256Hex(content)}`;
}

export interface TrustCenterRecord {
  version: 1;
  type: 'turnkey-trust-center-review';
  reviewedAt: string;
  documents: Array<{ name: string; date: string; sha256: string }>;
}

/** Only names, dates and digests are kept. The documents themselves are never stored. */
export function createTrustCenterRecord(input: { reviewedAt: string; documents: ReadonlyArray<{ name: string; date: string; bytes: Uint8Array }> }): TrustCenterRecord {
  if (!Number.isFinite(Date.parse(input.reviewedAt))) throw new Error('TRUST_CENTER_REVIEW_TIME_INVALID');
  if (input.documents.length === 0 || input.documents.length > 20) throw new Error('TRUST_CENTER_DOCUMENTS_REQUIRED');
  return {
    version: 1,
    type: 'turnkey-trust-center-review',
    reviewedAt: new Date(input.reviewedAt).toISOString(),
    documents: input.documents.map((document) => {
      if (!document.name || document.name.length > 200 || /[\r\n]/.test(document.name)) throw new Error('TRUST_CENTER_DOCUMENT_NAME_INVALID');
      if (!Number.isFinite(Date.parse(document.date))) throw new Error('TRUST_CENTER_DOCUMENT_DATE_INVALID');
      if (document.bytes.length === 0) throw new Error('TRUST_CENTER_DOCUMENT_EMPTY');
      return { name: document.name, date: new Date(document.date).toISOString(), sha256: sha256Hex(document.bytes) };
    }),
  };
}

export function parseTrustCenterRecord(value: unknown): TrustCenterRecord {
  const record = value as Partial<TrustCenterRecord> | null;
  if (!record || record.version !== 1 || record.type !== 'turnkey-trust-center-review' || typeof record.reviewedAt !== 'string' || !Array.isArray(record.documents)) throw new Error('TRUST_CENTER_RECORD_INVALID');
  for (const document of record.documents) {
    if (!document || typeof document.name !== 'string' || typeof document.date !== 'string' || typeof document.sha256 !== 'string' || !SHA256_HEX.test(document.sha256)) throw new Error('TRUST_CENTER_RECORD_INVALID');
  }
  return record as TrustCenterRecord;
}

export interface RehearsalEvidence {
  recordedAt: string;
  policyRecordDigest: string;
  walletSetDigest: string;
  lockfileDigest: string;
  broadcastAttempted: boolean;
}

/** Reads the rehearsal evidence file written by `turnkey-signing-rehearsal`. Older files without the two digests are not accepted. */
export function parseRehearsalEvidence(value: unknown): RehearsalEvidence {
  const evidence = value as { type?: unknown; recordedAt?: unknown; policyRecordDigest?: unknown; walletSetDigest?: unknown; lockfileDigest?: unknown; safety?: { broadcastAttempted?: unknown } } | null;
  if (!evidence || evidence.type !== 'turnkey-signing-rehearsal') throw new Error('REHEARSAL_EVIDENCE_INVALID');
  if (typeof evidence.recordedAt !== 'string' || typeof evidence.policyRecordDigest !== 'string' || typeof evidence.walletSetDigest !== 'string' || typeof evidence.lockfileDigest !== 'string') throw new Error('REHEARSAL_EVIDENCE_NEEDS_REPEAT');
  return { recordedAt: evidence.recordedAt, policyRecordDigest: evidence.policyRecordDigest, walletSetDigest: evidence.walletSetDigest, lockfileDigest: evidence.lockfileDigest, broadcastAttempted: evidence.safety?.broadcastAttempted !== false };
}

/** The Turnkey signer enforces both checks on every signature (turnkey-signer.ts: exact transaction match, recovered signer). */
export const TURNKEY_SIGNER_ENFORCES = { transactionMatch: true, signerRecovery: true } as const;

/**
 * Runs the provider probe. ANY failure (policy, key, identity or evidence drift, an expired record, or an unreachable provider)
 * engages the kill switch before the error is raised, which is D-058 control 7. The evidence it returns is only the fact that
 * the probe succeeded just now for this record.
 */
export async function probeOrEngageKillSwitch(
  probe: () => Promise<{ status: 'ok'; policyRecordDigest: string }>,
  engage: (reason: string) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<{ observedAt: string; status: 'ok'; policyRecordDigest: string }> {
  try {
    const report = await probe();
    if (report.status !== 'ok') throw new Error('TURNKEY_PROBE_NOT_OK');
    return { observedAt: now().toISOString(), status: 'ok', policyRecordDigest: report.policyRecordDigest };
  } catch (error) {
    // A fixed reason code only: provider error text is never written to the kill-switch file.
    void error;
    await engage('provider-probe-failed').catch(() => undefined);
    throw new Error('TURNKEY_PROVIDER_DRIFT_KILL_SWITCH_ENGAGED');
  }
}

/** Writes the kill-switch file if it is not there yet. Existing files are left untouched. */
export async function engageKillSwitchFile(path: string, reason: string): Promise<void> {
  await writeFile(path, `${reason}\n`, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
}

export interface EvidenceInputs {
  chainId: number;
  record: { digest: string; issuedAt: string; expiresAt: string; wallets: readonly string[] };
  lockfileDigest: string;
  probe: { observedAt: string; status: 'ok'; policyRecordDigest: string };
  balances: ReadonlyArray<{ address: string; balanceWei: bigint }>;
  rehearsal?: RehearsalEvidence;
  trustCenter?: TrustCenterRecord;
  now: Date;
  /** Seconds the balance observation stays valid. */
  balanceValiditySeconds?: number;
}

export function buildCompensatingEvidence(input: EvidenceInputs): CompensatingControlsEvidence {
  const observedAt = input.now.toISOString();
  return {
    version: 1,
    chainId: input.chainId,
    recordDigest: input.record.digest,
    walletSetDigest: walletSetDigest(input.record.wallets),
    lockfileDigest: input.lockfileDigest,
    balances: {
      observedAt,
      expiresAt: new Date(input.now.getTime() + (input.balanceValiditySeconds ?? 600) * 1000).toISOString(),
      wallets: input.balances.map((wallet) => ({ address: wallet.address.toLowerCase(), balanceWei: wallet.balanceWei.toString() })),
    },
    policyRecord: { digest: input.record.digest, issuedAt: input.record.issuedAt, expiresAt: input.record.expiresAt },
    providerProbe: input.probe,
    signatureChecks: { ...TURNKEY_SIGNER_ENFORCES },
    ...(input.rehearsal ? { rehearsal: { ...input.rehearsal } } : {}),
    ...(input.trustCenter ? { trustCenter: { reviewedAt: input.trustCenter.reviewedAt, documents: input.trustCenter.documents.map((document) => ({ ...document })) } } : {}),
    // The probe above engages the kill switch on any failure, so drift always stops the system (control 7).
    driftResponse: { killSwitchOnDrift: true },
  };
}

const CONTROL_LABELS: Record<(typeof COMPENSATING_CONTROL_IDS)[number], string> = {
  'bounded-balances': 'Small balances (1)',
  'policy-record': 'Exact policy and signed record (2)',
  'provider-probe': 'Fresh provider check (3)',
  'signature-verification': 'Every signature checked locally (4)',
  rehearsal: 'No-broadcast rehearsal after the last change (5)',
  'trust-center-review': 'Quarterly Trust Center review (6)',
  'drift-response': 'Stop on drift (7)',
};

/** Plain-language readout. It never says "TVC verified". */
export function renderCompensatingStatus(results: readonly ControlResult[]): string {
  const lines = ['CUSTODY ASSURANCE: compensating controls (this is NOT Turnkey TVC attestation)'];
  for (const result of results) lines.push(`${result.ok ? 'OK     ' : 'MISSING'} ${CONTROL_LABELS[result.id]}${result.ok ? '' : `: ${result.reason ?? 'not satisfied'}`}`);
  lines.push(results.every((result) => result.ok) ? 'Result: all seven controls are current. A run may arm if the service accepts this evidence kind.' : 'Result: NOT valid. A run cannot arm until every control above is OK.');
  return lines.join('\n');
}

export function evaluateStatus(evidence: CompensatingControlsEvidence | undefined, config: CompensatingAssuranceConfig, now = new Date()): { results: ControlResult[]; text: string; valid: boolean } {
  const results = evaluateCompensatingControls(evidence, config, now);
  return { results, text: renderCompensatingStatus(results), valid: results.every((result) => result.ok) };
}
