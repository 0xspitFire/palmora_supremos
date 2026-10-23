import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDatabase } from './database.js';
import { DurableRepository } from './repositories.js';

const open: SqliteDatabase[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

describe('Base durable enablement', () => {
  it('atomically enables Base from an immutable free-only owner record', () => {
    const db = openDatabase(); open.push(db); migrate(db);
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('base', 8453, 'Base', '[]', 1, ?)").run(new Date().toISOString());
    const now = new Date(); const expires = new Date('9999-12-31T23:59:59.999Z');
    const repo = new DurableRepository(db);
    repo.enableBase({ id: 'enable', approvedAt: now.toISOString(), expiresAt: expires.toISOString(), evidence: { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true }, evidenceDigest: 'a'.repeat(64), confirmationDigest: 'b'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' }, { chainProfileId: 'base', verificationId: 'verification' });
    expect(db.prepare('SELECT verification_status, execution_enabled FROM chain_profile WHERE id = ?').get('base')).toEqual({ verification_status: 'verified', execution_enabled: 1 });
    expect(repo.latestBaseEnablement()).toMatchObject({ id: 'enable', freeAllowed: true, paidAllowed: false });
    expect(() => db.prepare("UPDATE base_enablement SET paid_allowed = 1 WHERE id = 'enable'").run()).toThrow('immutable');
  });

  it('D-062: only the "until revoked" expiry is accepted for a new record, and a revocation switches Base off for good', () => {
    const db = openDatabase(); open.push(db); migrate(db);
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('base', 8453, 'Base', '[]', 1, ?)").run(new Date().toISOString());
    const repo = new DurableRepository(db);
    const now = new Date();
    const record = (id: string, expiresAt: string, approvedAt = now.toISOString()) => ({ id, approvedAt, expiresAt, evidence: { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true }, evidenceDigest: 'a'.repeat(64), confirmationDigest: 'b'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' });
    expect(() => repo.enableBase(record('seven-days', new Date(now.getTime() + 7 * 86_400_000).toISOString()) as never, { chainProfileId: 'base', verificationId: 'v1' })).toThrow(/incomplete/);
    repo.enableBase(record('perm', '9999-12-31T23:59:59.999Z') as never, { chainProfileId: 'base', verificationId: 'v2' });
    expect(db.prepare('SELECT execution_enabled AS e FROM chain_profile WHERE id = ?').get('base')).toEqual({ e: 1 });
    expect(repo.revokeEnablement(8453, { id: 'rev', revokedAt: new Date(now.getTime() + 1000).toISOString(), confirmationDigest: 'c'.repeat(64) })).toEqual({ enablementId: 'perm' });
    expect(db.prepare('SELECT execution_enabled AS e FROM chain_profile WHERE id = ?').get('base')).toEqual({ e: 0 });
    expect(repo.latestBaseEnablement()).toBeUndefined();
    expect(() => db.prepare("UPDATE chain_profile SET execution_enabled = 1 WHERE id = 'base'").run()).toThrow();
    expect(() => repo.revokeEnablement(8453, { id: 'rev2', revokedAt: new Date(now.getTime() + 2000).toISOString(), confirmationDigest: 'c'.repeat(64) })).toThrow('NOTHING_TO_REVOKE');
  });
});
