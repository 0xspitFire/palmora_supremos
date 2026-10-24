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

  it('D-062 item 3: a paid record needs exactly the two paid keys and makes a paid version of the active Base fee policy', () => {
    const db = openDatabase(); open.push(db); migrate(db);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO chain_profile (id, chain_id, name, rpc_endpoints_json, confirmation_depth, created_at) VALUES ('base', 8453, 'Base', '[]', 1, ?)").run(at);
    db.prepare("INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES ('base-free', 'base', 'base-free-d057-v1', 'fee_only', '200000000000000', '200000000000000', '0', 2, 0, 1, ?, 'allowed')").run(at);
    const repo = new DurableRepository(db);
    const evidence = { reviewedCode: true, forkRehearsal: true, finality: true, endpointAgreement: true, feeObservation: true, liveSimulation: true, custodyReadiness: true } as const;
    const record = (id: string, extra: Record<string, unknown>) => ({ id, approvedAt: new Date().toISOString(), expiresAt: '9999-12-31T23:59:59.999Z', evidence, evidenceDigest: 'a'.repeat(64), confirmationDigest: 'b'.repeat(64), strategyVersion: 'seadrop-v1-public', feePolicyVersion: 'base-free-d057-v1', primaryEndpointReference: 'BASE_RPC_URL', fallbackEndpointReference: 'BASE_RPC_FBACK', custodyMode: 'local-personal-live', ...extra });
    const fee = { id: 'base-paid', version: 'base-paid-d062', maxTotalFeeWei: 200_000_000_000_000n };
    expect(() => repo.enableBase(record('no-keys', { paidAllowed: true }) as never, { chainProfileId: 'base', verificationId: 'v1', paidFeePolicy: fee })).toThrow(/incomplete/);
    expect(() => repo.enableBase(record('no-fee', { paidAllowed: true, evidence: { ...evidence, paidRehearsal: true, paidPolicyApproved: true } }) as never, { chainProfileId: 'base', verificationId: 'v2' })).toThrow(/paid fee policy/);
    expect(() => repo.enableBase(record('free-with-keys', { evidence: { ...evidence, paidRehearsal: true, paidPolicyApproved: true } }) as never, { chainProfileId: 'base', verificationId: 'v3' })).toThrow(/incomplete/);
    repo.enableBase(record('paid', { paidAllowed: true, evidence: { ...evidence, paidRehearsal: true, paidPolicyApproved: true } }) as never, { chainProfileId: 'base', verificationId: 'v4', paidFeePolicy: fee });
    expect(repo.latestBaseEnablement()).toMatchObject({ id: 'paid', paidAllowed: true });
    expect(db.prepare("SELECT active FROM fee_policy WHERE id = 'base-free'").get()).toEqual({ active: 0 });
    expect(db.prepare("SELECT paid_mints_enabled AS paid, max_total_fee_wei AS fee, free_mint_total_fee_cap_wei AS freeFee, active FROM fee_policy WHERE id = 'base-paid'").get()).toEqual({ paid: 1, fee: '200000000000000', freeFee: '200000000000000', active: 1 });
    // direct SQL cannot write a paid row with only one of the keys
    expect(() => db.prepare("INSERT INTO base_enablement (id, approved_by, approved_at, expires_at, free_allowed, paid_allowed, evidence_json, evidence_digest, confirmation_digest, strategy_version, fee_policy_version, primary_endpoint_reference, fallback_endpoint_reference, custody_mode, created_at) VALUES ('sql', 'owner-cli', ?, '9999-12-31T23:59:59.999Z', 1, 1, ?, ?, ?, 's', 'f', 'A', 'B', 'local-personal-live', ?)").run(new Date(Date.now() + 1000).toISOString(), JSON.stringify({ ...evidence, paidRehearsal: true }), 'a'.repeat(64), 'b'.repeat(64), at)).toThrow(/incomplete/);
  });
});
