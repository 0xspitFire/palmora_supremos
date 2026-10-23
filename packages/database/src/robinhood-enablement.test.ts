import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository } from './repositories.js';

// The database also compares a record's expiry with its own clock, so the times here are relative to now.
const T0 = new Date().toISOString();
const day = (offset: number, base = T0): string => new Date(Date.parse(base) + offset * 86_400_000).toISOString();
const DIGEST = 'a'.repeat(64);
// D-062: every new enablement lasts until the owner revokes it.
const PERM = '9999-12-31T23:59:59.999Z';
const EVIDENCE = { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } as const;
const PAID_EVIDENCE = { ...EVIDENCE, paidRehearsal: true, paidPolicyApproved: true } as const;
const SEQ = 'https://sequencer.mainnet.chain.robinhood.com';
const ARCH = 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_ARCHIVE_RPC';

function setup() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('rh', 4663, 'Robinhood', '[]', 1, ?)").run(T0);
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('eth', 1, 'Ethereum', '[]', 2, ?)").run(T0);
  const repository = new DurableRepository(db);
  const enable = (id: string, approvedAt = T0, expiresAt = PERM) => repository.enableRobinhood({ id, approvedAt, expiresAt, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: `ver-${id}`, sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH });
  const insertRow = (overrides: Record<string, unknown> = {}) => {
    const row = { id: `row-${Math.random()}`, approved_by: 'owner-cli', approved_at: T0, expires_at: PERM, paid_allowed: 0, evidence_json: JSON.stringify(EVIDENCE), confirmation_digest: DIGEST, created_at: T0, ...overrides };
    return db.prepare('INSERT INTO robinhood_enablement (id, approved_by, approved_at, expires_at, paid_allowed, evidence_json, confirmation_digest, created_at) VALUES (@id, @approved_by, @approved_at, @expires_at, @paid_allowed, @evidence_json, @confirmation_digest, @created_at)').run(row);
  };
  const profile = () => db.prepare("SELECT execution_enabled AS enabled, verification_status AS status FROM chain_profile WHERE id = 'rh'").get() as { enabled: number; status: string };
  const forceEnable = (approvedAt: string | null) => db.prepare("UPDATE chain_profile SET verification_status = 'verified', verification_evidence_json = ?, verification_approved_by = 'owner-cli', verification_approved_at = ?, execution_enabled = 1 WHERE id = 'rh'").run(JSON.stringify({ finalityPassed: true }), approvedAt);
  return { db, repository, enable, insertRow, profile, forceEnable };
}

