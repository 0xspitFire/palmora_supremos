import { createHash } from 'node:crypto';
import { validRobinhoodEnablement } from '@mint-bot/backend';

/**
 * Owner command rules for switching Robinhood on (T-032 part B, D-040, D-050, D-051). Pure: it reads nothing and writes nothing.
 * The command in index.ts feeds it the evidence file text, the typed phrase and the facts it found, and acts only when
 * `assertEnableAllowed` returns. Nothing here can enable Robinhood by itself.
 *
 * E1 to E7 are the steps of the Robinhood gate list (D-038). Their results are not stored by the read-only tools, so the owner
 * attests each one in an evidence file: a date (not older than 30 days, not in the future), a short reference to where the
 * evidence is (a doc section, a command output), and `passed: true`. The file's digest goes into the phrase and the record.
 */
export const EVIDENCE_STEPS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'] as const;
export type EvidenceStep = typeof EVIDENCE_STEPS[number];
export const MAX_EVIDENCE_AGE_DAYS = 30;
export const ENABLEMENT_DAYS = 7;

export const STEP_MEANING: Readonly<Record<EvidenceStep, string>> = {
  E1: 'survey: public mints are common on Robinhood',
  E2: 'bot-path rehearsal on a Robinhood fork passed',
  E3: 'finality observation matched reality',
  E4: 'feed check matched the node',
  E5: 'fee check fits the approved caps',
  E6: 'live dry-run simulation passed for your wallets',
  E7: 'L1 data-gas units fixed',
};

export interface EvidenceCheck {
  /** Steps that are present, passed and recent. */
  ok: EvidenceStep[];
  /** Plain-language problems, one per step or for the file as a whole. */
  problems: string[];
  /** SHA-256 (hex) of the exact file text, or undefined when the file is not usable at all. */
  fileDigest?: string;
  evidence?: Record<EvidenceStep, true>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function checkEvidenceFile(text: string, now: Date): EvidenceCheck {
  const fileDigest = createHash('sha256').update(text, 'utf8').digest('hex');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: [], problems: ['The evidence file is not valid JSON.'] }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: [], problems: ['The evidence file must be a JSON object with one entry per step, E1 to E7.'] };
  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const ok: EvidenceStep[] = [];
  const extra = Object.keys(record).filter((key) => !(EVIDENCE_STEPS as readonly string[]).includes(key));
  if (extra.length > 0) problems.push(`Unknown entries in the evidence file: ${extra.slice(0, 5).join(', ')}.`);
  for (const step of EVIDENCE_STEPS) {
    const entry = Object.hasOwn(record, step) ? record[step] : undefined;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problems.push(`${step} (${STEP_MEANING[step]}) is missing.`); continue; }
    const item = entry as Record<string, unknown>;
    if (item.passed !== true) { problems.push(`${step} (${STEP_MEANING[step]}) is not marked passed.`); continue; }
    const checkedOn = item.checkedOn;
    if (typeof checkedOn !== 'string' || !DATE.test(checkedOn) || !Number.isFinite(Date.parse(`${checkedOn}T00:00:00.000Z`))) { problems.push(`${step} needs a date in the form 2026-10-20.`); continue; }
    const ageDays = (now.getTime() - Date.parse(`${checkedOn}T00:00:00.000Z`)) / 86_400_000;
    if (ageDays < -1) { problems.push(`${step} is dated in the future.`); continue; }
    if (ageDays > MAX_EVIDENCE_AGE_DAYS) { problems.push(`${step} was checked more than ${MAX_EVIDENCE_AGE_DAYS} days ago; run it again.`); continue; }
    const reference = item.reference;
    if (typeof reference !== 'string' || reference.trim().length < 5 || reference.length > 300) { problems.push(`${step} needs a short reference (5 to 300 characters) saying where the evidence is.`); continue; }
    ok.push(step);
  }
  if (ok.length === EVIDENCE_STEPS.length && problems.length === 0) return { ok, problems, fileDigest, evidence: Object.fromEntries(EVIDENCE_STEPS.map((step) => [step, true])) as Record<EvidenceStep, true> };
  return { ok, problems, fileDigest };
}

/** The phrase names the evidence file (first 8 characters of its digest) and the length of the enablement, so a stale or copied phrase does not match. */
export function enablePhrase(fileDigest: string, days = ENABLEMENT_DAYS): string {
  return `ENABLE-ROBINHOOD-FREE ${days}-DAYS ${fileDigest.slice(0, 8)}`;
}

