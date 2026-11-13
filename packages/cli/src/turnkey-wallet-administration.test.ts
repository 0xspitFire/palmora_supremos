import { describe, expect, it, vi } from 'vitest';
import { createWalletAdministration, DurableStore } from '@mint-bot/backend';
import { createTurnkeyWalletAdministration, parseTurnkeyWalletAdministrationInventory, type TurnkeyWalletAdministrationClient } from './turnkey-wallet-administration.js';

const org = 'owner-org'; const user = 'owner-user'; const existing = `0x${'1'.repeat(40)}`; const imported = `0x${'2'.repeat(40)}`;
const now = new Date('2026-11-13T12:00:00Z'); const sealed = JSON.stringify({ encappedPublic: `04${'ab'.repeat(64)}`, ciphertext: 'cd'.repeat(48) });
const addresses = (address: string) => [{ format: 'ADDRESS_FORMAT_ETHEREUM', address }];
const privateKey = (privateKeyId: string, privateKeyName: string, address: string) => ({ privateKeyId, privateKeyName, addresses: addresses(address), curve: 'CURVE_SECP256K1', exported: false });
function fixture() {
  const keys = [privateKey('existing-key', 'existing', existing)];
  const getWhoami = vi.fn(async (_input: { organizationId: string }) => ({ organizationId: org, userId: user }));
  const getPrivateKeys = vi.fn(async (_input: { organizationId: string }) => ({ privateKeys: structuredClone(keys) }));
  const createPrivateKeys = vi.fn<NonNullable<TurnkeyWalletAdministrationClient['createPrivateKeys']>>(async input => {
    const result = input.privateKeys.map((request, index) => { const id = `created-${index}`; const address = `0x${String(index + 3).repeat(40)}`; keys.push(privateKey(id, request.privateKeyName, address)); return { privateKeyId: id, addresses: addresses(address) }; });
    return { privateKeys: result, activity: { id: 'create-activity', organizationId: org, status: 'ACTIVITY_STATUS_COMPLETED', type: 'ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2', intent: { createPrivateKeysIntentV2: { privateKeys: input.privateKeys } }, result: { createPrivateKeysResultV2: { privateKeys: result } } } };
  });
  const importPrivateKey = vi.fn<NonNullable<TurnkeyWalletAdministrationClient['importPrivateKey']>>(async input => {
    keys.push(privateKey('imported-key', input.privateKeyName, imported));
    const { organizationId: _organizationId, generateAppProofs: _generateAppProofs, ...intent } = input;
    const result = { privateKeyId: 'imported-key', addresses: addresses(imported) };
    return { ...result, activity: { id: 'import-activity', organizationId: org, status: 'ACTIVITY_STATUS_COMPLETED', type: 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY', intent: { importPrivateKeyIntent: intent }, result: { importPrivateKeyResult: result } } };
  });
  const client = { getWhoami, getPrivateKeys, createPrivateKeys, importPrivateKey };
  return { client, keys, getWhoami, getPrivateKeys, createPrivateKeys, importPrivateKey, port: createTurnkeyWalletAdministration({ client, organizationId: org, ownerUserId: user, credentialPurpose: 'owner-admin' }) };
}
async function service(port: ReturnType<typeof createTurnkeyWalletAdministration>) {
  const store = new DurableStore(); await store.open();
  return { store, administration: createWalletAdministration({ store, ownerId: 'owner', provider: port, authorize: async () => ({ ownerId: 'owner', channel: 'owner-cli', expiresAt: '2026-11-13T13:00:00Z' }), authorizedWallets: async () => [{ chainId: 1, address: existing, keyId: 'existing-key' }], now: () => now }) };
}

describe('attended Turnkey wallet administration adapter', () => {
  it('executes real SDK-shaped bulk standalone-key creation through durable public request and enrollment pipeline', async () => {
    const f = fixture(); const s = await service(f.port);
    await s.administration.request({ requestId: 'create', kind: 'generate', chainIds: [1, 8453], count: 2 });
    const result = await s.administration.execute('create');
    expect(result).toMatchObject({ state: 'completed', activityIds: ['create-activity'], keys: [{ keyId: 'created-0' }, { keyId: 'created-1' }] });
    expect(f.createPrivateKeys).toHaveBeenCalledTimes(1);
    expect(f.createPrivateKeys.mock.calls[0]![0]).toMatchObject({ organizationId: org, generateAppProofs: true, privateKeys: [{ curve: 'CURVE_SECP256K1', privateKeyTags: [], addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] }, { curve: 'CURVE_SECP256K1', privateKeyTags: [], addressFormats: ['ADDRESS_FORMAT_ETHEREUM'] }] });
    const draft = await s.administration.selectEnrollment({ requestId: 'create', keyIds: ['created-0'] });
    expect(draft.chains[0]!.wallets).toHaveLength(2); expect(draft.activeFleetChanged).toBe(false);
    await s.administration.execute('create'); expect(f.createPrivateKeys).toHaveBeenCalledTimes(1);
    expect(Object.keys(f.port).sort()).toEqual(['capability', 'generate', 'importSealed', 'inventory']);
  });
  it('forwards the already sealed HPKE envelope with owner-bound SDK import fields and persists public metadata only', async () => {
    const f = fixture(); const s = await service(f.port);
    await s.administration.request({ requestId: 'import', kind: 'import', chainIds: [1], expectedAddresses: [imported] });
    expect(await s.administration.execute('import', { sealedImports: [{ index: 0, encryptedBundle: sealed }] })).toMatchObject({ state: 'completed', keys: [{ address: imported }] });
    expect(f.importPrivateKey.mock.calls[0]![0]).toMatchObject({ organizationId: org, userId: user, encryptedBundle: sealed, curve: 'CURVE_SECP256K1', addressFormats: ['ADDRESS_FORMAT_ETHEREUM'], generateAppProofs: true });
    const publicState = JSON.stringify(s.store.snapshot()); expect(publicState).not.toContain('encappedPublic'); expect(publicState).not.toContain('ciphertext'); expect(publicState).not.toContain('cd'.repeat(48));
  });
  it('refuses owner operations with an ordinary runtime client even if its SDK object exposes admin methods', async () => {
    const f = fixture(); const runtime = createTurnkeyWalletAdministration({ client: f.client, organizationId: org, ownerUserId: user });
    expect(await runtime.capability()).toMatchObject({ ownerAdminAvailable: false, code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' });
    await expect(runtime.generate({ labels: ['test'] })).rejects.toThrow('WALLET_OWNER_ADMIN_CLIENT_REQUIRED'); expect(f.createPrivateKeys).not.toHaveBeenCalled();
  });
  it('refuses the wrong provider identity and never elevates a runtime user', async () => {
    const f = fixture(); f.getWhoami.mockResolvedValue({ organizationId: org, userId: 'mint-runtime-user' });
    expect(await f.port.capability()).toMatchObject({ ownerAdminAvailable: false }); await expect(f.port.importSealed({ label: 'test', expectedAddress: imported, encryptedBundle: sealed })).rejects.toThrow('WALLET_OWNER_ADMIN_CLIENT_REQUIRED'); expect(f.importPrivateKey).not.toHaveBeenCalled();
    f.getWhoami.mockResolvedValue({ organizationId: 'wrong-org', userId: user }); await expect(f.port.inventory()).rejects.toThrow('WALLET_PROVIDER_IDENTITY_INVALID'); expect(f.getPrivateKeys).not.toHaveBeenCalled();
  });
  it.each(['org', 'intent', 'result', 'exported', 'address'] as const)('rejects mismatched %s provider evidence without authorizing the new keys', async mode => {
    const f = fixture(); const original = f.createPrivateKeys.getMockImplementation()!;
    f.createPrivateKeys.mockImplementation(async input => {
      const result = await original(input) as { privateKeys: Array<{ privateKeyId: string; addresses: ReturnType<typeof addresses> }>; activity: { organizationId: string; intent: { createPrivateKeysIntentV2: { privateKeys: unknown } }; result: { createPrivateKeysResultV2: { privateKeys: unknown } } } };
      if (mode === 'org') result.activity.organizationId = 'wrong-org';
      if (mode === 'intent') result.activity.intent.createPrivateKeysIntentV2.privateKeys = [];
      if (mode === 'result') result.activity.result.createPrivateKeysResultV2.privateKeys = [];
      if (mode === 'exported') f.keys[1]!.exported = true;
      if (mode === 'address') f.keys[1]!.addresses = addresses(imported);
      return result;
    });
    const s = await service(f.port); await s.administration.request({ requestId: 'bad', kind: 'generate', chainIds: [1], count: 1 });
    expect(await s.administration.execute('bad')).toMatchObject({ state: 'ambiguous' }); expect((await s.administration.status()).enrollmentDrafts).toHaveLength(0);
  });
  it('leaves a timed-out provider call ambiguous and recovers by inventory without generating again', async () => {
    const f = fixture(); f.createPrivateKeys.mockImplementationOnce(async input => { f.keys.push(privateKey('later-key', input.privateKeys[0]!.privateKeyName, imported)); await new Promise(() => undefined); });
    const port = createTurnkeyWalletAdministration({ client: f.client, organizationId: org, ownerUserId: user, credentialPurpose: 'owner-admin', timeoutMs: 10 }); const s = await service(port);
    await s.administration.request({ requestId: 'timeout', kind: 'generate', chainIds: [1], count: 1 }); expect(await s.administration.execute('timeout')).toMatchObject({ state: 'ambiguous' });
    expect(await s.administration.execute('timeout')).toMatchObject({ state: 'completed', code: 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' }); expect(f.createPrivateKeys).toHaveBeenCalledTimes(1);
  });
  it('reports malformed inventory as incomplete and flags exported/HD/wrong-curve/duplicate-address keys', () => {
    const result = parseTurnkeyWalletAdministrationInventory({ privateKeys: [{ broken: true }, privateKey('a', 'a', existing), { ...privateKey('b', 'b', existing), exported: true }, { ...privateKey('c', 'c', imported), curve: 'CURVE_ED25519' }] }, org);
    expect(result.complete).toBe(false); expect(result.keys.every(key => !key.usable)).toBe(true); expect(result.keys[0]!.issues).toContain('WALLET_KEY_ADDRESS_DUPLICATE');
    expect(() => parseTurnkeyWalletAdministrationInventory({ wallets: [] }, org)).toThrow('WALLET_PROVIDER_INVENTORY_INCOMPLETE');
  });
  it('refuses plaintext or extra import material before calling the provider', async () => {
    const f = fixture(); await expect(f.port.importSealed({ label: 'plain', expectedAddress: imported, encryptedBundle: `0x${'a'.repeat(64)}` })).rejects.toThrow('WALLET_SEALED_IMPORT_REQUIRED'); expect(f.importPrivateKey).not.toHaveBeenCalled();
  });
});
