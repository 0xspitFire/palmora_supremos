import { createHash } from 'node:crypto';
import { BASE_EVIDENCE_STEPS, PERMANENT_ENABLEMENT_EXPIRY, validBaseEnablement, type BaseEvidenceStep } from '@mint-bot/backend';

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

/** D-062: permanent until revoked. */
export function baseEnablePhrase(digest: string): string { return `ENABLE-BASE-FREE PERMANENT ${digest.slice(0, 8)} LOCAL-ATTENDED`; }

/** Names the record being revoked, so a copied phrase cannot revoke a later one. */
export function baseRevokePhrase(recordId: string): string { return `REVOKE-BASE ${createHash('sha256').update(recordId, 'utf8').digest('hex').slice(0, 8)}`; }

export interface BaseEnableStore {
  baseEnablement(): unknown;
  revokeBase(input: { id: string; confirmationDigest: string; expectedEnablementId?: string }): { enablementId: string };
  enableBase(input: { id: string; approvedAt: string; expiresAt: string; evidence: Record<BaseEvidenceStep, true>; evidenceDigest: string; confirmationDigest: string; strategyVersion: string; feePolicyVersion: string; primaryEndpointReference: string; fallbackEndpointReference: string; custodyMode: 'local-personal-live' }): void;
}

export function runBaseEnable(input: { action: 'status' | 'record' | 'revoke'; evidenceText?: string; evidenceFile?: string; confirm?: string; now: Date; store: BaseEnableStore; newId(): string }): Record<string, unknown> {
  const current = validBaseEnablement(input.store.baseEnablement(), input.now);
  if (input.action === 'revoke') {
    if (!current) throw new Error('NOTHING_TO_REVOKE: Base is not enabled');
    const phrase = baseRevokePhrase(current.recordId);
    if (input.confirm !== phrase) return { state: 'ConfirmToRevoke', message: 'Revoking switches Base execution off at once. Runs already in flight are not undone; new ones are refused.', enabledSince: current.approvedAt, copyThisToRevoke: `base-enable revoke --confirm "${phrase}"` };
    const revoked = input.store.revokeBase({ id: input.newId(), confirmationDigest: createHash('sha256').update(`${phrase}\n${current.recordId}`).digest('hex'), expectedEnablementId: current.recordId });
    return { state: 'Revoked', message: 'Base execution is off. Record a new enablement to switch it on again.', revokedEnablement: revoked.enablementId };
  }
  if (input.evidenceText === undefined || input.evidenceFile === undefined) throw new Error('EVIDENCE_FILE_REQUIRED: pass --evidence-file');
  const checked = checkBaseEvidenceFile(input.evidenceText, input.now);
  const phrase = checked.fileDigest ? baseEnablePhrase(checked.fileDigest) : undefined;
  const enabledNow = current ? { since: current.approvedAt, until: current.expiresAt === PERMANENT_ENABLEMENT_EXPIRY ? 'you revoke it' : current.expiresAt } : null;
  if (input.action === 'status') return { state: checked.evidence && phrase ? 'ReadyToRecord' : 'NotReady', problems: checked.problems, enabledNow, ...(phrase && checked.evidence ? { copyThisToRecord: `base-enable record --evidence-file ${input.evidenceFile} --confirm "${phrase}"` } : {}), ...(current ? { toRevoke: 'base-enable revoke (prints the phrase to type)' } : {}) };
  if (!checked.evidence || !checked.fileDigest || checked.problems.length > 0) throw new Error(`EVIDENCE_INCOMPLETE: ${checked.problems.join(' ')}`);
  if (input.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run base-enable status and copy its phrase exactly');
  const approvedAt = input.now.toISOString();
  input.store.enableBase({ id: input.newId(), approvedAt, expiresAt: PERMANENT_ENABLEMENT_EXPIRY, evidence: checked.evidence, evidenceDigest: checked.fileDigest, confirmationDigest: createHash('sha256').update(`${phrase}\n${checked.fileDigest}`).digest('hex'), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' });
  return { state: 'Enabled', message: 'Base free attended execution is on until you revoke it (base-enable revoke). Paid Base remains disabled. The kill switch still stops everything at once.', paidAllowed: false };
}
