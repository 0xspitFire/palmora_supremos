import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { DurableRepository } from './repositories.js';

// The database also compares a record's expiry with its own clock, so the times here are relative to now.
const T0 = new Date().toISOString();
const day = (offset: number, base = T0): string => new Date(Date.parse(base) + offset * 86_400_000).toISOString();
const DIGEST = 'a'.repeat(64);
const EVIDENCE = { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true } as const;
const SEQ = 'https://sequencer.mainnet.chain.robinhood.com';
const ARCH = 'Rets/MINT_BOT_SECRETS.env:ROBINHOOD_ARCHIVE_RPC';

function setup() {
  const db = openDatabase();
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('rh', 4663, 'Robinhood', '[]', 1, ?)").run(T0);
  db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('eth', 1, 'Ethereum', '[]', 2, ?)").run(T0);
  const repository = new DurableRepository(db);
  const enable = (id: string, approvedAt = T0, expiresAt = day(7, approvedAt)) => repository.enableRobinhood({ id, approvedAt, expiresAt, evidence: { ...EVIDENCE }, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: `ver-${id}`, sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH });
  const insertRow = (overrides: Record<string, unknown> = {}) => {
    const row = { id: `row-${Math.random()}`, approved_by: 'owner-cli', approved_at: T0, expires_at: day(7), paid_allowed: 0, evidence_json: JSON.stringify(EVIDENCE), confirmation_digest: DIGEST, created_at: T0, ...overrides };
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
    expect(row).toMatchObject({ id: 'rh-1', approvedBy: 'owner-cli', approvedAt: T0, expiresAt: day(7), paidAllowed: false, evidence: EVIDENCE });
    expect(t.db.prepare("SELECT status, approved_by AS by FROM chain_verification WHERE id = 'ver-rh-1'").get()).toEqual({ status: 'verified', by: 'owner-cli' });
  });

  it('rolls everything back when any part is refused (no row without the profile change)', () => {
    const t = setup();
    expect(() => t.repository.enableRobinhood({ id: 'bad', approvedAt: T0, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: DIGEST }, { chainProfileId: 'rh', verificationId: 'v', sequencerEndpointReference: 'https://evil.example', archiveEndpointReference: ARCH })).toThrow();
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
    expect(t.profile().enabled).toBe(0);
  });

  it('refuses incomplete evidence or a bad digest before touching the database', () => {
    const t = setup();
    const chain = { chainProfileId: 'rh', verificationId: 'v', sequencerEndpointReference: SEQ, archiveEndpointReference: ARCH };
    const missing = { ...EVIDENCE } as Record<string, unknown>;
    delete missing.E3;
    expect(() => t.repository.enableRobinhood({ id: 'a', approvedAt: T0, expiresAt: day(7), evidence: missing as never, confirmationDigest: DIGEST }, chain)).toThrow(/E1 to E7/);
    expect(() => t.repository.enableRobinhood({ id: 'b', approvedAt: T0, expiresAt: day(7), evidence: { ...EVIDENCE, E4: false } as never, confirmationDigest: DIGEST }, chain)).toThrow(/E1 to E7/);
    expect(() => t.repository.enableRobinhood({ id: 'c', approvedAt: T0, expiresAt: day(7), evidence: { ...EVIDENCE }, confirmationDigest: 'ABC' }, chain)).toThrow(/digest/);
    expect(t.repository.latestRobinhoodEnablement()).toBeUndefined();
  });
});

describe('the enablement table accepts only complete rows (direct SQL cannot cheat)', () => {
  it('accepts exactly one well-formed row', () => {
    const t = setup();
    expect(() => t.insertRow({ id: 'ok' })).not.toThrow();
  });

  it('refuses a row with the wrong author, paid allowed, a bad digest or bad times', () => {
    const t = setup();
    for (const bad of [
      { approved_by: 'session' }, { approved_by: 'owner' }, { paid_allowed: 1 }, { confirmation_digest: 'A'.repeat(64) }, { confirmation_digest: 'a'.repeat(63) },
      { approved_at: 'yesterday' }, { expires_at: '2026-10-27' }, { expires_at: T0 }, { expires_at: day(-1) }, { expires_at: day(7.5) }, { expires_at: new Date(Date.parse(T0) + 7 * 86_400_000 + 10_000).toISOString() }, { expires_at: day(30) },
    ]) expect(() => t.insertRow(bad), JSON.stringify(bad)).toThrow();
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
    t.insertRow({ id: 'first', approved_at: day(1), expires_at: day(5) });
    expect(() => t.db.prepare("UPDATE robinhood_enablement SET expires_at = ? WHERE id = 'first'").run(day(6))).toThrow(/immutable/);
    expect(() => t.db.prepare("DELETE FROM robinhood_enablement WHERE id = 'first'").run()).toThrow(/immutable/);
    expect(() => t.insertRow({ id: 'older', approved_at: day(0), expires_at: day(3) })).toThrow(/newer/);
    expect(() => t.insertRow({ id: 'newer', approved_at: day(2), expires_at: day(6) })).not.toThrow();
  });
});

