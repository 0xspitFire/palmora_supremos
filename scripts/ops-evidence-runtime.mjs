import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ACCEPTANCE_PATH, installedIdentity, readArtifacts } from './ops-evidence-accept.mjs';
import { KINDS, OPS_EVIDENCE_MAX_AGE_MS, evidenceBindingDigest, sha256Hex, verifyAcceptance } from './ops-evidence-lib.mjs';

export const EVIDENCE_PATH_VARIABLES = {
  recovery: 'MINT_BOT_RECOVERY_EVIDENCE_PATH',
  rotation_revocation: 'MINT_BOT_ROTATION_REVOCATION_EVIDENCE_PATH',
  heap_core_dump: 'MINT_BOT_HEAP_CORE_POLICY_PATH',
  backup_restore: 'MINT_BOT_BACKUP_RESTORE_EVIDENCE_PATH',
  service_supervision: 'MINT_BOT_SERVICE_SUPERVISION_EVIDENCE_PATH',
};

const regularNonemptyFile = async (path, statPath) => {
  try {
    const metadata = await statPath(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0;
  } catch { return false; }
};

/**
 * Reusable fail-closed D-017 acceptance check for a service or scheduler boundary.
 * It returns codes only: no path, file content, provider identifier or secret enters the report.
 */
export async function evaluateOpsEvidence(options = {}) {
  const environment = options.environment ?? process.env;
  const statPath = options.statPath ?? lstat;
  const readText = options.readText ?? readFile;
  const artifactsReader = options.artifactsReader ?? readArtifacts;
  const identityReader = options.identityReader ?? installedIdentity;
  const references = {};
  const paths = {};

  for (const kind of KINDS) {
    const value = environment[EVIDENCE_PATH_VARIABLES[kind]];
    if (!value || /[\r\n]/.test(value) || !isAbsolute(value)) {
      references[kind] = 'missing';
      continue;
    }
    const path = resolve(value);
    paths[kind] = path;
    references[kind] = await regularNonemptyFile(path, statPath) ? 'configured' : 'missing';
  }
  const missing = KINDS.filter((kind) => references[kind] === 'missing');

  let acceptanceProblems = ['ACCEPTANCE_NOT_RECORDED'];
  const now = options.now ?? new Date();
  const artifactExpiry = {};
  let acceptanceRecord;
  let currentArtifacts = {};
  try {
    currentArtifacts = await artifactsReader(paths, {});
    for (const kind of KINDS) {
      const completedAt = Date.parse(currentArtifacts[kind]?.json?.completedAt);
      const maxAge = OPS_EVIDENCE_MAX_AGE_MS[kind];
      artifactExpiry[kind] = { completedAt: Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null, expiresAt: Number.isFinite(completedAt) && Number.isFinite(maxAge) ? new Date(completedAt + maxAge).toISOString() : null };
    }
  } catch { /* the acceptance check below remains fail-closed */ }
  const acceptancePathValue = environment.MINT_BOT_OPS_EVIDENCE_ACCEPTANCE_PATH || ACCEPTANCE_PATH;
  if (!/[\r\n]/.test(acceptancePathValue) && isAbsolute(acceptancePathValue)) {
    const acceptancePath = resolve(acceptancePathValue);
    if (await regularNonemptyFile(acceptancePath, statPath)) {
      try {
        const acceptance = JSON.parse(await readText(acceptancePath, 'utf8'));
        acceptanceRecord = acceptance;
        const identity = await identityReader();
        const digests = Object.fromEntries(KINDS.map((kind) => [kind, currentArtifacts[kind] ? sha256Hex(currentArtifacts[kind].bytes) : '']));
        const eventDigest = /^[0-9a-f]{64}$/i.test(environment.MINT_BOT_OPS_EVIDENCE_EVENT_DIGEST ?? '') ? environment.MINT_BOT_OPS_EVIDENCE_EVENT_DIGEST.toLowerCase() : '';
        const bindingDigest = evidenceBindingDigest({ currentCommit: identity.commit, hostId: identity.hostId, digests, eventDigest });
        acceptanceProblems = verifyAcceptance(acceptance, currentArtifacts, { currentCommit: identity.commit, hostId: identity.hostId, bindingDigest, now });
      } catch {
        acceptanceProblems = ['ACCEPTANCE_INVALID'];
      }
    }
  }

  const humanEvidenceComplete = missing.length === 0 && acceptanceProblems.length === 0;
  return {
    status: missing.length === 0 ? 'configured' : 'blocked',
    humanEvidenceComplete,
    references,
    missing,
    acceptance: acceptanceProblems.length === 0 ? 'accepted' : 'not_accepted',
    acceptanceProblems: acceptanceProblems.slice(0, 20),
    expiryProfile: acceptanceRecord?.profile ?? 'legacy-weekly',
    acceptanceExpiresAt: typeof acceptanceRecord?.expiresAt === 'string' ? acceptanceRecord.expiresAt : null,
    artifactExpiry,
    note: 'References are not proof. The owner acceptance record, bound to the SHA-256 of each artifact, and the live/safety approvals remain required.',
  };
}

/** Use at an unattended execution boundary. Absence, unreadable state, drift, or malformed evidence always refuses. */
export async function assertOpsEvidenceAccepted(options = {}) {
  const report = await evaluateOpsEvidence(options);
  if (!report.humanEvidenceComplete) {
    const problems = [...report.missing.map((kind) => `ARTIFACT_MISSING:${kind}`), ...report.acceptanceProblems];
    throw new Error(`OPS_EVIDENCE_NOT_ACCEPTED:${problems.slice(0, 20).join(',')}`);
  }
  return report;
}
