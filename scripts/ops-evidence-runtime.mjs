import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ACCEPTANCE_PATH, installedIdentity, readArtifacts } from './ops-evidence-accept.mjs';
import { KINDS, verifyAcceptance } from './ops-evidence-lib.mjs';

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
  const acceptancePathValue = environment.MINT_BOT_OPS_EVIDENCE_ACCEPTANCE_PATH || ACCEPTANCE_PATH;
  if (!/[\r\n]/.test(acceptancePathValue) && isAbsolute(acceptancePathValue)) {
    const acceptancePath = resolve(acceptancePathValue);
    if (await regularNonemptyFile(acceptancePath, statPath)) {
      try {
        const acceptance = JSON.parse(await readText(acceptancePath, 'utf8'));
        const identity = await identityReader();
        const artifacts = await artifactsReader(paths, {});
        acceptanceProblems = verifyAcceptance(acceptance, artifacts, { currentCommit: identity.commit, hostId: identity.hostId, now: options.now ?? new Date() });
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