describe('the profile can be enabled only inside the newest record\'s window', () => {
  it('refuses an approval time before the record, at its expiry, or after it', () => {
    const t = setup();
    t.insertRow({ id: 'w', approved_at: T0, expires_at: day(7) });
    expect(() => t.forceEnable(day(-0.01))).toThrow();
    expect(() => t.forceEnable(day(7))).toThrow();
    expect(() => t.forceEnable(day(8))).toThrow();
    expect(() => t.forceEnable(null)).toThrow();
    expect(() => t.forceEnable(day(3))).not.toThrow();
    expect(t.profile().enabled).toBe(1);
  });

  it('lets the newest record alone decide', () => {
    const t = setup();
    t.insertRow({ id: 'one', approved_at: T0, expires_at: day(7) });
    t.insertRow({ id: 'two', approved_at: day(8), expires_at: day(15) });
    expect(() => t.forceEnable(day(3))).toThrow(); // inside the old window, but the newest record is the second
    expect(() => t.forceEnable(day(9))).not.toThrow();
  });

  it('does not let a later change of the approval time move an enabled profile outside the window', () => {
    const t = setup();
    t.enable('rh-1');
    expect(() => t.db.prepare("UPDATE chain_profile SET verification_approved_at = ? WHERE id = 'rh'").run(day(30))).toThrow();
    expect(t.profile().enabled).toBe(1);
  });
});

describe('the database clock also stops a re-enable after the record has expired', () => {
  it('refuses to verify or enable the profile when the newest record is already past its expiry by the database clock', () => {
    const t = setup();
    // A valid-looking record whose whole window lies in the past (approved 9 days ago, expired 2 days ago).
    t.insertRow({ id: 'old', approved_at: day(-9), expires_at: day(-2) });
    expect(() => t.forceEnable(day(-5))).toThrow();
    expect(() => t.db.prepare("UPDATE chain_profile SET verification_status = 'verified' WHERE id = 'rh'").run()).toThrow(/cannot be execution verified/);
    expect(t.profile().enabled).toBe(0);
  });

  it('refuses a plain re-enable after the switch-off once the record has expired', () => {
    const t = setup();
    const base = Date.now();
    const at = (ms: number): string => new Date(base + ms).toISOString();
    // A record that expires in 1.5 seconds.
    t.insertRow({ id: 'soon', approved_at: at(-6 * 86_400_000), expires_at: at(1_500) });
    t.forceEnable(at(-86_400_000));
    expect(t.profile().enabled).toBe(1);
    t.db.prepare("UPDATE chain_profile SET execution_enabled = 0 WHERE id = 'rh'").run();
    t.db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'rh'").run(); // still inside the record's window by the database clock
    t.db.prepare("UPDATE chain_profile SET execution_enabled = 0 WHERE id = 'rh'").run();
    const until = base + 2_000;
    while (Date.now() < until) { /* wait for the record to expire */ }
    expect(() => t.db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'rh'").run()).toThrow(/execution requires verified non-Robinhood chain/);
  });
});

describe('expiry switches Robinhood off again', () => {
  it('turns the profile off once the record is no longer valid, records it, and leaves a valid one alone', () => {
    const t = setup();
    t.enable('rh-1');
    expect(t.repository.disableRobinhoodIfNotEnabled(new Date(day(3)))).toBe(false);
    expect(t.profile().enabled).toBe(1);
    expect(t.repository.disableRobinhoodIfNotEnabled(new Date(day(7)))).toBe(true);
    expect(t.profile().enabled).toBe(0);
    expect(t.db.prepare("SELECT count(*) AS n FROM audit_event WHERE entity_id = 'rh' AND new_state = 'execution_disabled'").get()).toEqual({ n: 1 });
    expect(t.repository.disableRobinhoodIfNotEnabled(new Date(day(8)))).toBe(false);
    // After expiry it cannot be switched back on without a new owner record.
    expect(() => t.forceEnable(day(8))).toThrow();
  });
});
