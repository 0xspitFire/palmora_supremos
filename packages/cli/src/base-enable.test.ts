import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE_EVIDENCE_STEPS } from '@mint-bot/backend';
import { baseEnablePhrase, baseRevokePhrase, runBaseEnable } from './base-enable.js';

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

  it('status and record need the evidence file', () => {
    expect(() => runBaseEnable({ action: 'record', now: NOW, store: store().store as never, newId: () => 'x' })).toThrow('EVIDENCE_FILE_REQUIRED');
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
