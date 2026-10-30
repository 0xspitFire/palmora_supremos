import { createHash } from 'node:crypto';

/**
 * The five production evidence artifacts of the infrastructure design ("Evidence contract") and the owner's acceptance of them.
 * An artifact is only ever written from checks that were actually made on the host, and the acceptance binds the owner's approval to
 * the SHA-256 of every artifact, so a changed artifact is no longer accepted. A reserved path or a nonempty file is not proof.
 */
export const KINDS = ['recovery', 'rotation_revocation', 'heap_core_dump', 'backup_restore', 'service_supervision'];
export const OPS_EVIDENCE_ACCEPTANCE_VERSION = 2;
export const OPS_EVIDENCE_LEGACY_ACCEPTANCE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
/** The owner acceptance is bounded at 30 days; shorter-lived artifacts still force an earlier refresh. */
export const OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;
export const OPS_EVIDENCE_EXPIRY_PROFILE = 'tiered-v1';
export const OPS_EVIDENCE_REMINDER_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Maximum age of each source artifact at every acceptance/runtime check. Dynamic recovery and backup drills stay weekly;
 * host hardening, custody/rotation, and service supervision are valid for 30 days unless a release or configuration event
 * changes their bound. These are separate per-kind limits so one policy can be shortened without silently changing the others.
 */
export const OPS_EVIDENCE_MAX_AGE_MS = Object.freeze({
  recovery: 7 * 24 * 60 * 60 * 1000,
  rotation_revocation: 30 * 24 * 60 * 60 * 1000,
  heap_core_dump: 30 * 24 * 60 * 60 * 1000,
  backup_restore: 7 * 24 * 60 * 60 * 1000,
  service_supervision: 30 * 24 * 60 * 60 * 1000,
});

/** Names every artifact of that kind must contain, each passing. A check that could not be made is a failure, never a skip. */
export const REQUIRED_CHECKS = {
  service_supervision: ['unit_identity', 'unit_hardening', 'restart_policy', 'restart_limit_exercised', 'rollback_recorded', 'loopback_health', 'logs_private', 'release_identity'],
  heap_core_dump: ['core_limit_unit', 'core_limit_process', 'core_pattern_recorded', 'no_coredumps', 'heap_limit_recorded', 'zeroization_limits_documented'],
  backup_restore: ['backup_status_ok', 'offhost_remote_verified', 'restore_drill_ok', 'restore_seconds_recorded', 'backup_schedule_active'],
  recovery: ['restored_from_offhost', 'integrity_ok', 'schema_current', 'post_recovery_reconciliation', 'kill_switch_engaged'],
  rotation_revocation: ['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded'],
};

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** Binding for release/host/artifact state plus an optional deployment or custody generation event. */
export function evidenceBindingDigest({ currentCommit, hostId, digests, eventDigest = '' }) {
  const joined = [`commit:${currentCommit}`, `host:${hostId}`, ...KINDS.map((kind) => `${kind}:${digests[kind] ?? ''}`), `event:${eventDigest}`].join('\n');
  return sha256Hex(joined);
}

/** One short line, no web addresses, no long hex: an artifact never carries a secret-shaped string. */
export function sanitize(text, max = 300) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/\b0x[0-9a-fA-F]{40,}\b/g, '[hex]').replace(/\b[0-9a-fA-F]{64,}\b/g, '[hex]').replace(/\s+/g, ' ').trim().slice(0, max);
}

