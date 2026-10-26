import { evaluateOpsEvidence } from './ops-evidence-runtime.mjs';

const report = await evaluateOpsEvidence();
process.stdout.write(`${JSON.stringify(report)}\n`);
if (process.env.MINT_BOT_ENFORCE_OPS_EVIDENCE === 'true' && report.humanEvidenceComplete !== true) process.exitCode = 1;
