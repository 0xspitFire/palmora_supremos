import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { createWalletAdministration, DurableStore, type WalletAdministrationKey, type WalletAdministrationPort } from '@mint-bot/backend';
import { registerWalletAdministrationCommands, readWalletAdministrationSealedFile } from './wallet-administration-commands.js';
import type { WalletAdministrationRuntime, WalletAdministrationRuntimeOptions } from './wallet-administration-runtime.js';
import { readWalletAdministrationQueue } from './wallet-administration-service.js';
const start = new Date('2026-11-13T12:00:00Z'); const address = `0x${'1'.repeat(40)}`; const other = `0x${'2'.repeat(40)}`;
const sealed = JSON.stringify({ encappedPublic: `04${'ab'.repeat(64)}`, ciphertext: 'cd'.repeat(48) });
async function fixture() {
  const store = new DurableStore(); await store.open(); let time = start;
  const keys: WalletAdministrationKey[] = [{ keyId: 'existing', label: 'Existing', address, usable: true, issues: [] }];
  const generate = vi.fn(async (input: { labels: readonly string[] }) => { const created = { keyId: 'new-key', label: input.labels[0]!, address: other, usable: true, issues: [] }; keys.push(created); return { activityId: 'new-activity', keys: [created] }; });
  const importSealed = vi.fn(async (input: { label: string; expectedAddress: string; encryptedBundle: string }) => { const created = { keyId: 'import-key', label: input.label, address: input.expectedAddress, usable: true, issues: [] }; keys.push(created); return { activityId: 'import-activity', keys: [created] }; });
  const provider: WalletAdministrationPort = { capability: async () => ({ organizationId: 'org', ownerAdminAvailable: true, code: 'WALLET_OWNER_ADMIN_AVAILABLE' }), inventory: async () => ({ organizationId: 'org', keys: structuredClone(keys), complete: true, issues: [] }), generate, importSealed };
  const created = vi.fn(async (options: WalletAdministrationRuntimeOptions): Promise<WalletAdministrationRuntime> => ({ store, ownerId: options.ownerId, mode: options.mode ?? 'public', profileStatus: { code: 'WALLET_TEST_PROFILE' }, serviceFor: authorize => createWalletAdministration({ store, ownerId: '1001', authorize, provider, authorizedWallets: async () => [{ chainId: 1, keyId: 'existing', address }], now: () => time }), approvalCurrent: async () => true, close: async () => undefined }));
  const outputs: string[] = []; const readSealed = vi.fn(async () => [{ index: 0, encryptedBundle: sealed }]);
  const run = async (...args: string[]) => { const cli = yargs([]).exitProcess(false).strict().fail((message, error) => { throw error ?? new Error(message); }); registerWalletAdministrationCommands(cli, { runtimeRoot: '/synthetic-root', createRuntime: created, now: () => time, write: text => { outputs.push(text); }, readSealedImports: readSealed }); await cli.parseAsync(['wallet-admin', ...args, '--owner-id', '1001']); return JSON.parse(outputs.at(-1)!); };
  return { run, store, outputs, created, generate, importSealed, readSealed, keys, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}
describe('wallet-admin actual CLI registrar', () => {
  it('registers without I/O and emits a concrete non-signing profile template without opening credentials/runtime', async () => {
    const s = await fixture(); const result = await s.run('profile-template', '--organization-id', 'org', '--admin-user-id', 'admin', '--runtime-user-id', 'runtime');
    expect(s.created).not.toHaveBeenCalled(); expect(result.providerPolicyTemplate.condition).toContain('ACTIVITY_TYPE_IMPORT_PRIVATE_KEY'); expect(result.providerPolicyTemplate).not.toHaveProperty('time'); expect(result).toMatchObject({ onlinePolicyAdministration: false, fundingAuthority: false });
  });
  it('routes public creation to queue, isolated execute to backend/provider once, and enrollment to a reviewable public draft', async () => {
    const s = await fixture(); expect(await s.run('request', '--request-id', 'create1', '--kind', 'generate', '--chains', '1', '--count', '1')).toMatchObject({ state: 'queued' }); expect(s.generate).not.toHaveBeenCalled();
    expect(await s.run('execute', '--request-id', 'create1')).toMatchObject({ requests: [{ state: 'completed' }], activeFleetChanged: false });
    await s.run('execute', '--request-id', 'create1'); expect(s.generate).toHaveBeenCalledTimes(1);
    expect(s.created.mock.calls.map(row => row[0].mode)).toEqual(['public', 'owner-admin', 'owner-admin']);
    expect(await s.run('enroll', '--request-id', 'create1', '--key-ids', 'new-key')).toMatchObject({ activeFleetChanged: false, requiresOfflineOwnerApproval: true });
  });
  it('executes a public import only when explicit owner-side sealed input is supplied, and never outputs it', async () => {
    const s = await fixture(); await s.run('request', '--request-id', 'import1', '--kind', 'import', '--chains', '1', '--addresses', other);
    await s.run('execute', '--request-id', 'import1', '--sealed-import-file', '/synthetic/sealed.json'); expect(s.readSealed).toHaveBeenCalledWith('/synthetic/sealed.json', 'import1'); expect(s.importSealed).toHaveBeenCalledTimes(1); expect(s.outputs.join('')).not.toContain('ciphertext'); expect(JSON.stringify(s.store.snapshot())).not.toContain('encappedPublic');
  });
  it('does not let a fresh execute command renew stale queued ownership approval', async () => {
    const s = await fixture(); await s.run('request', '--request-id', 'old', '--kind', 'generate', '--chains', '1', '--count', '1'); s.advance(300_000);
    expect(await s.run('execute', '--request-id', 'old')).toMatchObject({ requests: [{ state: 'expired' }] }); expect(s.generate).not.toHaveBeenCalled();
  });
  it('routes group assignment and retirement as public metadata/drafts, preserving canonical campaign and active fleet', async () => {
    const s = await fixture(); await s.run('group', '--group-id', 'main', '--chain', '1', '--name', 'Main Fleet', '--addresses', address);
    await s.store.transaction(state => state.campaigns.push({ id: 'c', chainId: 1, state: 'Draft', contract: other, strategy: 'seadrop-v1-public', quantity: 1, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1n } } as never));
    expect(await s.run('assign', '--campaign-id', 'c', '--group-id', 'main')).toMatchObject({ mutation: 'selection-draft-only', addresses: [address] }); expect(s.store.snapshot().campaigns[0]!.state).toBe('Draft');
    expect(await s.run('retire', '--request-id', 'retire1', '--key-ids', 'existing')).toMatchObject({ state: 'pending-owner-rebind-revoke', providerKeysDeleted: false }); expect(s.keys).toHaveLength(1);
  });
  it('rejects sealed input on public commands and raw-key address arguments', async () => {
    const s = await fixture(); expect(await s.run('request', '--kind', 'generate', '--chains', '1', '--count', '1', '--sealed-import-file', '/wrong.json')).toMatchObject({ state: 'blocked', code: 'WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED' }); expect(s.readSealed).not.toHaveBeenCalled();
    expect(await s.run('request', '--kind', 'import', '--chains', '1', '--addresses', `0x${'a'.repeat(64)}`)).toMatchObject({ state: 'blocked', code: 'WALLET_ADMIN_PUBLIC_ARGUMENTS_REQUIRED' }); expect(s.importSealed).not.toHaveBeenCalled();
  });
  it('explicit reconciliation resolves ambiguity by inventory without a provider retry', async () => {
    const s = await fixture(); s.generate.mockImplementationOnce(async input => { s.keys.push({ keyId: 'lost-key', label: input.labels[0]!, address: other, usable: true, issues: [] }); throw new Error('lost response'); });
    await s.run('request', '--request-id', 'lost1', '--kind', 'generate', '--chains', '1', '--count', '1'); await s.run('execute', '--request-id', 'lost1');
    expect(await s.run('reconcile', '--request-id', 'lost1')).toMatchObject({ state: 'completed', code: 'WALLET_INVENTORY_LABELS_RECONCILED_OWNER_REVIEW' }); expect(s.generate).toHaveBeenCalledTimes(1); expect(readWalletAdministrationQueue(s.store.snapshot().events)[0]!.state).toBe('completed');
  });
});
describe('owner-only sealed JSON file boundary', () => {
  it('reads only exact HPKE envelopes and rejects swapped ids, symlinks, permissive modes and raw-key files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wallet-admin-sealed-')); const path = join(directory, 'sealed.json');
    try {
      await writeFile(path, JSON.stringify({ requestId: 'i', sealedImports: [{ index: 0, encryptedBundle: sealed }] }), { mode: 0o600 }); expect(await readWalletAdministrationSealedFile(path, 'i')).toHaveLength(1);
      await expect(readWalletAdministrationSealedFile(path, 'different')).rejects.toThrow('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED'); await chmod(path, 0o640); await expect(readWalletAdministrationSealedFile(path, 'i')).rejects.toThrow('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED'); await chmod(path, 0o600);
      const link = join(directory, 'linked.json'); await symlink(path, link); await expect(readWalletAdministrationSealedFile(link, 'i')).rejects.toThrow('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
      await writeFile(path, JSON.stringify({ requestId: 'i', sealedImports: [{ index: 0, encryptedBundle: `0x${'a'.repeat(64)}` }] })); await expect(readWalletAdministrationSealedFile(path, 'i')).rejects.toThrow('WALLET_SEALED_IMPORT_OWNER_FILE_REQUIRED');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
