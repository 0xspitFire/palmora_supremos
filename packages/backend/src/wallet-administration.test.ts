import { describe, expect, it, vi } from 'vitest';
import { DurableStore } from './store.js';
import { CanonicalStoreBridge } from './canonical-store.js';
import { ETHEREUM, fixture, close } from './canonical-fixtures.js';
import { createWalletAdministration, validateWalletSealedImport, type WalletAdministrationAuthority, type WalletAdministrationKey, type WalletAdministrationOptions, type WalletAdministrationPort } from './wallet-administration.js';
const now = new Date('2026-11-13T12:00:00Z');
const existing = `0x${'1'.repeat(40)}`; const imported = `0x${'2'.repeat(40)}`;
const sealed = JSON.stringify({ encappedPublic: `04${'ab'.repeat(64)}`, ciphertext: 'cd'.repeat(48) });
const key = (keyId: string, label: string, address: string): WalletAdministrationKey => ({ keyId, label, address, usable: true, issues: [] });
async function setup() {
  const store = new DurableStore(); await store.open();
  const keys = [key('existing-key', 'existing', existing)];
  const generate = vi.fn(async (input: { labels: readonly string[] }) => {
    const created = input.labels.map((label, index) => key(`new-${index}`, label, `0x${String(index + 3).repeat(40)}`)); keys.push(...created); return { activityId: 'generate-activity', keys: created };
  });
  const importSealed = vi.fn(async (input: { label: string; expectedAddress: string; encryptedBundle: string }) => { const created = key(`import-${keys.length}`, input.label, input.expectedAddress); keys.push(created); return { activityId: `import-activity-${keys.length}`, keys: [created] }; });
  const provider: WalletAdministrationPort = { capability: async () => ({ ownerAdminAvailable: true, organizationId: 'org', code: 'WALLET_OWNER_ADMIN_AVAILABLE' }), inventory: async () => ({ organizationId: 'org', keys: structuredClone(keys), complete: true, issues: [] }), generate, importSealed };
  let authority: WalletAdministrationAuthority = { ownerId: 'owner', channel: 'owner-cli', expiresAt: '2026-11-13T13:00:00Z' };
  const options: WalletAdministrationOptions = { store, ownerId: 'owner', authorize: async () => authority, provider, authorizedWallets: async () => [{ chainId: 1, keyId: 'existing-key', address: existing }], now: () => now };
  return { options, store, keys, generate, importSealed, provider, service: createWalletAdministration(options), setAuthority: (value: WalletAdministrationAuthority) => { authority = value; } };
}

