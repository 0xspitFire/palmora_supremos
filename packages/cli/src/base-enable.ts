import { createHash } from 'node:crypto';
import { BASE_EVIDENCE_STEPS, validBaseEnablement, type BaseEvidenceStep } from '@mint-bot/backend';

export const BASE_ENABLEMENT_DAYS = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface BaseEvidenceCheck { readonly problems: readonly string[]; readonly fileDigest?: string; readonly evidence?: Record<BaseEvidenceStep, true>; }

export function checkBaseEvidenceFile(text: string, now: Date): BaseEvidenceCheck {
  const fileDigest = createHash('sha256').update(text).digest('hex');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { problems: ['The evidence file is not valid JSON.'] }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { problems: ['The evidence file must be an object.'] };
  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (Object.keys(record).length !== BASE_EVIDENCE_STEPS.length || Object.keys(record).some((key) => !(BASE_EVIDENCE_STEPS as readonly string[]).includes(key))) problems.push('The evidence file must contain exactly the seven Base evidence steps.');
  for (const step of BASE_EVIDENCE_STEPS) {
    const entry = record[step];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problems.push(`${step} is missing.`); continue; }
    const item = entry as Record<string, unknown>;
    if (item['passed'] !== true) { problems.push(`${step} is not marked passed.`); continue; }
    if (typeof item['checkedOn'] !== 'string' || !DATE.test(item['checkedOn'])) { problems.push(`${step} needs a YYYY-MM-DD date.`); continue; }
    const age = (now.getTime() - Date.parse(`${item['checkedOn']}T00:00:00.000Z`)) / 86_400_000;
    const maxAge = step === 'liveSimulation' || step === 'custodyReadiness' ? 1 : step === 'feeObservation' ? 1 : 7;
    if (age < -1 || age > maxAge) problems.push(`${step} evidence is outside its ${maxAge}-day freshness window.`);
    if (typeof item['reference'] !== 'string' || item['reference'].trim().length < 5 || item['reference'].length > 300) problems.push(`${step} needs a short evidence reference.`);
  }
  return problems.length === 0 ? { problems, fileDigest, evidence: Object.fromEntries(BASE_EVIDENCE_STEPS.map((step) => [step, true])) as Record<BaseEvidenceStep, true> } : { problems, fileDigest };
}

export function baseEnablePhrase(digest: string, days: number): string { return `ENABLE-BASE-FREE ${days}-DAYS ${digest.slice(0, 8)} LOCAL-ATTENDED`; }

export interface BaseEnableStore {
  baseEnablement(): unknown;
  enableBase(input: { id: string; approvedAt: string; expiresAt: string; evidence: Record<BaseEvidenceStep, true>; evidenceDigest: string; confirmationDigest: string; strategyVersion: string; feePolicyVersion: string; primaryEndpointReference: string; fallbackEndpointReference: string; custodyMode: 'local-personal-live' }): void;
}

export function runBaseEnable(input: { action: 'status' | 'record'; evidenceText: string; evidenceFile: string; days: number; confirm?: string; now: Date; store: BaseEnableStore; newId(): string }): Record<string, unknown> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > BASE_ENABLEMENT_DAYS) throw new Error('DAYS_INVALID: use a whole number from 1 to 7');
  const checked = checkBaseEvidenceFile(input.evidenceText, input.now);
  const current = validBaseEnablement(input.store.baseEnablement(), input.now);
  const phrase = checked.fileDigest ? baseEnablePhrase(checked.fileDigest, input.days) : undefined;
  if (input.action === 'status') return { state: checked.evidence && phrase ? 'ReadyToRecord' : 'NotReady', problems: checked.problems, currentlyEnabledUntil: current?.expiresAt ?? null, ...(phrase ? { copyThisToRecord: `base-enable record --evidence-file ${input.evidenceFile} --days ${input.days} --confirm "${phrase}"` } : {}) };
  if (!checked.evidence || !checked.fileDigest || checked.problems.length > 0) throw new Error(`EVIDENCE_INCOMPLETE: ${checked.problems.join(' ')}`);
  if (input.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run base-enable status and copy its phrase exactly');
  const approvedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.days * 86_400_000).toISOString();
  input.store.enableBase({ id: input.newId(), approvedAt, expiresAt, evidence: checked.evidence, evidenceDigest: checked.fileDigest, confirmationDigest: createHash('sha256').update(`${phrase}\n${checked.fileDigest}`).digest('hex'), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' });
  return { state: 'Enabled', message: `Base free attended execution is enabled until ${expiresAt}. Paid Base remains disabled.`, expiresAt, paidAllowed: false };
}
