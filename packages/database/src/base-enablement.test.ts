import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type SqliteDatabase } from './database.js';
import { DurableRepository } from './repositories.js';

const open: SqliteDatabase[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

describe('Base durable enablement', () => {
  it('atomically enables Base from an immutable free-only owner record', () => {
    const db = openDatabase(); open.push(db); migrate(db);
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('base', 8453, 'Base', '[]', 1, ?)").run(new Date().toISOString());
    const now = new Date(); const expires = new Date(now.getTime() + 86_400_000);
    const repo = new DurableRepository(db);
    repo.enableBase({ id: 'enable', approvedAt: now.toISOString(), expiresAt: expires.toISOString(), evidence: { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true }, evidenceDigest: 'a'.repeat(64), confirmationDigest: 'b'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live' }, { chainProfileId: 'base', verificationId: 'verification' });
    expect(db.prepare('SELECT verification_status, execution_enabled FROM chain_profile WHERE id = ?').get('base')).toEqual({ verification_status: 'verified', execution_enabled: 1 });
    expect(repo.latestBaseEnablement()).toMatchObject({ id: 'enable', freeAllowed: true, paidAllowed: false });
    expect(() => db.prepare("UPDATE base_enablement SET paid_allowed = 1 WHERE id = 'enable'").run()).toThrow('immutable');
  });
});
