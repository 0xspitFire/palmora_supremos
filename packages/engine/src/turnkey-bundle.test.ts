import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { installTurnkeyPolicyBundleAtomic } from './turnkey-bundle.js';
import { createTurnkeyPolicyRecord, signTurnkeyPolicyRecord, turnkeyProviderPolicyExpressions } from './turnkey-policy-record.js';
import type { TurnkeyPolicyAst } from './turnkey-policy.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fixture() {
  const owner = generateKeyPairSync('ed25519');
  const address = '0x1111111111111111111111111111111111111111' as Address;
  const ast: TurnkeyPolicyAst = { version: 1, effect: 'allow', scope: { provider: 'turnkey', environment: 'production', organizationId: 'org', userId: 'runtime', policyId: 'policy', keyIds: ['key'] }, transaction: { chainId: 4663, from: [address], to: '0x2222222222222222222222222222222222222222', valueWei: '0', data: '0x161ac21f' as Hex, gasLimitMax: '200000', maxFeePerGasMax: '1000000000', maxPriorityFeePerGasMax: '100000000', accessList: [] } };
  const expressions = turnkeyProviderPolicyExpressions(ast);
  const timestamp = { seconds: '1800000000', nanos: '0' };
  const record = createTurnkeyPolicyRecord({ environment: 'production', providerIdentity: { organizationId: 'org', organizationName: 'MintBot', userId: 'runtime', username: 'runtime' }, providerPolicy: { policyId: 'policy', policyName: 'exact', effect: 'EFFECT_ALLOW', createdAt: timestamp, updatedAt: timestamp, notes: '', ...expressions }, enforcementPolicy: ast, walletReferences: [{ index: 0, address, signWith: 'key' }], providerKeys: [{ privateKeyId: 'key', publicKey: `02${'ab'.repeat(32)}`, privateKeyName: 'key', curve: 'CURVE_SECP256K1', addresses: [{ format: 'ADDRESS_FORMAT_ETHEREUM', address }], privateKeyTags: [], createdAt: timestamp, updatedAt: timestamp, exported: false, imported: true }], issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z' });
  const signed = signTurnkeyPolicyRecord(record, owner.privateKey);
  const catalog = { version: 1 as const, context: 'mintbot.turnkey-policy-catalog/v1' as const, records: [signed] };
  const walletMap = { version: 2 as const, policyRecordDigest: signed.recordDigest, wallets: signed.record.wallets.map(({ index, address: wallet, signWith }) => ({ index, address: wallet, signWith })) };
  return { owner, bundle: { version: 1 as const, context: 'mintbot.turnkey-policy-bundle/v1' as const, activeRecord: signed, catalog, walletMap } };
}

describe('privileged Turnkey policy bundle installation', () => {
  it('atomically installs and fsyncs one immutable generation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mintbot-turnkey-bundle-')); roots.push(parent);
    const root = join(parent, 'bundles');
    const { owner, bundle } = fixture();
    const installed = await installTurnkeyPolicyBundleAtomic({ bundle, pinnedPublicKey: owner.publicKey, bundleRoot: root, privileged: false, now: new Date('2030-06-01T00:00:00.000Z') });
    expect(JSON.parse(await readFile(installed.current, 'utf8'))).toEqual(bundle);
    expect((await lstat(installed.current)).isSymbolicLink()).toBe(false);
    await writeFile(installed.generation, '{}\n');
    await expect(installTurnkeyPolicyBundleAtomic({ bundle, pinnedPublicKey: owner.publicKey, bundleRoot: root, privileged: false, now: new Date('2030-06-01T00:00:00.000Z') })).rejects.toThrow('TURNKEY_POLICY_BUNDLE_GENERATION_MISMATCH');
  });

  it('rejects a symlinked root and requires root by default', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mintbot-turnkey-bundle-')); roots.push(parent);
    const target = join(parent, 'target');
    await writeFile(target, 'x');
    const linked = join(parent, 'linked');
    await symlink(target, linked);
    const { owner, bundle } = fixture();
    await expect(installTurnkeyPolicyBundleAtomic({ bundle, pinnedPublicKey: owner.publicKey, bundleRoot: linked, privileged: false, now: new Date('2030-06-01T00:00:00.000Z') })).rejects.toThrow('TURNKEY_POLICY_BUNDLE_ROOT_INVALID');
    if (process.getuid?.() !== 0) await expect(installTurnkeyPolicyBundleAtomic({ bundle, pinnedPublicKey: owner.publicKey, bundleRoot: join(parent, 'root-required'), now: new Date('2030-06-01T00:00:00.000Z') })).rejects.toThrow('TURNKEY_POLICY_BUNDLE_INSTALL_REQUIRES_ROOT');
  });
});
