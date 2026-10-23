import { createHash } from 'node:crypto';

/**
 * The five production evidence artifacts of the infrastructure design ("Evidence contract") and the owner's acceptance of them.
 * An artifact is only ever written from checks that were actually made on the host, and the acceptance binds the owner's approval to
 * the SHA-256 of every artifact, so a changed artifact is no longer accepted. A reserved path or a nonempty file is not proof.
 */
export const KINDS = ['recovery', 'rotation_revocation', 'heap_core_dump', 'backup_restore', 'service_supervision'];

/** Names every artifact of that kind must contain, each passing. A check that could not be made is a failure, never a skip. */
export const REQUIRED_CHECKS = {
  service_supervision: ['unit_identity', 'unit_hardening', 'restart_policy', 'restart_limit_exercised', 'rollback_recorded', 'loopback_health', 'logs_private', 'release_identity'],
  heap_core_dump: ['core_limit_unit', 'core_limit_process', 'core_pattern_recorded', 'no_coredumps', 'heap_limit_recorded', 'zeroization_limits_documented'],
  backup_restore: ['backup_status_ok', 'offhost_remote_verified', 'restore_drill_ok', 'restore_seconds_recorded', 'backup_schedule_active'],
  recovery: ['restored_from_offhost', 'integrity_ok', 'schema_current', 'kill_switch_engaged', 'reconciliation_required_before_ready'],
  rotation_revocation: ['fresh_wallet_inventory', 'funding_profile_bounded', 'old_references_excluded'],
};

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

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

export function buildAcceptance({ digests, designSha256, witness, acceptedAt }) {
  return { version: 1, type: 'ops-evidence-acceptance', acceptedAt, witness: { reference: witness }, design: { sha256: designSha256 }, artifacts: Object.fromEntries(KINDS.map((kind) => [kind, digests[kind]])) };
}

/**
 * Judges the acceptance against what is on disk now. `artifacts` maps each kind to { bytes, json }. The artifacts must still be
 * the very bytes that were accepted, each must still validate, and all must describe the release installed now on the same host.
 */
export function verifyAcceptance(acceptance, artifacts, { currentCommit, hostId, now = new Date() }) {
  const problems = [];
  if (!acceptance || acceptance.version !== 1 || acceptance.type !== 'ops-evidence-acceptance') return ['ACCEPTANCE_INVALID'];
  if (!Number.isFinite(Date.parse(acceptance.acceptedAt)) || Date.parse(acceptance.acceptedAt) > now.getTime() + 60_000) problems.push('ACCEPTANCE_TIME');
  if (typeof acceptance.witness?.reference !== 'string' || acceptance.witness.reference.trim().length < 3) problems.push('ACCEPTANCE_WITNESS_MISSING');
  if (!SHA256.test(String(acceptance.design?.sha256))) problems.push('ACCEPTANCE_DESIGN_DIGEST');
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
