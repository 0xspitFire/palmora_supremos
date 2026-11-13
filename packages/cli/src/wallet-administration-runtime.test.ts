import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
import { openDatabase, TelegramAccessRepository } from '@mint-bot/database';
import { createTurnkeyWalletAdminPolicyRecord, signTurnkeyWalletAdminPolicyRecord, turnkeyWalletAdminPolicyExpressions, type TurnkeySecretConfig, type createTurnkeyClient } from '@mint-bot/engine';
import { assertWalletAdminCredentialPath, checkWalletAdminCredentialFile, createWalletAdministrationRuntime } from './wallet-administration-runtime.js';
import type { TurnkeyWalletAdministrationClient } from './turnkey-wallet-administration.js';
import { timeStepAt } from './totp.js';
const start = new Date('2026-11-13T12:00:00Z'); const address = `0x${'1'.repeat(40)}`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-admin-runtime-')); const credential = join(directory, 'turnkey-wallet-admin.env');
  await writeFile(credential, 'SYNTHETIC_PROFILE_MARKER_ONLY', { mode: 0o600 });
  const keys = generateKeyPairSync('ed25519'); const publicPath = join(directory, 'approver.pub'); await writeFile(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const policy = { policyId: 'admin-policy', policyName: 'Admin', notes: '', ...turnkeyWalletAdminPolicyExpressions({ adminUserId: 'admin' }), createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '1', nanos: '0' } };
  const record = createTurnkeyWalletAdminPolicyRecord({ environment: 'production', organizationId: 'org', adminUserId: 'admin', mintRuntimeUserId: 'runtime', providerPolicy: policy, issuedAt: new Date(start.getTime() - 1000).toISOString(), expiresAt: new Date(start.getTime() + 3600_000).toISOString() });
  const recordPath = join(directory, 'admin-policy.json'); await writeFile(recordPath, JSON.stringify(signTurnkeyWalletAdminPolicyRecord(record, keys.privateKey)), { mode: 0o600 });
  const config: TurnkeySecretConfig = { organizationId: 'org', environment: 'production', userId: 'admin', apiPublicKey: ['synthetic', 'public'].join('-'), apiPrivateKey: ['synthetic', 'private'].join('-'), walletMapPath: join(directory, 'map.json'), policyRecordPath: join(directory, 'record.json'), policyApproverPublicKeyPath: publicPath, walletAdminPolicyRecordPath: recordPath };
  const inventory: unknown[] = [];
  const createPrivateKeys = vi.fn<NonNullable<TurnkeyWalletAdministrationClient['createPrivateKeys']>>(async input => {
    const result = [{ privateKeyId: 'new-key', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address }] }];
    inventory.push({ ...result[0], privateKeyName: input.privateKeys[0]!.privateKeyName, curve: 'CURVE_SECP256K1', exported: false });
    return { privateKeys: result, activity: { id: 'activity', organizationId: 'org', type: 'ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2', status: 'ACTIVITY_STATUS_COMPLETED', intent: { createPrivateKeysIntentV2: { privateKeys: input.privateKeys } }, result: { createPrivateKeysResultV2: { privateKeys: result } } } };
  });
  const getPolicies = vi.fn(async () => ({ policies: [policy] }));
  const getOrganizationConfigs = vi.fn(async () => ({ configs: { quorum: { threshold: 1, userIds: ['offline-owner'] } } }));
  const client = { getWhoami: vi.fn(async () => ({ organizationId: 'org', userId: 'admin' })), getPrivateKeys: vi.fn(async () => ({ privateKeys: structuredClone(inventory) })), getPolicies, getOrganizationConfigs, createPrivateKeys, importPrivateKey: vi.fn(async () => { throw new Error('not called'); }) };
  const store = new DurableStore(); await store.open(); let time = start;
  const options = { runtimeRoot: directory, ownerId: '1001', mode: 'owner-admin' as const, store, now: () => time, environment: { MINT_BOT_SECRET_ROOT: directory, TURNKEY_SECRET_FILE: credential }, checkIsolation: vi.fn(async () => undefined), loadConfig: vi.fn(async () => config), clientFactory: () => client as unknown as ReturnType<typeof createTurnkeyClient>, authorizedWallets: async () => [] };
  return { directory, credential, options, config, client, getPolicies, getOrganizationConfigs, createPrivateKeys, advance: (ms: number) => { time = new Date(time.getTime() + ms); }, close: () => rm(directory, { recursive: true, force: true }) };
}
describe('isolated wallet administration runtime composition', () => {
  it('loads a genuine signed non-signing record and verifies exact live policy/nonroot identity before SDK creation', async () => {
    const s = await fixture();
    try {
      const runtime = await createWalletAdministrationRuntime(s.options); expect(runtime.profileStatus).toMatchObject({ code: 'WALLET_ADMIN_SIGNED_PROFILE_LOADED', adminUserId: 'admin', mintRuntimeUserId: 'runtime' });
      const service = runtime.serviceFor(async () => ({ ownerId: '1001', channel: 'owner-cli', expiresAt: new Date(start.getTime() + 300_000).toISOString() }));
      await service.request({ requestId: 'generate', kind: 'generate', chainIds: [1], count: 1 }); expect(await service.execute('generate')).toMatchObject({ state: 'completed' }); expect(s.createPrivateKeys).toHaveBeenCalledTimes(1); expect(s.getPolicies.mock.calls.length).toBeGreaterThanOrEqual(2); await runtime.close();
    } finally { await s.close(); }
  });
  it.each(['drift', 'root-admin', 'expired-approval', 'wrong-identity'] as const)('refuses %s at the actual mutating SDK boundary', async mode => {
    const s = await fixture();
    try {
      const runtime = await createWalletAdministrationRuntime(s.options); const expiry = new Date(start.getTime() + 5000).toISOString();
      const service = runtime.serviceFor(async () => ({ ownerId: '1001', channel: 'owner-cli', expiresAt: expiry })); await service.request({ requestId: 'g', kind: 'generate', chainIds: [1], count: 1 });
      if (mode === 'drift') s.getPolicies.mockResolvedValue({ policies: [{ policyId: 'admin-policy', policyName: 'Admin', notes: '', effect: 'EFFECT_ALLOW', consensus: "approvers.any(user, user.id == 'admin')", condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", createdAt: { seconds: '1', nanos: '0' }, updatedAt: { seconds: '1', nanos: '0' } }] });
      if (mode === 'root-admin') s.getOrganizationConfigs.mockResolvedValue({ configs: { quorum: { threshold: 1, userIds: ['admin'] } } });
      if (mode === 'expired-approval') { let checks = 0; const original = s.getPolicies.getMockImplementation()!; s.getPolicies.mockImplementation(async () => { const value = await original(); if (++checks === 2) s.advance(6000); return value; }); }
      if (mode === 'wrong-identity') s.client.getWhoami.mockResolvedValue({ organizationId: 'org', userId: 'runtime' });
      if (mode === 'expired-approval') expect(await service.execute('g')).toMatchObject({ state: 'ambiguous' });
      else await expect(service.execute('g')).rejects.toThrow(/^WALLET_/);
      expect(s.createPrivateKeys).not.toHaveBeenCalled(); await runtime.close();
    } finally { await s.close(); }
  });
  it('requires production OS isolation before credentials, provider construction or database access', async () => {
    const s = await fixture(); try {
      await expect(createWalletAdministrationRuntime({ ...s.options, checkIsolation: undefined })).rejects.toThrow('WALLET_ADMIN_OS_ISOLATION_REQUIRED');
      expect(s.options.loadConfig).not.toHaveBeenCalled(); expect(s.createPrivateKeys).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('rechecks OS isolation immediately before provider mutation', async () => {
    const s = await fixture(); try {
      const runtime = await createWalletAdministrationRuntime(s.options);
      const service = runtime.serviceFor(async () => ({ ownerId: '1001', channel: 'owner-cli', expiresAt: new Date(start.getTime() + 300_000).toISOString() }));
      await service.request({ requestId: 'isolation-drift', kind: 'generate', chainIds: [1], count: 1 });
      s.options.checkIsolation.mockRejectedValue(new Error('WALLET_ADMIN_OS_ISOLATION_REQUIRED'));
      await expect(service.execute('isolation-drift')).rejects.toThrow('WALLET_ADMIN_OS_ISOLATION_REQUIRED');
      expect(s.createPrivateKeys).not.toHaveBeenCalled(); await runtime.close();
    } finally { await s.close(); }
  });
  it('rechecks isolation after asynchronous live policy validation before SDK mutation', async () => {
    const s = await fixture(); try {
      const runtime = await createWalletAdministrationRuntime(s.options);
      const service = runtime.serviceFor(async () => ({ ownerId: '1001', channel: 'owner-cli', expiresAt: new Date(start.getTime() + 300_000).toISOString() }));
      await service.request({ requestId: 'async-isolation-drift', kind: 'generate', chainIds: [1], count: 1 });
      const original = s.getPolicies.getMockImplementation()!; let calls = 0;
      s.getPolicies.mockImplementation(async () => { const result = await original(); if (++calls === 2) s.options.checkIsolation.mockRejectedValue(new Error('WALLET_ADMIN_OS_ISOLATION_REQUIRED')); return result; });
      expect(await service.execute('async-isolation-drift')).toMatchObject({ state: 'ambiguous' });
      expect(s.createPrivateKeys).not.toHaveBeenCalled(); await runtime.close();
    } finally { await s.close(); }
  });
  it('forbids the admin credential profile in the public mint-host composition before any file/config read', async () => {
    const s = await fixture(); try { await expect(createWalletAdministrationRuntime({ ...s.options, mode: 'public' })).rejects.toThrow('WALLET_ADMIN_PROFILE_FORBIDDEN_IN_MINT_RUNTIME'); expect(s.options.loadConfig).not.toHaveBeenCalled(); } finally { await s.close(); }
  });
  it('requires an installed valid signed record instead of trusting credential purpose alone', async () => {
    const s = await fixture(); s.config.walletAdminPolicyRecordPath = undefined;
    try { await expect(createWalletAdministrationRuntime(s.options)).rejects.toThrow('WALLET_ADMIN_SIGNED_POLICY_REQUIRED'); expect(s.createPrivateKeys).not.toHaveBeenCalled(); } finally { await s.close(); }
  });
  it('rejects runtime env basenames, outside-root paths and runtime-group-readable administrative credentials', async () => {
    const s = await fixture(); try {
      expect(() => assertWalletAdminCredentialPath(join(s.directory, 'turnkey.env'), s.directory)).toThrow('WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED'); expect(() => assertWalletAdminCredentialPath('/outside/turnkey-wallet-admin.env', s.directory)).toThrow('WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED');
      await chmod(s.credential, 0o640); await expect(checkWalletAdminCredentialFile(s.credential, s.directory)).rejects.toThrow('WALLET_ADMIN_CREDENTIAL_PERMISSIONS_REQUIRED');
    } finally { await s.close(); }
  });
  it('independently notices a session-ending kill in the shared database before the Telegram poller closes the session', async () => {
    const s = await fixture(); const statePath = join(s.directory, 'state.sqlite'); let clock = start;
    const database = openDatabase(statePath); const access = new TelegramAccessRepository(database, () => clock); const session = access.startSession(timeStepAt(clock), 12 * 3600_000)!; database.close();
    try {
      const provider = { capability: async () => ({ ownerAdminAvailable: false, organizationId: 'org', code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' }), inventory: async () => ({ organizationId: 'org', keys: [], complete: true, issues: [] }), generate: async () => { throw new Error('never'); }, importSealed: async () => { throw new Error('never'); } };
      const runtime = await createWalletAdministrationRuntime({ runtimeRoot: s.directory, ownerId: '1001', mode: 'public', provider, now: () => clock, environment: { MINT_BOT_STATE_PATH: statePath } });
      const approval = { ownerId: '1001', channel: 'telegram' as const, sessionId: session.id, expiresAt: session.expiresAt }; expect(await runtime.approvalCurrent(approval)).toBe(true);
      clock = new Date(clock.getTime() + 1000); await runtime.store.transaction(state => state.events.push({ id: 'kill-now', type: 'kill', at: clock.toISOString(), data: {} })); expect(await runtime.approvalCurrent(approval)).toBe(false); await runtime.close();
    } finally { await s.close(); }
  });
});
