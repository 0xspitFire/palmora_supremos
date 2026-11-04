import { isAbsolute } from 'node:path';
import { openDatabaseReadOnly } from '../packages/database/dist/index.js';
import { readPhase4AcceptanceReport } from '../packages/cli/dist/phase4-acceptance.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--database' || !isAbsolute(args[1])) {
  process.stderr.write('Usage: node scripts/phase4-acceptance.mjs --database /absolute/path/to/state.sqlite\n');
  process.exitCode = 2;
} else {
  const db = openDatabaseReadOnly(args[1]);
  try {
    const report = readPhase4AcceptanceReport(db);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.replicationAudit.result !== 'clean' || report.executionAudit.result !== 'clean') process.exitCode = 1;
  } finally { db.close(); }
}