/** What goes into the record as the typed-confirmation digest. */
export function confirmationDigest(phrase: string, fileDigest: string): string {
  return createHash('sha256').update(`${phrase}\n${fileDigest}`, 'utf8').digest('hex');
}

export interface EnableFacts {
  evidence: EvidenceCheck;
  ethereumLiveMintProven: boolean;
  confirm: string | undefined;
  days: number;
}

/** Throws a plain error unless every condition holds. Nothing is written before this returns. */
export function assertEnableAllowed(facts: EnableFacts): { phrase: string; digest: string; evidence: Record<EvidenceStep, true> } {
  if (!Number.isInteger(facts.days) || facts.days < 1 || facts.days > ENABLEMENT_DAYS) throw new Error(`DAYS_INVALID: use a whole number from 1 to ${ENABLEMENT_DAYS}`);
  if (!facts.ethereumLiveMintProven) throw new Error('ETHEREUM_LIVE_MINT_REQUIRED: one live Ethereum mint must have worked and been confirmed before Robinhood can be switched on');
  const { evidence, fileDigest } = facts.evidence;
  if (!evidence || !fileDigest || facts.evidence.problems.length > 0) throw new Error(`EVIDENCE_INCOMPLETE: ${facts.evidence.problems.join(' ') || 'the evidence file is not usable'}`);
  const phrase = enablePhrase(fileDigest, facts.days);
  if (typeof facts.confirm !== 'string' || facts.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run robinhood-enable status and copy the phrase it prints exactly');
  return { phrase, digest: confirmationDigest(phrase, fileDigest), evidence };
}

/** What the command needs from the store. The real one is the canonical store; the tests use a stand-in. */
export interface EnableStore {
  ethereumLiveMintProven(): boolean;
  robinhoodEnablement(): unknown;
  enableRobinhood(input: { id: string; approvedAt: string; expiresAt: string; evidence: Record<EvidenceStep, true>; confirmationDigest: string }): void;
}

/**
 * The whole `robinhood-enable` command after the evidence file has been read. `status` only reads. `record` writes exactly once,
 * and only after `assertEnableAllowed` has returned. Returns what the command prints.
 */
export function runRobinhoodEnable(input: { action: 'status' | 'record'; evidenceText: string; evidenceFile: string; days: number; confirm: string | undefined; now: Date; store: EnableStore; newId: () => string }): Record<string, unknown> {
  const { store, now } = input;
  const evidence = checkEvidenceFile(input.evidenceText, now);
  const proven = store.ethereumLiveMintProven();
  const current = validRobinhoodEnablement(store.robinhoodEnablement(), now);
  if (input.action === 'status') {
    const ready = proven && evidence.problems.length === 0 && evidence.fileDigest !== undefined;
    return {
      state: ready ? 'ReadyToRecord' : 'NotReady',
      message: ready ? `Everything checks out. Recording switches Robinhood FREE execution on for ${input.days} day(s); paid mints stay blocked.` : 'Not ready yet. Fix the items below.',
      ethereumLiveMintConfirmed: proven,
      steps: EVIDENCE_STEPS.map((step) => ({ step, meaning: STEP_MEANING[step], ok: evidence.ok.includes(step) })),
      problems: [...(proven ? [] : ['No confirmed live Ethereum mint yet (D-040 item 6).']), ...evidence.problems],
      currentlyEnabledUntil: current?.expiresAt ?? null,
      ...(ready && evidence.fileDigest ? { copyThisToRecord: `robinhood-enable record --evidence-file ${input.evidenceFile} --days ${input.days} --confirm "${enablePhrase(evidence.fileDigest, input.days)}"` } : {}),
    };
  }
  const allowed = assertEnableAllowed({ evidence, ethereumLiveMintProven: proven, confirm: input.confirm, days: input.days });
  const expiresAt = new Date(now.getTime() + input.days * 86_400_000).toISOString();
  store.enableRobinhood({ id: input.newId(), approvedAt: now.toISOString(), expiresAt, evidence: allowed.evidence, confirmationDigest: allowed.digest });
  return { state: 'Enabled', message: `Robinhood FREE execution is on until ${expiresAt}. Paid mints stay blocked. The service switches it off by itself when this expires; the kill switch still stops everything.`, expiresAt };
}