describe('Robinhood stays blocked in the database without an enablement record (migration 023)', () => {
  it('refuses to verify or enable chain 4663 with no record, as before', () => {
    const t = setup();
    expect(() => t.db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'rh'").run()).toThrow(/execution requires verified non-Robinhood chain/);
    expect(() => t.db.prepare("UPDATE chain_profile SET verification_status = 'verified' WHERE id = 'rh'").run()).toThrow(/cannot be execution verified/);
    expect(() => t.forceEnable(T0)).toThrow();
    expect(() => t.db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, execution_enabled, verification_status, verification_evidence_json, verification_approved_by, verification_approved_at, created_at) VALUES ('rh2', 4663, 'R2', '[]', 1, 1, 'verified', '{\"finalityPassed\":true}', 'owner-cli', ?, ?)").run(T0, T0)).toThrow(/execution requires verified non-Robinhood chain/);
    expect(t.profile()).toEqual({ enabled: 0, status: 'unverified' });
  });

  it('leaves other chains exactly as they were', () => {
    const t = setup();
    expect(() => t.db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'eth'").run()).toThrow(/execution requires verified non-Robinhood chain/);
    t.db.prepare("UPDATE chain_profile SET verification_status = 'verified', verification_evidence_json = ?, verification_approved_by = 'x', verification_approved_at = ?, execution_enabled = 1 WHERE id = 'eth'").run(JSON.stringify({ finalityPassed: true }), T0);
    expect(t.db.prepare("SELECT execution_enabled AS e FROM chain_profile WHERE id = 'eth'").get()).toEqual({ e: 1 });
  });
});

describe('enableRobinhood: one transaction writes the record, the evidence and the enabled profile', () => {
  it('enables chain 4663 with a complete record, and reads it back', () => {
    const t = setup();
    t.enable('rh-1');
    expect(t.profile()).toEqual({ enabled: 1, status: 'verified' });
    const row = t.repository.latestRobinhoodEnablement();
    expect(row).toMatchObject({ id: 'rh-1', approvedBy: 'owner-cli', approvedAt: T0, expiresAt: PERM, paidAllowed: false, evidence: EVIDENCE });
    expect(t.db.prepare("SELECT status, approved_by AS by FROM chain_verification WHERE id = 'ver-rh-1'").get()).toEqual({ status: 'verified', by: 'owner-cli' });
  });

  it('rolls everything back when any part is refused (no row without the profile change)', () => {
    const t = setup();
    expect(() => t.repository.enableRobinhood({ id: 'bad', approvedAt: T0, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: 'v', sequencerEndpointReference: 'https://evil.example', archiveEndpointReference: ARCH })).toThrow();
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
    expect(t.profile().enabled).toBe(0);
  });

  it('refuses incomplete evidence or a bad digest before touching the database', () => {
    const t = setup();
    const chain = { chainProfileId: 'rh', verificationId: 'v', sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH };
    const missing = { ...EVIDENCE } as Record<string, unknown>;
    delete missing.E3;
    expect(() => t.repository.enableRobinhood({ id: 'a', approvedAt: T0, expiresAt: PERM, evidence: missing as never, paidAllowed: false, confirmationDigest: DIGEST }, chain)).toThrow(/E1 to E7/);
    expect(() => t.repository.enableRobinhood({ id: 'b', approvedAt: T0, expiresAt: PERM, evidence: { ...EVIDENCE, E4: false } as never, paidAllowed: false, confirmationDigest: DIGEST }, chain)).toThrow(/E1 to E7/);
    expect(() => t.repository.enableRobinhood({ id: 'c', approvedAt: T0, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: false, confirmationDigest: 'ABC' }, chain)).toThrow(/digest/);
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
  });
});

describe('the enablement table accepts only complete rows (direct SQL cannot cheat)', () => {
  it('accepts exactly one well-formed row', () => {
    const t = setup();
    expect(() => t.insertRow({ id: 'ok' })).not.toThrow();
  });

  it('refuses a row with the wrong author, incomplete paid evidence, a bad digest or bad times', () => {
    const t = setup();
    for (const bad of [
      { approved_by: 'session' }, { approved_by: 'owner' }, { paid_allowed: 1 }, { confirmation_digest: 'A'.repeat(64) }, { confirmation_digest: 'a'.repeat(63) },
      { approved_at: 'yesterday' },
      // D-062: anything but the "until revoked" expiry is refused, including the old 7-day form
      { expires_at: '2026-10-27' }, { expires_at: T0 }, { expires_at: day(-1) }, { expires_at: day(7) }, { expires_at: day(30) }, { expires_at: '9999-12-31' },
    ]) expect(() => t.insertRow(bad), JSON.stringify(bad)).toThrow();
  });

  it('allows paid only with exactly both paid evidence keys', () => {
    const t = setup();
    expect(() => t.insertRow({ id: 'paid-ok', paid_allowed: 1, evidence_json: JSON.stringify(PAID_EVIDENCE) })).not.toThrow();
    const t2 = setup();
    expect(() => t2.insertRow({ paid_allowed: 1, evidence_json: JSON.stringify({ ...EVIDENCE, paidRehearsal: true }) })).toThrow(/incomplete/);
    expect(() => t2.insertRow({ paid_allowed: 0, evidence_json: JSON.stringify(PAID_EVIDENCE) })).toThrow(/incomplete/);
  });

  it('refuses a row without all of E1 to E7 exactly true', () => {
    const t = setup();
    for (const step of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']) {
      const missing = { ...EVIDENCE } as Record<string, unknown>;
      delete missing[step];
      expect(() => t.insertRow({ evidence_json: JSON.stringify(missing) }), `missing ${step}`).toThrow(/incomplete/);
      for (const wrong of [false, 1, 'true', null]) expect(() => t.insertRow({ evidence_json: JSON.stringify({ ...EVIDENCE, [step]: wrong }) }), `${step}=${String(wrong)}`).toThrow(/incomplete/);
    }
    expect(() => t.insertRow({ evidence_json: JSON.stringify({ ...EVIDENCE, E8: true }) })).toThrow(/incomplete/);
    expect(() => t.insertRow({ evidence_json: '[true,true,true,true,true,true,true]' })).toThrow(/incomplete/);
    expect(() => t.insertRow({ evidence_json: 'not json' })).toThrow(/incomplete/);
  });

  it('never allows a change or deletion, and a new row must not be older than the last', () => {
    const t = setup();
    t.insertRow({ id: 'first', approved_at: day(1) });
    expect(() => t.db.prepare("UPDATE robinhood_enablement SET expires_at = ? WHERE id = 'first'").run(day(6))).toThrow(/immutable/);
    expect(() => t.db.prepare("DELETE FROM robinhood_enablement WHERE id = 'first'").run()).toThrow(/immutable/);
    expect(() => t.insertRow({ id: 'older', approved_at: day(0) })).toThrow(/newer/);
    expect(() => t.insertRow({ id: 'newer', approved_at: day(2) })).not.toThrow();
  });
});

describe('the profile can be enabled only from the newest record onwards (D-062: no end until revoked)', () => {
  it('refuses an approval time before the record or none, and accepts any time after it', () => {
    const t = setup();
    t.insertRow({ id: 'w', approved_at: T0 });
    expect(() => t.forceEnable(day(-0.01))).toThrow();
    expect(() => t.forceEnable(null)).toThrow();
    expect(() => t.forceEnable(day(300))).not.toThrow();
    expect(t.profile().enabled).toBe(1);
  });

  it('lets the newest record alone decide', () => {
    const t = setup();
    t.insertRow({ id: 'one', approved_at: T0 });
    t.insertRow({ id: 'two', approved_at: day(8) });
    expect(() => t.forceEnable(day(3))).toThrow(); // after the first record, but before the newest one
    expect(() => t.forceEnable(day(9))).not.toThrow();
  });

  it('does not let a later change of the approval time move an enabled profile to before the record', () => {
    const t = setup();
    t.enable('rh-1');
    expect(() => t.db.prepare("UPDATE chain_profile SET verification_approved_at = ? WHERE id = 'rh'").run(day(-1))).toThrow();
    expect(t.profile().enabled).toBe(1);
  });
});

describe('paid Robinhood enablement (migration 024)', () => {
  it('writes the immutable paid record and replaces the active fee policy with D-041-compatible paid admission', () => {
    const t = setup();
    t.db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('old-free', 'rh', 'free', 'fee_only', '200000000000000', '200000000000000', '0', 2, 0, 1, ?, 'allowed')").run(T0);
    t.repository.enableRobinhood({ id: 'paid-record', approvedAt: T0, expiresAt: PERM, evidence: { ...PAID_EVIDENCE }, paidAllowed: true, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: 'paid-verification', sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH, paidFeePolicy: { id: 'paid-fee', version: 'd054', maxTotalFeeWei: 370000000000000n, freeCapWei: 200000000000000n } });
    expect(t.repository.latestRobinhoodEnablement()).toMatchObject({ paidAllowed: true, evidence: PAID_EVIDENCE });
    expect(t.db.prepare("SELECT active FROM fee_policy WHERE id = 'old-free'").get()).toEqual({ active: 0 });
    expect(t.db.prepare("SELECT paid_mints_enabled AS paid, max_total_fee_wei AS fee, active FROM fee_policy WHERE id = 'paid-fee'").get()).toEqual({ paid: 1, fee: '370000000000000', active: 1 });
  });

  it('rolls back when paid evidence or the paid fee policy is missing', () => {
    const t = setup();
    const chain = { chainProfileId: 'rh', verificationId: 'v', sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH };
    expect(() => t.repository.enableRobinhood({ id: 'missing-evidence', approvedAt: T0, expiresAt: PERM, evidence: { ...EVIDENCE }, paidAllowed: true, confirmationDigest: DIGEST }, chain)).toThrow();
    expect(() => t.repository.enableRobinhood({ id: 'missing-policy', approvedAt: T0, expiresAt: PERM, evidence: { ...PAID_EVIDENCE }, paidAllowed: true, confirmationDigest: DIGEST }, chain)).toThrow(/paid fee policy/);
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
  });
});

describe('revocation (D-062): the owner ends an enablement; nothing else does', () => {
  it('revokes the newest enablement, switches the profile off and records it, in one transaction', () => {
    const t = setup();
    t.enable('rh-1');
    expect(t.repository.revokeEnablement(4663, { id: 'rev-1', revokedAt: day(0.5), confirmationDigest: DIGEST })).toEqual({ enablementId: 'rh-1' });
    expect(t.profile().enabled).toBe(0);
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
    expect(t.repository.enablementRevocation('rh-1')).toEqual({ id: 'rev-1', revokedAt: day(0.5) });
    expect(t.db.prepare("SELECT count(*) AS n FROM audit_event WHERE id = 'enablement-revoked:rev-1'").get()).toEqual({ n: 1 });
  });

  it('a revoked record can never switch the profile back on, by any route; a newer record can', () => {
    const t = setup();
    t.enable('rh-1');
    t.repository.revokeEnablement(4663, { id: 'rev-1', revokedAt: day(0.5), confirmationDigest: DIGEST });
    expect(() => t.forceEnable(day(1))).toThrow();
    expect(() => t.db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'rh'").run()).toThrow(/execution requires verified non-Robinhood chain/);
    expect(t.repository.disableRobinhoodIfNotEnabled(new Date(day(1)))).toBe(false); // already off
    t.enable('rh-2', day(2));
    expect(t.profile().enabled).toBe(1);
    expect(t.repository.latestRobinhoodEnablement()).toMatchObject({ id: 'rh-2' });
  });

  it('refuses to revoke twice, nothing, an older record, a bad digest, or with a time before the record; revocations are immutable', () => {
    const t = setup();
    expect(() => t.repository.revokeEnablement(4663, { id: 'r0', revokedAt: T0, confirmationDigest: DIGEST })).toThrow('NOTHING_TO_REVOKE');
    t.enable('rh-1');
    expect(() => t.repository.revokeEnablement(4663, { id: 'r1', revokedAt: T0, confirmationDigest: 'ABC' })).toThrow(/digest/);
    expect(() => t.db.prepare("INSERT INTO chain_enablement_revocation (id, chain_id, enablement_id, approved_by, revoked_at, confirmation_digest, created_at) VALUES ('r2', 4663, 'rh-1', 'owner-cli', ?, ?, ?)").run(day(-1), DIGEST, T0)).toThrow(/newest enablement/);
    t.repository.revokeEnablement(4663, { id: 'r3', revokedAt: day(0.1), confirmationDigest: DIGEST });
    expect(() => t.repository.revokeEnablement(4663, { id: 'r4', revokedAt: day(0.2), confirmationDigest: DIGEST })).toThrow('NOTHING_TO_REVOKE');
    expect(() => t.db.prepare("INSERT INTO chain_enablement_revocation (id, chain_id, enablement_id, approved_by, revoked_at, confirmation_digest, created_at) VALUES ('r5', 4663, 'rh-1', 'owner-cli', ?, ?, ?)").run(day(0.3), DIGEST, T0)).toThrow(/newest enablement/);
    expect(() => t.db.prepare("UPDATE chain_enablement_revocation SET revoked_at = ? WHERE id = 'r3'").run(day(9))).toThrow(/immutable/);
    expect(() => t.db.prepare("DELETE FROM chain_enablement_revocation WHERE id = 'r3'").run()).toThrow(/immutable/);
    t.enable('rh-2', day(1));
    expect(() => t.db.prepare("INSERT INTO chain_enablement_revocation (id, chain_id, enablement_id, approved_by, revoked_at, confirmation_digest, created_at) VALUES ('r6', 4663, 'rh-1', 'owner-cli', ?, ?, ?)").run(day(1.5), DIGEST, T0)).toThrow(/newest enablement/);
  });

  it('a revoked paid record no longer admits paid Robinhood at the database level', () => {
    const t = setup();
    t.db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('old-free', 'rh', 'free', 'fee_only', '200000000000000', '200000000000000', '0', 2, 0, 1, ?, 'allowed')").run(T0);
    t.repository.enableRobinhood({ id: 'paid-record', approvedAt: T0, expiresAt: PERM, evidence: { ...PAID_EVIDENCE }, paidAllowed: true, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: 'paid-verification', sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH, paidFeePolicy: { id: 'paid-fee', version: 'd054', maxTotalFeeWei: 370000000000000n, freeCapWei: 200000000000000n } });
    const paidAllowed = () => t.db.prepare("SELECT 1 AS allowed FROM robinhood_enablement WHERE rowid = (SELECT max(rowid) FROM robinhood_enablement) AND paid_allowed = 1 AND NOT EXISTS (SELECT 1 FROM chain_enablement_revocation r WHERE r.enablement_id = robinhood_enablement.id)").get();
    expect(paidAllowed()).toEqual({ allowed: 1 });
    t.repository.revokeEnablement(4663, { id: 'rev-paid', revokedAt: day(0.1), confirmationDigest: DIGEST });
    expect(paidAllowed()).toBeUndefined();
  });
});
