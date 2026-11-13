import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE_EVIDENCE_STEPS } from '@mint-bot/backend';
import { baseEnablePhrase, baseRevokePhrase, checkBaseEvidenceFile, runBaseEnable } from './base-enable.js';

/** D-062: Base free attended enablement lasts until the owner revokes it; the owner command writes and revokes it with typed phrases. */
const NOW = new Date('2026-10-23T12:00:00.000Z');
const file = JSON.stringify(Object.fromEntries(BASE_EVIDENCE_STEPS.map((step) => [step, { passed: true, checkedOn: '2026-10-23', reference: `${step} evidence reference` }])));
const digest = createHash('sha256').update(file).digest('hex');
const PERM = '9999-12-31T23:59:59.999Z';
const current = { recordId: 'base-1', approvedBy: 'owner-cli', approvedAt: '2026-10-23T10:00:00.000Z', expiresAt: PERM, freeAllowed: true, paidAllowed: false, evidence: Object.fromEntries(BASE_EVIDENCE_STEPS.map((step) => [step, true])), evidenceDigest: 'a'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' };

function store(record?: unknown) {
  const writes: Array<Record<string, unknown>> = [];
  const revokes: unknown[] = [];
  return { writes, revokes, store: { baseEnablement: () => record, enableBase: (input: Record<string, unknown>) => { writes.push(input); }, revokeBase: (input: unknown) => { revokes.push(input); return { enablementId: 'base-1' }; } } };
}
const run = (s: ReturnType<typeof store>['store'], over: Record<string, unknown> = {}) => runBaseEnable({ action: 'record', evidenceText: file, evidenceFile: 'b.json', confirm: baseEnablePhrase(digest), now: NOW, store: s as never, newId: () => 'base-new', ...over } as never);

describe('base-enable (D-062)', () => {
  it('status prints the permanent phrase and writes nothing', () => {
    const s = store();
    const out = run(s.store, { action: 'status', confirm: undefined });
    expect(out).toMatchObject({ state: 'ReadyToRecord', problems: [], enabledNow: null });
    expect(String(out.copyThisToRecord)).toContain(`ENABLE-BASE-FREE PERMANENT ${digest.slice(0, 8)} LOCAL-ATTENDED`);
    expect(s.writes).toEqual([]);
  });

  it('record writes once, with the "until revoked" expiry; the old day-limited phrase is refused', () => {
    const s = store();
    expect(run(s.store)).toMatchObject({ state: 'Enabled', paidAllowed: false });
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0]).toMatchObject({ id: 'base-new', approvedAt: NOW.toISOString(), expiresAt: PERM });
    const old = store();
    expect(() => run(old.store, { confirm: `ENABLE-BASE-FREE 7-DAYS ${digest.slice(0, 8)} LOCAL-ATTENDED` })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(old.writes).toEqual([]);
  });

  it('shows the current enablement as lasting until revoked', () => {
    expect(run(store(current).store, { action: 'status', confirm: undefined }).enabledNow).toEqual({ since: '2026-10-23T10:00:00.000Z', until: 'you revoke it', paidAllowed: false });
  });

  it('revoke: phrase first, then only the exact phrase revokes; nothing to revoke is refused', () => {
    const s = store(current);
    expect(runBaseEnable({ action: 'revoke', now: NOW, store: s.store as never, newId: () => 'rev' })).toMatchObject({ state: 'ConfirmToRevoke', copyThisToRevoke: `base-enable revoke --confirm "${baseRevokePhrase('base-1')}"` });
    expect(s.revokes).toEqual([]);
    expect(runBaseEnable({ action: 'revoke', confirm: baseRevokePhrase('base-1'), now: NOW, store: s.store as never, newId: () => 'rev' })).toMatchObject({ state: 'Revoked' });
    expect(s.revokes).toHaveLength(1);
    expect(() => runBaseEnable({ action: 'revoke', confirm: baseRevokePhrase('base-1'), now: NOW, store: store().store as never, newId: () => 'rev' })).toThrow('NOTHING_TO_REVOKE');
  });

  it('record still needs the evidence file', () => {
    expect(() => runBaseEnable({ action: 'record', now: NOW, store: store().store as never, newId: () => 'x' })).toThrow('EVIDENCE_FILE_REQUIRED');
  });

  it('inspects a permanent grant months later without evidence, a new ID, or writes', () => {
    const s = store(current);
    const result = runBaseEnable({ action: 'status', now: new Date('2027-08-01T00:00:00.000Z'), store: s.store as never, newId: () => { throw new Error('must not allocate'); } });
    expect(result).toMatchObject({ state: 'Enabled', inspection: 'current-grant', recordId: 'base-1', permanent: true, expiresAt: PERM, paidAllowed: false, enabledNow: { until: 'you revoke it' } });
    expect(result.copyThisToRecord).toBeUndefined();
    expect(s.writes).toEqual([]);
    expect(s.revokes).toEqual([]);
  });

  it('reports absent, revoked, expired or malformed grants disabled and never extends a finite grant', () => {
    for (const record of [undefined, { ...current, revokedAt: NOW.toISOString() }, { ...current, expiresAt: '2026-10-22T00:00:00.000Z' }, { ...current, freeAllowed: false }]) {
      const s = store(record);
      expect(runBaseEnable({ action: 'status', now: NOW, store: s.store as never, newId: () => 'unused' })).toMatchObject({ state: 'Disabled', next: 'NeedsEvidence', enabledNow: null });
      expect(s.writes).toEqual([]);
    }
    const s = store({ ...current, expiresAt: '2026-10-24T00:00:00.000Z' });
    expect(runBaseEnable({ action: 'status', now: NOW, store: s.store as never, newId: () => 'unused' })).toMatchObject({ state: 'Enabled', permanent: false, expiresAt: '2026-10-24T00:00:00.000Z', enabledNow: { until: '2026-10-24T00:00:00.000Z' } });
    expect(s.writes).toEqual([]);
  });

  it('separates a stale new-grant preview from an enabled permanent grant and retains paid upgrade freshness', () => {
    const later = new Date('2027-01-01T12:00:00.000Z');
    const s = store(current);
    const preview = run(s.store, { action: 'status', now: later });
    expect(preview).toMatchObject({ state: 'NotReady', inspection: 'new-grant-evidence', enabledNow: { until: 'you revoke it', paidAllowed: false } });
    expect(preview.copyThisToRecord).toBeUndefined();
    expect(() => run(s.store, { now: later })).toThrow('EVIDENCE_INCOMPLETE');
    const paidFile = JSON.stringify(Object.fromEntries([...BASE_EVIDENCE_STEPS, 'paidRehearsal', 'paidPolicyApproved'].map((step) => [step, { passed: true, checkedOn: '2026-10-23', reference: `${step} evidence reference` }])));
    const paidPreview = run(s.store, { action: 'status', now: later, evidenceText: paidFile, paid: true });
    expect(paidPreview).toMatchObject({ state: 'NotReady', enabledNow: { paidAllowed: false } });
    expect(String(paidPreview.problems)).toContain('30-day freshness window');
    expect(() => run(s.store, { now: later, evidenceText: paidFile, paid: true })).toThrow('EVIDENCE_INCOMPLETE');
    expect(s.writes).toEqual([]);
  });

  it('D-062 item 3: --paid needs the two paid steps in the file and its own phrase, and records paidAllowed', () => {
    const paidFile = JSON.stringify(Object.fromEntries([...BASE_EVIDENCE_STEPS, 'paidRehearsal', 'paidPolicyApproved'].map((step) => [step, { passed: true, checkedOn: '2026-10-23', reference: `${step} evidence reference` }])));
    const paidDigest = createHash('sha256').update(paidFile).digest('hex');
    const s = store();
    expect(String(run(s.store, { action: 'status', evidenceText: paidFile, paid: true, confirm: undefined }).copyThisToRecord)).toContain(`--paid --confirm "ENABLE-BASE-PAID PERMANENT ${paidDigest.slice(0, 8)} LOCAL-ATTENDED"`);
    expect(() => run(s.store, { evidenceText: paidFile, paid: true, confirm: baseEnablePhrase(paidDigest) })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(run(s.store, { evidenceText: paidFile, paid: true, confirm: baseEnablePhrase(paidDigest, true) })).toMatchObject({ state: 'Enabled', paidAllowed: true });
    expect(s.writes[0]).toMatchObject({ paidAllowed: true, evidence: { paidRehearsal: true, paidPolicyApproved: true } });
    // a free file cannot be recorded as paid
    expect(() => run(store().store, { paid: true, confirm: baseEnablePhrase(digest, true) })).toThrow('EVIDENCE_INCOMPLETE');
  });
});

it('adds explicit free allowlist scope only with the chain-bound owner confirmation', () => {
  const s = store();
  const preview = run(s.store, { action: 'status', includeFreeAllowlist: true });
  expect(String(preview.copyThisToRecord)).toContain('--include-free-allowlist');
  expect(String(preview.copyThisToRecord)).toContain('CHAIN-8453 PUBLIC+FREE-ALLOWLIST-V1');
  expect(() => run(s.store, { includeFreeAllowlist: true })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
  run(s.store, { includeFreeAllowlist: true, confirm: baseEnablePhrase(digest, false, true) });
  expect(s.writes[0]).toMatchObject({ strategyVersion: 'seadrop-v1-baseline-public-free-allowlist@1' });
  const legacy = store(); run(legacy.store);
  expect(legacy.writes[0]?.strategyVersion).toBe('seadrop-v1-public');
  expect(s.writes[0]?.confirmationDigest).not.toBe(legacy.writes[0]?.confirmationDigest);
});

it.each(['2026-99-99', '2026-02-31'])('refuses invalid initial Base evidence date %s rather than accepting NaN or normalization', checkedOn => {
  const text = JSON.stringify(Object.fromEntries(BASE_EVIDENCE_STEPS.map(step => [step, { passed: true, checkedOn: step === 'reviewedCode' ? checkedOn : '2026-03-03', reference: 'Reviewed evidence reference' }])));
  const checked = checkBaseEvidenceFile(text, new Date('2026-03-03T12:00:00.000Z'));
  expect(checked.evidence).toBeUndefined();
  expect(checked.problems.join(' ')).toContain('reviewedCode needs a YYYY-MM-DD date');
});


describe('explicit Base free signed scope', () => {
  const signedFile = JSON.stringify({ ...JSON.parse(file), freeSignedRehearsal: { passed: true, checkedOn: '2026-10-23', reference: 'artifacts/base-free-signed-replay.json' } });
  const signedDigest = createHash('sha256').update(signedFile).digest('hex');

  it('requires a signed rehearsal and new exact phrase without changing previous grants', () => {
    const s = store(current);
    expect(run(s.store, { action: 'status', includeFreeSigned: true })).toMatchObject({ state: 'NotReady', installedStrategyVersion: 'seadrop-v1-public' });
    expect(() => run(s.store, { includeFreeSigned: true })).toThrow('EVIDENCE_INCOMPLETE');
    const preview = run(s.store, { action: 'status', evidenceText: signedFile, includeFreeSigned: true });
    expect(preview).toMatchObject({ state: 'ReadyToRecord', requestedStrategyVersion: 'seadrop-v1-baseline-public-free-allowlist-free-signed@1' });
    expect(String(preview.copyThisToRecord)).toContain('--include-free-signed');
    expect(String(preview.copyThisToRecord)).toContain('CHAIN-8453 PUBLIC+FREE-ALLOWLIST+FREE-SIGNED-V1');
    expect(() => run(s.store, { evidenceText: signedFile, includeFreeSigned: true, confirm: baseEnablePhrase(signedDigest, false, true) })).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(s.writes).toEqual([]);
    run(s.store, { evidenceText: signedFile, includeFreeSigned: true, confirm: baseEnablePhrase(signedDigest, false, false, true) });
    expect(s.writes[0]).toMatchObject({ strategyVersion: 'seadrop-v1-baseline-public-free-allowlist-free-signed@1', evidenceDigest: signedDigest });
    expect(s.writes[0]?.paidAllowed).toBeUndefined();
    expect(Object.keys(s.writes[0]?.evidence as object)).toHaveLength(BASE_EVIDENCE_STEPS.length);
    expect(current.strategyVersion).toBe('seadrop-v1-public');
  });

  it.each([
    { passed: false, checkedOn: '2026-10-23', reference: 'artifacts/base-free-signed-replay.json' },
    { passed: true, checkedOn: '2026-09-01', reference: 'artifacts/base-free-signed-replay.json' },
    { passed: true, checkedOn: '2026-10-23', reference: 'https://credential.example/private' },
  ])('refuses incomplete, stale or unsafe signed rehearsal %#', freeSignedRehearsal => {
    const checked = checkBaseEvidenceFile(JSON.stringify({ ...JSON.parse(file), freeSignedRehearsal }), NOW, false, true);
    expect(checked.evidence).toBeUndefined();
    expect(checked.problems.join(' ')).toContain('freeSignedRehearsal');
  });
});
