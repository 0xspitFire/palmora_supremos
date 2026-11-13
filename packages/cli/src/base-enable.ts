import { createHash } from 'node:crypto';
import { SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE, SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE, validFreeSignedRehearsalReference, BASE_EVIDENCE_STEPS, BASE_PAID_EVIDENCE_STEPS, PERMANENT_ENABLEMENT_EXPIRY, validBaseEnablement, type BaseEvidenceStep, type BasePaidEvidenceStep } from '@mint-bot/backend';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validEvidenceDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}


export interface BaseEvidenceCheck { readonly problems: readonly string[]; readonly fileDigest?: string; readonly evidence?: Record<BaseEvidenceStep, true> & Partial<Record<BasePaidEvidenceStep, true>>; }

export function checkBaseEvidenceFile(text: string, now: Date, paid = false, includeFreeSigned = false): BaseEvidenceCheck {
  const storedSteps: readonly string[] = paid ? [...BASE_EVIDENCE_STEPS, ...BASE_PAID_EVIDENCE_STEPS] : BASE_EVIDENCE_STEPS;
  const steps = [...storedSteps, ...(includeFreeSigned ? ['freeSignedRehearsal'] : [])];
  const fileDigest = createHash('sha256').update(text).digest('hex');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { problems: ['The evidence file is not valid JSON.'] }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { problems: ['The evidence file must be an object.'] };
  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (Object.keys(record).length !== steps.length || Object.keys(record).some((key) => !steps.includes(key))) problems.push(includeFreeSigned ? 'The evidence file must include the exact Base steps and freeSignedRehearsal for the signed scope.' : paid ? 'The paid evidence file must contain exactly the seven Base steps plus paidRehearsal and paidPolicyApproved.' : 'The evidence file must contain exactly the seven Base evidence steps.');
  for (const step of steps) {
    const entry = record[step];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problems.push(`${step} is missing.`); continue; }
    const item = entry as Record<string, unknown>;
    if (item['passed'] !== true) { problems.push(`${step} is not marked passed.`); continue; }
    if (!validEvidenceDate(item['checkedOn'])) { problems.push(`${step} needs a YYYY-MM-DD date.`); continue; }
    const age = (now.getTime() - Date.parse(`${item['checkedOn']}T00:00:00.000Z`)) / 86_400_000;
    const maxAge = step === 'liveSimulation' || step === 'custodyReadiness' ? 1 : step === 'feeObservation' ? 1 : step === 'paidRehearsal' || step === 'paidPolicyApproved' ? 30 : 7;
    if (age < -1 || age > maxAge) problems.push(`${step} evidence is outside its ${maxAge}-day freshness window.`);
    if (step === 'freeSignedRehearsal' && !validFreeSignedRehearsalReference(item['reference'])) problems.push('freeSignedRehearsal needs a safe artifact reference, not credentials or an endpoint URL.');
    if (typeof item['reference'] !== 'string' || item['reference'].trim().length < 5 || item['reference'].length > 300) problems.push(`${step} needs a short evidence reference.`);
  }
  return problems.length === 0 ? { problems, fileDigest, evidence: Object.fromEntries(storedSteps.map((step) => [step, true])) as Record<BaseEvidenceStep, true> & Partial<Record<BasePaidEvidenceStep, true>> } : { problems, fileDigest };
}

/** D-062: permanent until revoked. */
export function baseEnablePhrase(digest: string, paid = false, includeFreeAllowlist = false, includeFreeSigned = false): string { return `ENABLE-BASE-${paid ? 'PAID' : 'FREE'} PERMANENT ${digest.slice(0, 8)} LOCAL-ATTENDED${includeFreeSigned ? ' CHAIN-8453 PUBLIC+FREE-ALLOWLIST+FREE-SIGNED-V1' : includeFreeAllowlist ? ' CHAIN-8453 PUBLIC+FREE-ALLOWLIST-V1' : ''}`; }

/** Names the record being revoked, so a copied phrase cannot revoke a later one. */
export function baseRevokePhrase(recordId: string): string { return `REVOKE-BASE ${createHash('sha256').update(recordId, 'utf8').digest('hex').slice(0, 8)}`; }

export interface BaseEnableStore {
  baseEnablement(): unknown;
  revokeBase(input: { id: string; confirmationDigest: string; expectedEnablementId?: string }): { enablementId: string };
  enableBase(input: { id: string; approvedAt: string; expiresAt: string; evidence: Record<BaseEvidenceStep, true> & Partial<Record<BasePaidEvidenceStep, true>>; paidAllowed?: boolean; evidenceDigest: string; confirmationDigest: string; strategyVersion: string; feePolicyVersion: string; primaryEndpointReference: string; fallbackEndpointReference: string; custodyMode: 'local-personal-live' }): void;
}

