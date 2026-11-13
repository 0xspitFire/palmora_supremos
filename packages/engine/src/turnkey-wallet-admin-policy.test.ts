import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTurnkeyWalletAdminProviderState, assertTurnkeyWalletAdminRecordCurrent,
  createTurnkeyWalletAdminPolicyRecord, signTurnkeyWalletAdminPolicyRecord, turnkeyWalletAdminPolicyExpressions,
  verifyTurnkeyWalletAdminPolicyRecord, validateTurnkeyWalletAdminPolicyRecord,
} from './turnkey-wallet-admin-policy.js';
import { readTurnkeyWalletAdminPolicyRecords } from './turnkey-signer.js';

const NOW = new Date('2030-06-01T00:00:00.000Z');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fixture() {
  const owner = generateKeyPairSync('ed25519');
  const expressions = turnkeyWalletAdminPolicyExpressions({ adminUserId: 'wallet-admin' });
  const providerPolicy = { policyId: 'admin-policy', policyName: 'create-import-only', createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '2', nanos: '0' }, notes: 'non-signing owner scope', ...expressions };
  const record = createTurnkeyWalletAdminPolicyRecord({ environment: 'production', organizationId: 'org', adminUserId: 'wallet-admin', mintRuntimeUserId: 'mint-runtime', providerPolicy, issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30 * 86_400_000).toISOString() });
  const signed = signTurnkeyWalletAdminPolicyRecord(record, owner.privateKey);
  const verified = verifyTurnkeyWalletAdminPolicyRecord(signed, owner.publicKey, NOW);
  const state = { organizationId: 'org', adminUserId: 'wallet-admin', mintRuntimeUserId: 'mint-runtime', environment: 'production' as const, organization: { configs: { quorum: { threshold: 1, userIds: ['owner-root'] } } }, policies: [providerPolicy] };
  return { owner, providerPolicy, record, signed, verified, state };
}

