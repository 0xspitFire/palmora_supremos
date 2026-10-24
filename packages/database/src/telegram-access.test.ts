import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { TelegramAccessRepository } from './telegram-access.js';
import { DurableRepository } from './repositories.js';

/** T-061 (D-063): Telegram viewers, invites, the unlocked session and polling (migration 033). */
function fixture(start = '2026-10-24T10:00:00.000Z') {
  const db = openDatabase();
  let now = new Date(start);
  const repo = new TelegramAccessRepository(db, () => now);
  return { db, repo, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const HOUR = 3_600_000;

describe('Telegram invites and viewers', () => {
  it('an invite admits one user once, before it expires; the code itself is never stored', () => {
    const { db, repo } = fixture();
    repo.createInvite('ABCDEFGHIJKLMNOP', 'viewer', 24 * HOUR);
    expect(JSON.stringify(db.prepare('SELECT * FROM telegram_invite').all())).not.toContain('ABCDEFGHIJKLMNOP');
    expect(repo.join('ABCDEFGHIJKLMNOP', '111')).toMatchObject({ userId: '111', role: 'viewer' });
    expect(repo.join('ABCDEFGHIJKLMNOP', '222')).toBeUndefined();
    expect(repo.activeUser('222')).toBeUndefined();
    expect(repo.activeUsers().map((user) => user.userId)).toEqual(['111']);
  });

  it('an expired or unknown invite admits nobody (fail closed)', () => {
    const { repo, advance } = fixture();
    repo.createInvite('ABCDEFGHIJKLMNOP', 'viewer', 24 * HOUR);
    expect(repo.join('QRSTUVWXYZ234567', '111')).toBeUndefined();
    advance(24 * HOUR);
    expect(repo.join('ABCDEFGHIJKLMNOP', '111')).toBeUndefined();
    expect(repo.activeUsers()).toEqual([]);
  });

  it('the database refuses an invite longer than 24 hours, a user without the invite they used, and a role other than viewer', () => {
    const { db, repo } = fixture();
    expect(() => repo.createInvite('ABCDEFGHIJKLMNOP', 'viewer', 25 * HOUR)).toThrow(/incomplete/);
    expect(() => db.prepare("INSERT INTO telegram_invite (id, code_sha256, role, created_at, expires_at) VALUES ('i', ?, 'owner', '2026-10-24T10:00:00.000Z', '2026-10-24T11:00:00.000Z')").run('a'.repeat(64))).toThrow();
    const invite = repo.createInvite('ABCDEFGHIJKLMNOP', 'viewer', HOUR);
    expect(() => db.prepare("INSERT INTO telegram_user (id, user_id, role, invite_id, added_at) VALUES ('u', '999', 'viewer', ?, '2026-10-24T10:00:00.000Z')").run(invite.id)).toThrow(/needs the invite/);
  });

  it('removal is at once and once; a removed user can be invited again; nothing is deleted or rewritten', () => {
    const { db, repo } = fixture();
    repo.createInvite('ABCDEFGHIJKLMNOP', 'viewer', HOUR);
    repo.join('ABCDEFGHIJKLMNOP', '111');
    expect(repo.removeUser('111')).toBe(true);
    expect(repo.removeUser('111')).toBe(false);
    expect(repo.activeUser('111')).toBeUndefined();
    repo.createInvite('QRSTUVWXYZ234567', 'viewer', HOUR);
    expect(repo.join('QRSTUVWXYZ234567', '111')).toMatchObject({ userId: '111' });
    expect(() => db.prepare("UPDATE telegram_user SET role = 'owner'").run()).toThrow();
    expect(() => db.prepare("UPDATE telegram_user SET removed_at = NULL WHERE removed_at IS NOT NULL").run()).toThrow(/marked used or removed/);
    expect(() => db.prepare('DELETE FROM telegram_user').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare('DELETE FROM telegram_invite').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare("UPDATE telegram_invite SET used_by = '555' WHERE used_by IS NOT NULL").run()).toThrow(/used once/);
  });
});

describe('Telegram unlocked session', () => {
  it('opens for at most 12 hours, one at a time, and an authenticator step opens at most one session (no replay)', () => {
    const { db, repo, advance } = fixture();
    expect(repo.startSession(100, 12 * HOUR)).toMatchObject({ expiresAt: '2026-10-24T22:00:00.000Z' });
    expect(repo.startSession(100, 12 * HOUR)).toBeUndefined();
    expect(repo.startSession(99, 12 * HOUR)).toBeUndefined();
    advance(60_000);
    const second = repo.startSession(102, 12 * HOUR)!;
    expect(repo.openSession()?.id).toBe(second.id);
    expect(db.prepare('SELECT count(*) AS open FROM telegram_session WHERE closed_at IS NULL').get()).toEqual({ open: 1 });
    expect(() => repo.startSession(200, 13 * HOUR)).toThrow(/incomplete/);
  });

  it('closes once with a reason, and the record cannot be changed or deleted', () => {
    const { db, repo } = fixture();
    repo.startSession(100, 12 * HOUR);
    expect(repo.closeSession('kill')).toBeDefined();
    expect(repo.closeSession('lock')).toBeUndefined();
    expect(repo.openSession()).toBeUndefined();
    expect(() => db.prepare("UPDATE telegram_session SET close_reason = 'lock'").run()).toThrow(/closed once/);
    expect(() => db.prepare('DELETE FROM telegram_session').run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare('DELETE FROM telegram_totp_use').run()).toThrow(/immutable/);
  });

  it('counts failed unlocks in a window, and they cannot be erased', () => {
    const { db, repo, advance } = fixture();
    repo.recordUnlockFailure();
    advance(2 * HOUR);
    repo.recordUnlockFailure();
    repo.recordUnlockFailure();
    expect(repo.unlockFailuresSince(new Date('2026-10-24T11:00:00.000Z'))).toHaveLength(2);
    expect(() => db.prepare('DELETE FROM telegram_unlock_failure').run()).toThrow(/immutable/);
  });

  it('the polling position only moves forward', () => {
    const { repo } = fixture();
    expect(repo.pollOffset()).toBe(0);
    repo.savePollOffset(10);
    repo.savePollOffset(5);
    expect(repo.pollOffset()).toBe(10);
    repo.savePollOffset(11);
    expect(repo.pollOffset()).toBe(11);
  });
});

describe('cancelling a live request (D-063 item 3)', () => {
  it('a cancel is a claim: it wins once, and the service can then never start the request', () => {
    const db = openDatabase();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('chain', 1, 'Ethereum', '[]', 2, '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO contract (id, chain_profile_id, address, kind) VALUES ('contract', 'chain', '0xc', 'nft')").run();
    db.prepare("INSERT INTO collection (id, contract_id, name) VALUES ('collection', 'contract', 'c')").run();
    db.prepare("INSERT INTO \"drop\" (id, collection_id, strategy, mint_price_wei, observed_at) VALUES ('drop', 'collection', 'test', '0', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO campaign (id, drop_id, state, created_at) VALUES ('campaign', 'drop', 'draft', '2026-01-01T00:00:00.000Z')").run();
    const repository = new DurableRepository(db);
    repository.recordLiveRunRequest({ id: 'request-1', campaignId: 'campaign', wallets: ['0x1111111111111111111111111111111111111111'], simulationIds: ['sim'], approvalId: 'approval', evidenceAt: '2026-10-24T10:00:00.000Z', maxFeeGwei: '5', confirmationDigest: 'a'.repeat(64), requestedAt: '2026-10-24T10:00:00.000Z', expiresAt: '2026-10-24T10:30:00.000Z' });
    expect(repository.claimLiveRunRequest('request-1', 'cancelled', '2026-10-24T10:01:00.000Z')).toBe(true);
    expect(repository.claimLiveRunRequest('request-1', 'started', '2026-10-24T10:01:01.000Z')).toBe(false);
    expect(repository.unclaimedLiveRunRequests()).toEqual([]);
    expect(repository.recentLiveRunRequests(5)).toEqual([expect.objectContaining({ id: 'request-1', outcome: 'cancelled' })]);
    expect(repository.claimLiveRunRequest('no-such-request', 'cancelled', '2026-10-24T10:01:00.000Z')).toBe(false);
  });
});
