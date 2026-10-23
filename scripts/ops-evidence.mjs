import { lstat, readFile } from 'node:fs/promises';
import { ACCEPTANCE_PATH, installedIdentity, readArtifacts } from './ops-evidence-accept.mjs';
import { verifyAcceptance } from './ops-evidence-lib.mjs';

const required = [
  ['recovery', 'MINT_BOT_RECOVERY_EVIDENCE_PATH'],
  ['rotation_revocation', 'MINT_BOT_ROTATION_REVOCATION_EVIDENCE_PATH'],
  ['heap_core_dump', 'MINT_BOT_HEAP_CORE_POLICY_PATH'],
  ['backup_restore', 'MINT_BOT_BACKUP_RESTORE_EVIDENCE_PATH'],
  ['service_supervision', 'MINT_BOT_SERVICE_SUPERVISION_EVIDENCE_PATH'],
];

const references = {};
for (const [name, variable] of required) {
  const value = process.env[variable];
  if (!value || /[\r\n]/.test(value)) {
    references[name] = 'missing';
    continue;
  }
  try {
    const metadata = await lstat(value);
    references[name] = metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0 ? 'configured' : 'missing';
  } catch {
    references[name] = 'missing';
  }
}
const missing = required.filter(([name]) => references[name] === 'missing').map(([name]) => name);

// A reference is not proof. The owner's acceptance is: it must bind the SHA-256 of the five artifacts as they are now, each artifact
// must still pass, and all must describe the release installed on this host. Anything else leaves humanEvidenceComplete false.
let acceptanceProblems = ['ACCEPTANCE_NOT_RECORDED'];
try {
  const acceptance = JSON.parse(await readFile(process.env.MINT_BOT_OPS_EVIDENCE_ACCEPTANCE_PATH || ACCEPTANCE_PATH, 'utf8'));
  const identity = await installedIdentity();
  acceptanceProblems = verifyAcceptance(acceptance, await readArtifacts(), { currentCommit: identity.commit, hostId: identity.hostId });
} catch { /* no readable acceptance record */ }
const report = {
  status: missing.length === 0 ? 'configured' : 'blocked',
  humanEvidenceComplete: missing.length === 0 && acceptanceProblems.length === 0,
  references,
  missing,
  acceptance: acceptanceProblems.length === 0 ? 'accepted' : 'not_accepted',
  acceptanceProblems: acceptanceProblems.slice(0, 20),
  note: 'References are not proof. The owner acceptance record, bound to the SHA-256 of each artifact, and the live/safety approvals remain required.',
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (process.env.MINT_BOT_ENFORCE_OPS_EVIDENCE === 'true' && (missing.length > 0 || report.humanEvidenceComplete !== true)) process.exitCode = 1;
