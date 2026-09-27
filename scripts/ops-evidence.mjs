import { lstat } from 'node:fs/promises';

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
const report = {
  status: missing.length === 0 ? 'configured' : 'blocked',
  humanEvidenceComplete: false,
  references,
  missing,
  note: 'References are not proof. Owner artifacts and live/safety approvals remain required.',
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (process.env.MINT_BOT_ENFORCE_OPS_EVIDENCE === 'true' && (missing.length > 0 || report.humanEvidenceComplete !== true)) process.exitCode = 1;