describe('owner wallet administration public durable workflow', () => {
  it('claims generation once, verifies public inventory and produces an offline enrollment draft', async () => {
    const s = await setup(); const input = { requestId: 'create-batch', kind: 'generate' as const, chainIds: [1, 8453] as const, count: 2 };
    const planned = await s.service.request(input); expect(planned.state).toBe('planned'); expect(s.generate).not.toHaveBeenCalled();
    expect(await s.service.request(input)).toEqual(planned);
    expect(await s.service.execute(input.requestId)).toMatchObject({ state: 'completed', activityIds: ['generate-activity'], keys: [{ keyId: 'new-0' }, { keyId: 'new-1' }] });
    await s.service.execute(input.requestId); expect(s.generate).toHaveBeenCalledTimes(1);
    const draft = await s.service.selectEnrollment({ requestId: input.requestId, keyIds: ['new-0'] });
    expect(draft).toMatchObject({ activeFleetChanged: false, requiresOfflineOwnerApproval: true, chains: [{ chainId: 1, wallets: [{ signWith: 'existing-key' }, { signWith: 'new-0' }] }, { chainId: 8453, wallets: [{ signWith: 'new-0' }] }] });
    expect(s.store.snapshot().reservations).toHaveLength(0); expect(s.store.snapshot().campaigns).toHaveLength(0);
  });
  it('keeps request idempotency bound to the exact requested operation and chain set', async () => {
    const s = await setup(); await s.service.request({ requestId: 'r', kind: 'generate', chainIds: [1], count: 1 });
    await expect(s.service.request({ requestId: 'r', kind: 'generate', chainIds: [8453], count: 1 })).rejects.toThrow('WALLET_ADMIN_IDEMPOTENCY_CONFLICT');
    await expect(s.service.request({ requestId: 'r', kind: 'generate', chainIds: [1], count: 2 })).rejects.toThrow('WALLET_ADMIN_IDEMPOTENCY_CONFLICT'); expect(s.generate).not.toHaveBeenCalled();
  });
  it('does not retry an ambiguous provider outcome; inventory-only reconciliation can recover a lost response', async () => {
    const s = await setup(); s.generate.mockImplementationOnce(async input => { s.keys.push(key('lost-key', input.labels[0]!, imported)); throw new Error('https://credential.invalid/private'); });
    await s.service.request({ requestId: 'lost', kind: 'generate', chainIds: [1], count: 1 });
    expect(await s.service.execute('lost')).toMatchObject({ state: 'ambiguous', code: 'WALLET_PROVIDER_OUTCOME_AMBIGUOUS' });
    expect(await s.service.execute('lost')).toMatchObject({ state: 'completed', code: 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' });
    expect(s.generate).toHaveBeenCalledTimes(1); expect(JSON.stringify(s.store.eventSnapshot())).not.toContain('credential.invalid');
  });
  it('leaves an ambiguous absent/partial result unresolved instead of manufacturing keys or retrying', async () => {
    const s = await setup(); s.generate.mockRejectedValueOnce(new Error('network'));
    await s.service.request({ requestId: 'missing', kind: 'generate', chainIds: [1], count: 1 }); await s.service.execute('missing');
    const restarted = createWalletAdministration(s.options); expect(await restarted.execute('missing')).toMatchObject({ state: 'ambiguous', code: 'WALLET_PROVIDER_RECONCILIATION_REQUIRED' }); expect(s.generate).toHaveBeenCalledTimes(1);
    await expect(restarted.selectEnrollment({ requestId: 'missing', keyIds: ['invented'] })).rejects.toThrow('WALLET_PROVIDER_RECONCILIATION_REQUIRED');
  });
  it('allows only one provider call across concurrent executions', async () => {
    const s = await setup(); await s.service.request({ requestId: 'concurrent', kind: 'generate', chainIds: [1], count: 1 });
    await Promise.all([s.service.execute('concurrent'), createWalletAdministration(s.options).execute('concurrent')]); expect(s.generate).toHaveBeenCalledTimes(1);
  });
  it('forwards sealed imports only in memory and preserves safe partial-batch ambiguity', async () => {
    const s = await setup(); const second = `0x${'4'.repeat(40)}`;
    await s.service.request({ requestId: 'import-batch', kind: 'import', chainIds: [1], expectedAddresses: [imported, second] });
    s.importSealed.mockImplementationOnce(async input => { const created = key('first-import', input.label, input.expectedAddress); s.keys.push(created); return { activityId: 'first-activity', keys: [created] }; });
    s.importSealed.mockRejectedValueOnce(new Error(sealed));
    const input = { sealedImports: [{ index: 0, encryptedBundle: sealed }, { index: 1, encryptedBundle: sealed }] };
    expect(await s.service.execute('import-batch', input)).toMatchObject({ state: 'ambiguous', activityIds: ['first-activity'] });
    expect(JSON.stringify(s.store.eventSnapshot())).not.toContain('encappedPublic'); expect(JSON.stringify(s.store.eventSnapshot())).not.toContain('cd'.repeat(48));
    await s.service.execute('import-batch', input); expect(s.importSealed).toHaveBeenCalledTimes(2);
    const request = (await s.service.status()).requests[0]!; s.keys.push(key('second-import', request.items[1]!.label, second));
    expect(await s.service.reconcile('import-batch')).toMatchObject({ state: 'completed', code: 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' });
  });
  it.each(['plaintext', 'extra-field', 'bad-encapsulation'] as const)('refuses %s import material before a provider mutation', async mode => {
    const s = await setup(); await s.service.request({ requestId: 'i', kind: 'import', chainIds: [1], expectedAddresses: [imported] });
    const value = mode === 'plaintext' ? `0x${'a'.repeat(64)}` : mode === 'extra-field' ? JSON.stringify({ ...JSON.parse(sealed), privateKey: 'never-persist' }) : JSON.stringify({ encappedPublic: 'bad', ciphertext: 'cd'.repeat(48) });
    await expect(s.service.execute('i', { sealedImports: [{ index: 0, encryptedBundle: value }] })).rejects.toThrow('WALLET_SEALED_IMPORT_REQUIRED'); expect(s.importSealed).not.toHaveBeenCalled(); expect((await s.service.status()).requests[0]!.state).toBe('planned');
  });
  it('refuses raw-key fields on public request schemas', async () => {
    const s = await setup(); await expect(s.service.request({ requestId: 'r', kind: 'generate', chainIds: [1], count: 1, privateKey: 'never-persist' } as never)).rejects.toThrow('WALLET_ADMIN_REQUEST_INVALID'); expect(s.store.eventSnapshot()).toHaveLength(0);
  });
  it('requires current owner authentication and confines imports/provider mutations to owner CLI', async () => {
    const s = await setup(); s.setAuthority({ ownerId: 'owner', channel: 'telegram', expiresAt: '2026-11-13T13:00:00Z' });
    await s.service.request({ requestId: 'telegram-draft', kind: 'generate', chainIds: [1], count: 1 });
    await expect(s.service.execute('telegram-draft')).rejects.toThrow('WALLET_OWNER_CLI_ADMIN_REQUIRED');
    await expect(s.service.request({ requestId: 'import', kind: 'import', chainIds: [1], expectedAddresses: [imported] })).rejects.toThrow('WALLET_OWNER_CLI_ADMIN_REQUIRED');
    s.setAuthority({ ownerId: 'viewer', channel: 'telegram', expiresAt: '2026-11-13T13:00:00Z' }); await expect(s.service.status()).rejects.toThrow('WALLET_OWNER_AUTHORITY_REQUIRED');
    s.setAuthority({ ownerId: 'owner', channel: 'owner-cli', expiresAt: now.toISOString() }); await expect(s.service.inventory()).rejects.toThrow('WALLET_OWNER_AUTHORITY_REQUIRED'); expect(s.generate).not.toHaveBeenCalled();
  });
  it('returns an owner-admin action requirement with the mint runtime client and leaves the request unclaimed', async () => {
    const s = await setup(); s.provider.capability = async () => ({ ownerAdminAvailable: false, organizationId: 'org', code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' });
    await s.service.request({ requestId: 'r', kind: 'generate', chainIds: [1], count: 1 }); await expect(s.service.execute('r')).rejects.toThrow('WALLET_OWNER_ADMIN_CLIENT_REQUIRED'); expect((await s.service.status()).requests[0]!.state).toBe('planned');
  });
  it('restores completed/ambiguous requests and edited groups from same-time SQLite history', async () => {
    const s = await setup(); const sql = await fixture(ETHEREUM);
    try {
      const options = { ...s.options, store: sql.store }; const service = createWalletAdministration(options);
      await service.request({ requestId: 'cold', kind: 'generate', chainIds: [1], count: 1 }); await service.execute('cold');
      await service.saveGroup({ id: 'g', chainId: 1, name: 'Original', addresses: [existing] }); await service.saveGroup({ id: 'g', chainId: 1, name: 'Changed', addresses: [] });
      const cold = new CanonicalStoreBridge(sql.db); await cold.open(); const restored = createWalletAdministration({ ...options, store: cold });
      expect((await restored.status()).requests[0]!.state).toBe('completed'); expect((await restored.status()).groups[0]!.name).toBe('Changed');
      await restored.execute('cold'); expect(s.generate).toHaveBeenCalledTimes(1);
    } finally { await close(sql); }
  });
  it('groups only known custody references and persists chain-specific campaign selections without mutating approval state', async () => {
    const s = await setup(); await s.service.saveGroup({ id: 'g', chainId: 1, name: 'Ethereum Fleet', addresses: [existing] });
    await expect(s.service.saveGroup({ id: 'g', chainId: 8453, name: 'Wrong Chain', addresses: [existing] })).rejects.toThrow('WALLET_GROUP_CHAIN_IMMUTABLE');
    await expect(s.service.saveGroup({ id: 'unknown', chainId: 1, name: 'Unknown', addresses: [imported] })).rejects.toThrow('WALLET_GROUP_CUSTODY_REFERENCE_UNKNOWN');
    await s.store.transaction(state => state.campaigns.push({ id: 'campaign', state: 'Draft', chainId: 1, contract: nftAddress(), strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n } } as never));
    expect(await s.service.assignCampaign({ campaignId: 'campaign', groupId: 'g' })).toMatchObject({ mutation: 'selection-draft-only', addresses: [existing] });
    expect(s.store.snapshot().campaigns[0]!.state).toBe('Draft');
    await s.store.transaction(state => { state.campaigns[0]!.state = 'Armed'; }); await expect(s.service.assignCampaign({ campaignId: 'campaign', groupId: 'g' })).rejects.toThrow('WALLET_CAMPAIGN_DRAFT_REQUIRED');
  });
  it('retirement of authorized keys requires offline rebind/revoke and never deletes keys', async () => {
    const s = await setup(); const draft = await s.service.draftRetirement({ requestId: 'retire', keyIds: ['existing-key'] });
    expect(draft).toMatchObject({ state: 'pending-owner-rebind-revoke', providerKeysDeleted: false, activeFleetChanged: false }); expect(s.keys).toHaveLength(1);
  });
  it.each(['reservation', 'run', 'attempt'] as const)('blocks retirement/replacement with unresolved %s', async mode => {
    const s = await setup(); await s.store.transaction(state => {
      if (mode === 'reservation') state.reservations.push({ id: 'r', runId: 'r', campaignId: 'c', wallet: existing, amountWei: 1n, accountingDate: '2026-11-13', status: 'reserved', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      if (mode === 'run') state.runs.push({ id: 'r', campaignId: 'c', intentId: 'missing-intent', mode: 'live', requestDigest: 'd', state: 'Active', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      if (mode === 'attempt') state.attempts.push({ id: 'a', runId: 'r', executionId: 'e', wallet: existing, state: 'Signed', createdAt: now.toISOString(), updatedAt: now.toISOString() });
    });
    await expect(s.service.draftRetirement({ requestId: 'retire', keyIds: ['existing-key'] })).rejects.toThrow(/^WALLET_/);
    expect(s.store.eventSnapshot().some(event => event.type === 'wallet_administration_retirement_draft')).toBe(false);
  });
  it('bounds managed batches and recognizes only the actual HPKE envelope shape', async () => {
    const s = await setup(); await expect(s.service.request({ requestId: 'too-many', kind: 'generate', chainIds: [1], count: 11 })).rejects.toThrow('WALLET_ADMIN_REQUEST_INVALID'); expect(() => validateWalletSealedImport(sealed)).not.toThrow();
  });
  it('rechecks owner session expiry after awaited provider reads before persisting a request', async () => {
    const s = await setup(); s.provider.inventory = async () => { s.setAuthority({ ownerId: 'owner', channel: 'owner-cli', expiresAt: now.toISOString() }); return { organizationId: 'org', keys: s.keys, complete: true, issues: [] }; };
    await expect(s.service.request({ requestId: 'expired-during-read', kind: 'generate', chainIds: [1], count: 1 })).rejects.toThrow('WALLET_OWNER_AUTHORITY_REQUIRED'); expect(s.store.eventSnapshot()).toHaveLength(0); expect(s.generate).not.toHaveBeenCalled();
  });
});
function nftAddress(): string { return `0x${'f'.repeat(40)}`; }
