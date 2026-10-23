import type { FinalityReport } from './robinhood-readonly.js';

/**
 * Owner-run refresh of ONE step of the Robinhood enablement evidence file (D-040 Key 2). Pure: it reads and writes nothing. The
 * command in index.ts feeds it the old file text and a real observation, and writes the result to a NEW file. It never edits the
 * old file, never changes any other step, and writes an entry only when the observation meets the rule below; otherwise it says why.
 * It enables nothing: the owner still runs `robinhood-enable status` and types the confirmation phrase.
 */
export const FINALITY_MIN_FOLLOWED = 3;

const STEPS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const;
const MAX_REFERENCE = 300;

/** E3 ("finality observation matched reality"): enough fresh transactions, each posted, enough Ethereum-final, stages in order. */
export function finalityVerdict(report: FinalityReport): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const followed = report.followed.length;
  const posted = report.followed.filter((entry) => entry.postedAfterSeconds !== null).length;
  const final = report.followed.filter((entry) => entry.finalAfterSeconds !== null).length;
  if (followed < FINALITY_MIN_FOLLOWED) reasons.push(`only ${followed} fresh transaction(s) were followed; at least ${FINALITY_MIN_FOLLOWED} are needed (watch longer or pick more samples)`);
  if (posted < followed) reasons.push(`${followed - posted} of ${followed} transaction(s) never reached "posted"`);
  if (final < FINALITY_MIN_FOLLOWED) reasons.push(`only ${final} transaction(s) reached Ethereum-final; at least ${FINALITY_MIN_FOLLOWED} are needed (watch longer)`);
  if (!report.stagesInOrder) reasons.push('the stages did not occur in the order soft, posted, Ethereum-final');
  return { passed: reasons.length === 0, reasons };
}

const day = (date: Date): string => date.toISOString().slice(0, 10);

/** Returns the new file text with E3 replaced. Throws a plain code when the old file is unusable or the observation does not pass. */
export function refreshFinalityEvidence(input: { evidenceText: string; report: FinalityReport; today: Date }): { text: string; reference: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(input.evidenceText); } catch { throw new Error('EVIDENCE_FILE_NOT_JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('EVIDENCE_FILE_SHAPE');
  const record = parsed as Record<string, unknown>;
  for (const step of STEPS) if (typeof record[step] !== 'object' || record[step] === null) throw new Error(`EVIDENCE_FILE_MISSING_${step}`);
  const verdict = finalityVerdict(input.report);
  if (!verdict.passed) throw new Error(`FINALITY_NOT_PROVEN: ${verdict.reasons.join('; ')}`);
  const { followed, medianPostedSeconds, medianFinalSeconds } = input.report;
  const reference = `observe-finality ${day(input.today)}: ${followed.length}/${followed.length} posted (median ${medianPostedSeconds ?? 'n/a'}s), ${followed.filter((entry) => entry.finalAfterSeconds !== null).length} Ethereum-final (median ${medianFinalSeconds ?? 'n/a'}s), stages in order`.slice(0, MAX_REFERENCE);
  const next = { ...record, E3: { passed: true, checkedOn: day(input.today), reference } };
  return { text: `${JSON.stringify(next, null, 2)}\n`, reference };
}
