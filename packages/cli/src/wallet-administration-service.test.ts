import { describe, expect, it, vi } from 'vitest';
import { CanonicalStoreBridge, createWalletAdministration, DurableStore, type BackendStore, type WalletAdministrationKey, type WalletAdministrationPort } from '@mint-bot/backend';
import { openDatabase } from '@mint-bot/database';
import { queueWalletAdministrationRequest, readWalletAdministrationQueue, startWalletAdministrationWorker, type WalletAdministrationApproval, type WalletAdministrationWorkerOptions } from './wallet-administration-service.js';
const start = new Date('2026-11-13T12:00:00Z'); const address = `0x${'1'.repeat(40)}`;
const sealed = JSON.stringify({ encappedPublic: `04${'ab'.repeat(64)}`, ciphertext: 'cd'.repeat(48) });
async function fixture(store?: BackendStore) {
  const state = store ?? new DurableStore(); if (!store) await state.open(); let time = start; let sessionCurrent = true;
  const keys: WalletAdministrationKey[] = [];
  const generate = vi.fn(async (input: { labels: readonly string[] }) => { const created = input.labels.map((label, index) => ({ keyId: `key-${index}`, label, address: `0x${String(index + 1).repeat(40)}`, usable: true, issues: [] })); keys.push(...created); return { activityId: 'create-activity', keys: created }; });
  const importSealed = vi.fn(async (input: { label: string; expectedAddress: string; encryptedBundle: string }) => { const created = { keyId: 'import-key', label: input.label, address: input.expectedAddress, usable: true, issues: [] }; keys.push(created); return { activityId: 'import-activity', keys: [created] }; });
  const provider: WalletAdministrationPort = { capability: async () => ({ ownerAdminAvailable: true, organizationId: 'org', code: 'WALLET_OWNER_ADMIN_AVAILABLE' }), inventory: async () => ({ organizationId: 'org', keys: structuredClone(keys), complete: true, issues: [] }), generate, importSealed };
  const approval: WalletAdministrationApproval = { ownerId: '1001', channel: 'telegram', sessionId: 'session1', expiresAt: '2026-11-13T13:00:00Z' };
  const options: WalletAdministrationWorkerOptions = { store: state, ownerId: '1001', approvalCurrent: async value => sessionCurrent && value.sessionId === approval.sessionId, now: () => time, administration: authorize => createWalletAdministration({ store: state, ownerId: '1001', provider, authorizedWallets: async () => [], authorize, now: () => time }) };
  const queue = (id = 'request1') => queueWalletAdministrationRequest({ store: state, ownerId: '1001', authority: approval, request: { requestId: id, kind: 'generate', chainIds: [1], count: 1 }, now: () => time });
  return { store: state, approval, options, queue, keys, generate, importSealed, provider, advance: (ms: number) => { time = new Date(time.getTime() + ms); }, revoke: () => { sessionCurrent = false; } };
}
describe('isolated owner administration worker', () => {
  it('consumes an approved public request through durable backend claim once and never changes active fleet state', async () => {
    const s = await fixture(); await s.queue(); const worker = startWalletAdministrationWorker(s.options);
    try { await worker.tick(); await worker.tick(); expect(readWalletAdministrationQueue(s.store.snapshot().events)).toMatchObject([{ state: 'completed' }]); expect(s.generate).toHaveBeenCalledTimes(1); expect(s.store.snapshot().reservations).toHaveLength(0); } finally { await worker.stop(); }
  });
  it.each(['expired', 'revoked', 'wrong-owner'] as const)('refuses %s approval before consuming a queued provider request', async mode => {
    const s = await fixture(); await s.queue(); if (mode === 'expired') s.advance(300_000); if (mode === 'revoked') s.revoke();
    const worker = startWalletAdministrationWorker({ ...s.options, ...(mode === 'wrong-owner' ? { ownerId: '2002' } : {}) });
    try { await worker.tick(); expect(s.generate).not.toHaveBeenCalled(); const queue = readWalletAdministrationQueue(s.store.snapshot().events); expect(queue[0]!.state).toBe(mode === 'wrong-owner' ? 'queued' : 'expired'); } finally { await worker.stop(); }
  });
  it('never extends an old approval when the same public request id is submitted again', async () => {
    const s = await fixture(); const first = await s.queue(); s.advance(400_000); const duplicate = await s.queue(); expect(duplicate.expiresAt).toBe(first.expiresAt);
    const worker = startWalletAdministrationWorker(s.options); try { await worker.tick(); expect(s.generate).not.toHaveBeenCalled(); } finally { await worker.stop(); }
  });
  it('rejects conflicting ids, wrong owners, extra/private material and overlarge batches at ingress', async () => {
    const s = await fixture(); await s.queue(); const common = { store: s.store, ownerId: '1001', authority: s.approval, now: () => start };
    await expect(queueWalletAdministrationRequest({ ...common, request: { requestId: 'request1', kind: 'generate', chainIds: [1], count: 2 } })).rejects.toThrow('WALLET_ADMIN_IDEMPOTENCY_CONFLICT');
    await expect(queueWalletAdministrationRequest({ ...common, authority: { ...s.approval, ownerId: 'viewer' }, request: { requestId: 'other', kind: 'generate', chainIds: [1], count: 1 } })).rejects.toThrow('WALLET_ADMIN_APPROVAL_REQUIRED');
    await expect(queueWalletAdministrationRequest({ ...common, request: { requestId: 'other', kind: 'generate', chainIds: [1], count: 1, encryptedBundle: sealed } as never })).rejects.toThrow('WALLET_ADMIN_PUBLIC_REQUEST_INVALID');
    await expect(queueWalletAdministrationRequest({ ...common, request: { requestId: 'other', kind: 'generate', chainIds: [1], count: 11 } })).rejects.toThrow('WALLET_ADMIN_PUBLIC_REQUEST_INVALID');
  });
  it('keeps missing admin capability actionable without making a provider call', async () => {
    const s = await fixture(); await s.queue(); s.provider.capability = async () => ({ organizationId: 'org', ownerAdminAvailable: false, code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' });
    const worker = startWalletAdministrationWorker(s.options); try { await worker.tick(); expect(s.generate).not.toHaveBeenCalled(); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]).toMatchObject({ state: 'owner-action-required', code: 'WALLET_OWNER_ADMIN_CLIENT_REQUIRED' }); } finally { await worker.stop(); }
  });
  it('queues only public imports; requires owner-side sealed material and never persists it', async () => {
    const s = await fixture(); await queueWalletAdministrationRequest({ store: s.store, ownerId: '1001', authority: s.approval, request: { requestId: 'import1', kind: 'import', chainIds: [1], expectedAddresses: [address] }, now: () => start });
    const first = startWalletAdministrationWorker(s.options); await first.tick(); await first.stop(); expect(s.importSealed).not.toHaveBeenCalled(); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.code).toBe('WALLET_SEALED_IMPORT_OWNER_INPUT_REQUIRED');
    const worker = startWalletAdministrationWorker({ ...s.options, sealedImports: async () => [{ index: 0, encryptedBundle: sealed }] });
    try { await worker.tick(); expect(s.importSealed).toHaveBeenCalledTimes(1); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.state).toBe('completed'); expect(JSON.stringify(s.store.snapshot())).not.toContain('ciphertext'); } finally { await worker.stop(); }
  });
  it('rechecks the same session after asynchronous inventory before the provider mutation', async () => {
    const s = await fixture(); await s.queue(); s.provider.inventory = async () => { s.revoke(); return { organizationId: 'org', keys: [], complete: true, issues: [] }; };
    const worker = startWalletAdministrationWorker(s.options); try { await worker.tick(); expect(s.generate).not.toHaveBeenCalled(); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.state).not.toBe('completed'); } finally { await worker.stop(); }
  });
  it('does not retry ambiguous delivery and supports explicit inventory-only reconciliation later', async () => {
    const s = await fixture(); await s.queue(); s.generate.mockImplementationOnce(async input => { s.keys.push({ keyId: 'lost', label: input.labels[0]!, address, usable: true, issues: [] }); throw new Error('provider secret response'); });
    const worker = startWalletAdministrationWorker(s.options); try { await worker.tick(); await worker.tick(); expect(s.generate).toHaveBeenCalledTimes(1); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.state).toBe('ambiguous'); } finally { await worker.stop(); }
    const administration = await s.options.administration(async () => ({ ownerId: '1001', channel: 'owner-cli', expiresAt: s.approval.expiresAt })); expect(await administration.reconcile('request1')).toMatchObject({ state: 'completed', code: 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' });
  });
  it('another worker encountering a started request only reconciles, and stop drains the first provider writer', async () => {
    const s = await fixture(); await s.queue(); let release!: () => void; const original = s.generate.getMockImplementation()!;
    s.generate.mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve; }); return original(input); });
    const first = startWalletAdministrationWorker(s.options); const pass = first.tick();
    for (let i = 0; i < 60 && !release; i++) await Promise.resolve();
    expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.state).toBe('started'); const second = startWalletAdministrationWorker(s.options); await second.tick(); await second.stop(); expect(s.generate).toHaveBeenCalledTimes(1);
    let drained = false; const stop = first.stop().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false); release(); await pass; await stop; expect(drained).toBe(true);
  });
  it('restores same-time queue lifecycle from SQLite and does not repeat completed provider work', async () => {
    const database = openDatabase(); const store = new CanonicalStoreBridge(database); await store.open(); const s = await fixture(store);
    const worker = startWalletAdministrationWorker(s.options);
    try { await s.queue(); await worker.tick(); const cold = new CanonicalStoreBridge(database); await cold.open(); expect(readWalletAdministrationQueue(cold.eventSnapshot())[0]!.state).toBe('completed'); const restarted = startWalletAdministrationWorker({ ...s.options, store: cold }); await restarted.tick(); await restarted.stop(); expect(s.generate).toHaveBeenCalledTimes(1); } finally { await worker.stop(); database.close(); }
  });
});