export function runBaseEnable(input: { action: 'status' | 'record' | 'revoke'; evidenceText?: string; evidenceFile?: string; paid?: boolean; includeFreeAllowlist?: boolean; includeFreeSigned?: boolean; confirm?: string; now: Date; store: BaseEnableStore; newId(): string }): Record<string, unknown> {
  const current = validBaseEnablement(input.store.baseEnablement(), input.now);
  if (input.action === 'revoke') {
    if (!current) throw new Error('NOTHING_TO_REVOKE: Base is not enabled');
    const phrase = baseRevokePhrase(current.recordId);
    if (input.confirm !== phrase) return { state: 'ConfirmToRevoke', message: 'Revoking switches Base execution off at once. Runs already in flight are not undone; new ones are refused.', enabledSince: current.approvedAt, copyThisToRevoke: `base-enable revoke --confirm "${phrase}"` };
    const revoked = input.store.revokeBase({ id: input.newId(), confirmationDigest: createHash('sha256').update(`${phrase}\n${current.recordId}`).digest('hex'), expectedEnablementId: current.recordId });
    return { state: 'Revoked', message: 'Base execution is off. Record a new enablement to switch it on again.', revokedEnablement: revoked.enablementId };
  }
  const enabledNow = current ? { since: current.approvedAt, until: current.expiresAt === PERMANENT_ENABLEMENT_EXPIRY ? 'you revoke it' : current.expiresAt, paidAllowed: current.paidAllowed } : null;
  // Inspecting an already approved grant is not a request to create or renew one. The original evidence's age does not revoke it.
  if (input.action === 'status' && input.evidenceText === undefined && input.evidenceFile === undefined) {
    return current
      ? { state: 'Enabled', inspection: 'current-grant', enabledNow, recordId: current.recordId, expiresAt: current.expiresAt, permanent: current.expiresAt === PERMANENT_ENABLEMENT_EXPIRY, paidAllowed: current.paidAllowed, evidenceDigest: current.evidenceDigest, strategyVersion: current.strategyVersion, feePolicyVersion: current.feePolicyVersion, message: `Base ${current.paidAllowed ? 'paid and free' : 'free'} enablement is on ${current.expiresAt === PERMANENT_ENABLEMENT_EXPIRY ? 'until you revoke it' : `until ${current.expiresAt}`}. No evidence file is needed to inspect this grant.`, toRevoke: 'base-enable revoke (prints the phrase to type)' }
      : { state: 'Disabled', inspection: 'current-grant', enabledNow: null, next: 'NeedsEvidence', message: 'No valid Base enablement is installed. Supply --evidence-file to preview a new grant; recording it requires fresh evidence and its confirmation phrase.' };
  }
  if (input.evidenceText === undefined || input.evidenceFile === undefined) throw new Error('EVIDENCE_FILE_REQUIRED: pass --evidence-file');
  const paid = input.paid === true;
  const checked = checkBaseEvidenceFile(input.evidenceText, input.now, paid, input.includeFreeSigned);
  const phrase = checked.fileDigest ? baseEnablePhrase(checked.fileDigest, paid, input.includeFreeAllowlist, input.includeFreeSigned) : undefined;
  if (input.action === 'status') return { state: checked.evidence && phrase ? 'ReadyToRecord' : 'NotReady', inspection: 'new-grant-evidence', installedStrategyVersion: current?.strategyVersion ?? null, requestedStrategyVersion: input.includeFreeSigned ? SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE : input.includeFreeAllowlist ? SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE : 'seadrop-v1-public', strategyScope: input.includeFreeSigned ? 'public, free allowlist and free signed v1' : input.includeFreeAllowlist ? 'public and free allowlist v1' : 'public only', message: checked.evidence ? 'The supplied evidence is ready to record a new grant.' : 'The supplied evidence is not ready for a new grant. See enabledNow for the separate status of any existing grant.', problems: checked.problems, enabledNow, ...(phrase && checked.evidence ? { copyThisToRecord: `base-enable record --evidence-file ${input.evidenceFile}${paid ? ' --paid' : ''}${input.includeFreeSigned ? ' --include-free-signed' : input.includeFreeAllowlist ? ' --include-free-allowlist' : ''} --confirm "${phrase}"` } : {}), ...(current ? { toRevoke: 'base-enable revoke (prints the phrase to type)' } : {}) };
  if (!checked.evidence || !checked.fileDigest || checked.problems.length > 0) throw new Error(`EVIDENCE_INCOMPLETE: ${checked.problems.join(' ')}`);
  if (input.confirm !== phrase) throw new Error('CONFIRMATION_PHRASE_MISMATCH: run base-enable status and copy its phrase exactly');
  const approvedAt = input.now.toISOString();
  input.store.enableBase({ id: input.newId(), approvedAt, expiresAt: PERMANENT_ENABLEMENT_EXPIRY, ...(paid ? { paidAllowed: true } : {}), evidence: checked.evidence, evidenceDigest: checked.fileDigest, confirmationDigest: createHash('sha256').update(`${phrase}\n${checked.fileDigest}`).digest('hex'), strategyVersion: input.includeFreeSigned ? SEADROP_PUBLIC_FREE_ALLOWLIST_SIGNED_BASELINE : input.includeFreeAllowlist ? SEADROP_PUBLIC_FREE_ALLOWLIST_BASELINE : 'seadrop-v1-public', feePolicyVersion: paid ? 'base-paid-d062' : 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' });
  return { state: 'Enabled', message: `Base ${paid ? 'paid and free' : 'free'} attended execution is on until you revoke it (base-enable revoke).${paid ? '' : ' Paid Base stays blocked.'} The kill switch still stops everything at once.`, paidAllowed: paid };
}