const COMMIT = /^[0-9a-f]{40}$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Problems with one artifact, as plain codes. An empty list means it may be accepted. */
export function validateEvidence(value, expectedKind, now = new Date()) {
  const problems = [];
  if (!value || typeof value !== 'object') return ['EVIDENCE_NOT_AN_OBJECT'];
  if (value.version !== 1) problems.push('EVIDENCE_VERSION');
  if (value.kind !== expectedKind) problems.push('EVIDENCE_KIND_MISMATCH');
  if (value.environment !== 'production') problems.push('EVIDENCE_ENVIRONMENT');
  if (typeof value.hostId !== 'string' || !HOST_ID.test(value.hostId) || value.hostId.startsWith('REPLACE-')) problems.push('EVIDENCE_HOST_ID');
  if (!value.release || typeof value.release.commit !== 'string' || !COMMIT.test(value.release.commit)) problems.push('EVIDENCE_RELEASE_COMMIT');
  const started = Date.parse(value.startedAt);
  const completed = Date.parse(value.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > now.getTime() + 60_000) problems.push('EVIDENCE_TIMES');
  const maxAge = OPS_EVIDENCE_MAX_AGE_MS[expectedKind];
  // The exact maximum age is valid; one millisecond beyond it is stale. A bad/future timestamp is already named above.
  if (Number.isFinite(completed) && Number.isFinite(maxAge) && now.getTime() - completed > maxAge) problems.push('EVIDENCE_STALE');
  if (!Array.isArray(value.checks) || value.checks.length === 0) { problems.push('EVIDENCE_CHECKS_MISSING'); return problems; }
  const byName = new Map();
  for (const check of value.checks) {
    if (!check || typeof check.name !== 'string' || (check.result !== 'pass' && check.result !== 'fail') || typeof check.observed !== 'string') { problems.push('EVIDENCE_CHECK_SHAPE'); continue; }
    if (check.observed.length > 300 || /:\/\//.test(check.observed) || /\b[0-9a-fA-F]{64,}\b/.test(check.observed)) problems.push(`EVIDENCE_CHECK_UNSAFE_TEXT:${check.name}`);
    byName.set(check.name, check.result);
  }
  for (const name of REQUIRED_CHECKS[expectedKind] ?? []) {
    if (!byName.has(name)) problems.push(`EVIDENCE_CHECK_MISSING:${name}`);
  }
  for (const [name, result] of byName) if (result !== 'pass') problems.push(`EVIDENCE_CHECK_FAILED:${name}`);
  if (value.references !== undefined) {
    if (!Array.isArray(value.references)) problems.push('EVIDENCE_REFERENCES');
    else for (const reference of value.references) if (!reference || typeof reference.name !== 'string' || !SHA256.test(String(reference.sha256))) problems.push('EVIDENCE_REFERENCES');
  }
  return problems;
}

/** The phrase the owner types to accept this exact set of artifacts and this exact design document. */
export function acceptancePhrase(digests, designSha256) {
  const joined = KINDS.map((kind) => `${kind}:${digests[kind] ?? ''}`).join('\n') + `\ndesign:${designSha256}`;
  return `ACCEPT-OPS-EVIDENCE ${sha256Hex(joined).slice(0, 12)}`;
}

export function buildAcceptance({ digests, designSha256, witness, acceptedAt, bindingDigest = '' }) {
  const acceptedTime = Date.parse(acceptedAt);
  const expiresAt = Number.isFinite(acceptedTime) ? new Date(acceptedTime + OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS).toISOString() : '';
  const acceptance = { version: OPS_EVIDENCE_ACCEPTANCE_VERSION, type: 'ops-evidence-acceptance', profile: OPS_EVIDENCE_EXPIRY_PROFILE, acceptedAt, expiresAt, witness: { reference: witness }, design: { sha256: designSha256, expiresAt: Number.isFinite(acceptedTime) ? new Date(acceptedTime + 90 * 24 * 60 * 60 * 1000).toISOString() : '' }, artifacts: Object.fromEntries(KINDS.map((kind) => [kind, digests[kind]])) };
  // A deployment or custody change may publish a generation digest. Keeping this optional preserves compatibility with
  // older hosts while allowing an installation to invalidate an acceptance immediately without waiting for a timer.
  if (SHA256.test(String(bindingDigest))) acceptance.binding = { sha256: bindingDigest };
  return acceptance;
}

/**
 * Judges the acceptance against what is on disk now. `artifacts` maps each kind to { bytes, json }. The artifacts must still be
 * the very bytes that were accepted, each must still validate, and all must describe the release installed now on the same host.
 */
export function verifyAcceptance(acceptance, artifacts, { currentCommit, hostId, now = new Date(), bindingDigest = '' }) {
  const problems = [];
  if (!acceptance || acceptance.version !== OPS_EVIDENCE_ACCEPTANCE_VERSION || acceptance.type !== 'ops-evidence-acceptance') return ['ACCEPTANCE_INVALID'];
  const profile = acceptance.profile === undefined ? 'legacy-weekly' : acceptance.profile;
  if (profile !== OPS_EVIDENCE_EXPIRY_PROFILE && profile !== 'legacy-weekly') problems.push('ACCEPTANCE_PROFILE');
  const acceptedTime = Date.parse(acceptance.acceptedAt);
  const expiresTime = Date.parse(acceptance.expiresAt);
  if (!Number.isFinite(acceptedTime) || acceptedTime > now.getTime() + 60_000) problems.push('ACCEPTANCE_TIME');
  const validity = profile === 'legacy-weekly' ? OPS_EVIDENCE_LEGACY_ACCEPTANCE_VALIDITY_MS : OPS_EVIDENCE_ACCEPTANCE_VALIDITY_MS;
  if (!Number.isFinite(expiresTime) || !Number.isFinite(acceptedTime) || expiresTime !== acceptedTime + validity) problems.push('ACCEPTANCE_EXPIRY');
  else if (now.getTime() >= expiresTime) problems.push('ACCEPTANCE_EXPIRED');
  if (typeof acceptance.witness?.reference !== 'string' || acceptance.witness.reference.trim().length < 3) problems.push('ACCEPTANCE_WITNESS_MISSING');
  if (!SHA256.test(String(acceptance.design?.sha256))) problems.push('ACCEPTANCE_DESIGN_DIGEST');
  if (profile === OPS_EVIDENCE_EXPIRY_PROFILE && (!SHA256.test(String(acceptance.design?.sha256)) || !Number.isFinite(Date.parse(acceptance.design?.expiresAt)) || now.getTime() >= Date.parse(acceptance.design.expiresAt))) problems.push('ACCEPTANCE_DESIGN_EXPIRED');
  if (acceptance.binding?.sha256 !== undefined) {
    if (!SHA256.test(String(acceptance.binding.sha256))) problems.push('ACCEPTANCE_BINDING_DIGEST');
    else if (!SHA256.test(String(bindingDigest)) || acceptance.binding.sha256 !== bindingDigest) problems.push('ACCEPTANCE_BINDING_CHANGED');
  }
  for (const kind of KINDS) {
    const artifact = artifacts[kind];
    if (!artifact) { problems.push(`ARTIFACT_MISSING:${kind}`); continue; }
    if (sha256Hex(artifact.bytes) !== acceptance.artifacts?.[kind]) problems.push(`ARTIFACT_CHANGED_AFTER_ACCEPTANCE:${kind}`);
    for (const problem of validateEvidence(artifact.json, kind, now)) problems.push(`${kind}:${problem}`);
    if (artifact.json?.release?.commit !== currentCommit) problems.push(`ARTIFACT_NOT_FOR_INSTALLED_RELEASE:${kind}`);
    if (artifact.json?.hostId !== hostId) problems.push(`ARTIFACT_OTHER_HOST:${kind}`);
  }
  return problems;
}