describe('separately signed non-signing Turnkey wallet admin policy', () => {
  it('pins a domain-separated canonical record and exactly three non-signing activities', () => {
    const f = fixture();
    expect(f.verified).toMatchObject({ organizationId: 'org', adminUserId: 'wallet-admin', mintRuntimeUserId: 'mint-runtime', policyId: 'admin-policy' });
    expect(f.verified.condition).toBe("activity.type in ['ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2', 'ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY', 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY']");
    expect(turnkeyWalletAdminPolicyExpressions({ adminUserId: 'wallet-admin' })).not.toHaveProperty('time');
    expect(() => assertTurnkeyWalletAdminProviderState(f.verified, f.state, NOW)).not.toThrow();
    expect(Object.isFrozen(f.verified)).toBe(true); expect(Object.isFrozen(f.verified.providerPolicy)).toBe(true);
  });

  it.each([
    "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'",
    "activity.type == 'ACTIVITY_TYPE_EXPORT_PRIVATE_KEY'",
    "activity.type == 'ACTIVITY_TYPE_CREATE_POLICIES'",
    "activity.type in ['ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2'] || true",
    'true',
  ])('cannot owner-sign an admin record laundering %s', condition => {
    const f = fixture();
    expect(() => signTurnkeyWalletAdminPolicyRecord({ ...f.record, condition, providerPolicy: { ...f.providerPolicy, condition } }, f.owner.privateKey)).toThrow('NON_SIGNING_POLICY_REQUIRED');
  });

  it('rejects consensus/user injection, a shared runtime user, non-null time and excessive lifetime', () => {
    const f = fixture();
    expect(() => turnkeyWalletAdminPolicyExpressions({ adminUserId: "admin') || true" })).toThrow('RECORD_INVALID');
    expect(() => validateTurnkeyWalletAdminPolicyRecord({ ...f.record, adminUserId: 'mint-runtime' })).toThrow('DISTINCT_USER_REQUIRED');
    expect(() => signTurnkeyWalletAdminPolicyRecord({ ...f.record, consensus: 'true', providerPolicy: { ...f.providerPolicy, consensus: 'true' } }, f.owner.privateKey)).toThrow('NON_SIGNING_POLICY_REQUIRED');
    expect(() => validateTurnkeyWalletAdminPolicyRecord({ ...f.record, providerPolicy: { ...f.providerPolicy, time: 'true' } })).toThrow('NON_SIGNING_POLICY_REQUIRED');
    expect(() => validateTurnkeyWalletAdminPolicyRecord({ ...f.record, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000 + 1).toISOString() })).toThrow('LIFETIME_INVALID');
  });

  it('requires the pinned offline owner key and rejects unsigned/deserialized or mutated records', () => {
    const f = fixture(); const wrong = generateKeyPairSync('ed25519');
    expect(() => verifyTurnkeyWalletAdminPolicyRecord(f.signed, wrong.publicKey, NOW)).toThrow('SIGNATURE_INVALID');
    expect(() => verifyTurnkeyWalletAdminPolicyRecord({ ...f.signed, record: { ...f.record, organizationId: 'other-org' } }, f.owner.publicKey, NOW)).toThrow('DIGEST_MISMATCH');
    expect(() => assertTurnkeyWalletAdminRecordCurrent(f.record, NOW)).toThrow('SIGNATURE_VERIFICATION_REQUIRED');
    expect(() => assertTurnkeyWalletAdminRecordCurrent(JSON.parse(JSON.stringify(f.verified)), NOW)).toThrow('SIGNATURE_VERIFICATION_REQUIRED');
    expect(() => verifyTurnkeyWalletAdminPolicyRecord({ ...f.signed, record: { ...f.record, context: 'mintbot.turnkey-policy-record/v1' } }, f.owner.publicKey, NOW)).toThrow('RECORD_INVALID');
  });

  it('refuses expired/future records and rechecks expiry after successful verification', () => {
    const f = fixture();
    expect(() => verifyTurnkeyWalletAdminPolicyRecord(f.signed, f.owner.publicKey, new Date(NOW.getTime() - 1))).toThrow('RECORD_NOT_CURRENT');
    const expiry = new Date(f.record.expiresAt);
    expect(() => verifyTurnkeyWalletAdminPolicyRecord(f.signed, f.owner.publicKey, expiry)).toThrow('RECORD_NOT_CURRENT');
    expect(() => assertTurnkeyWalletAdminRecordCurrent(f.verified, expiry)).toThrow('RECORD_NOT_CURRENT');
  });

  it('checks exact live org/admin/mint users, root quorum and duplicate/drifting provider policies', () => {
    const f = fixture();
    for (const override of [{ organizationId: 'other-org' }, { adminUserId: 'other-admin' }, { mintRuntimeUserId: 'other-runtime' }, { environment: 'testnet' as const }]) expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, ...override }, NOW)).toThrow('BINDING_INVALID');
    expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, organization: { configs: { quorum: { threshold: 1, userIds: ['wallet-admin'] } } } }, NOW)).toThrow('NON_ROOT_USER_REQUIRED');
    expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, policies: [f.providerPolicy, f.providerPolicy] }, NOW)).toThrow('PROVIDER_POLICY_DRIFT');
    for (const override of [{ condition: 'true' }, { consensus: 'true' }, { effect: 'EFFECT_DENY' }, { time: 'now() < 1' }, { notes: 'changed' }, { updatedAt: { seconds: '3', nanos: '0' } }]) expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, policies: [{ ...f.providerPolicy, ...override }] }, NOW)).toThrow('PROVIDER_POLICY_DRIFT');
  });

  it('does not treat another signing/export/admin ALLOW as part of a create/import-only admin credential', () => {
    const f = fixture();
    for (const consensus of ['true', f.verified.consensus, "approvers.any(user, user.id == 'other-admin')"]) expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, policies: [...f.state.policies, { ...f.providerPolicy, policyId: 'extra', consensus, condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" }] }, NOW)).toThrow('PROVIDER_POLICY_NOT_APPROVED');
    expect(() => assertTurnkeyWalletAdminProviderState(f.verified, { ...f.state, policies: [...f.state.policies, { ...f.providerPolicy, policyId: 'mint-policy', consensus: "approvers.any(user, user.id == 'mint-runtime')", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'" }] }, NOW)).not.toThrow();
  });

  it('loads optional public records with protected reads and consistent role-specific binding', async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), 'wallet-admin-record-')); roots.push(root);
    const recordPath = join(root, 'admin-record.json'); const publicPath = join(root, 'approver.pub');
    await writeFile(recordPath, JSON.stringify(f.signed), { mode: 0o600 });
    await writeFile(publicPath, f.owner.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const config = { organizationId: 'org', userId: 'mint-runtime', environment: 'production' as const, policyApproverPublicKeyPath: publicPath, walletAdminPolicyRecordPath: recordPath };
    expect(await readTurnkeyWalletAdminPolicyRecords(config, { now: NOW })).toHaveLength(1);
    expect(await readTurnkeyWalletAdminPolicyRecords({ ...config, userId: 'wallet-admin' }, { role: 'wallet-admin', now: NOW })).toHaveLength(1);
    await expect(readTurnkeyWalletAdminPolicyRecords({ ...config, userId: 'wallet-admin' }, { now: NOW })).rejects.toThrow('BINDING_INVALID');
    expect(await readTurnkeyWalletAdminPolicyRecords({ ...config, walletAdminPolicyRecordPath: undefined }, { now: NOW })).toEqual([]);
    const link = join(root, 'alias.json'); await symlink(recordPath, link);
    await expect(readTurnkeyWalletAdminPolicyRecords({ ...config, walletAdminPolicyRecordPath: link }, { now: NOW })).rejects.toThrow('RECORD_INVALID');
    await writeFile(recordPath, '{}');
    await expect(readTurnkeyWalletAdminPolicyRecords(config, { now: NOW })).rejects.toThrow('RECORD_INVALID');
  });
});
