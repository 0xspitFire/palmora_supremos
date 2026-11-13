import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CanonicalStoreBridge, createWalletAdministration, type BackendStore, type WalletAdministrationAuthority, type WalletAdministrationPort, type WalletAdministrationReference } from '@mint-bot/backend';
import { openDatabase, TelegramAccessRepository } from '@mint-bot/database';
import { assertTurnkeyWalletAdminProviderState, createTurnkeyClient, readTurnkeyApprovedPolicyRecords, readTurnkeySecretConfig, readTurnkeyWalletAdminPolicyRecords, turnkeyWalletAdminPolicyExpressions, type TurnkeySecretConfig } from '@mint-bot/engine';
import { configuredSecretRoot } from './runtime.js';
import { createTurnkeyWalletAdministration, type TurnkeyWalletAdministrationClient } from './turnkey-wallet-administration.js';
import { queueWalletAdministrationRequest, readWalletAdministrationQueue, reconcileWalletAdministrationOperatorRequest, validateWalletAdministrationOperatorArguments, type WalletAdministrationApproval, type WalletAdministrationService } from './wallet-administration-service.js';

import { assertWalletAdminLinuxIsolation } from './wallet-administration-isolation.js';

export const WALLET_ADMIN_CREDENTIAL_BASENAME = 'turnkey-wallet-admin.env';
export interface WalletAdministrationRuntime {
  store: BackendStore;
  ownerId: string;
  mode: 'public' | 'owner-admin';
  profileStatus: { code: string; organizationId?: string; adminUserId?: string; mintRuntimeUserId?: string; policyId?: string; expiresAt?: string };
  serviceFor(authorize: () => Promise<WalletAdministrationAuthority>): WalletAdministrationService;
  approvalCurrent(approval: WalletAdministrationApproval): Promise<boolean>;
  close(): Promise<void>;
}
export interface WalletAdministrationRuntimeOptions {
  runtimeRoot: string;
  ownerId: string;
  mode?: 'public' | 'owner-admin';
  store?: BackendStore;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  /** Test/embedding ports: no secret read is necessary to test composition. */
  provider?: WalletAdministrationPort;
  authorizedWallets?: () => Promise<readonly WalletAdministrationReference[]>;
  approvalCurrent?: (approval: WalletAdministrationApproval) => Promise<boolean>;
  loadConfig?: (root: string) => Promise<TurnkeySecretConfig>;
  clientFactory?: typeof createTurnkeyClient;
  checkAdminFile?: (path: string, root: string) => Promise<void>;
  checkIsolation?: (input: Parameters<typeof assertWalletAdminLinuxIsolation>[0]) => Promise<unknown>;
}
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;
export function assertWalletAdminCredentialPath(path: string | undefined, root: string): string {
  if (!path || !isAbsolute(path) || basename(path) !== WALLET_ADMIN_CREDENTIAL_BASENAME) throw new Error('WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED');
  const result = resolve(path); const subpath = relative(resolve(root), result);
  if (subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) throw new Error('WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED');
  return result;
}
/** Admin credentials are strictly owner-readable, even where the mint runtime
 * accepts root:mintbot0640 records. No symlink traversal or runtime group read. */
export async function checkWalletAdminCredentialFile(path: string, root: string): Promise<void> {
  assertWalletAdminCredentialPath(path, root);
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('WALLET_ADMIN_CREDENTIAL_PERMISSIONS_REQUIRED');
    if (current === resolve(path)) {
      const uid = process.geteuid?.() ?? process.getuid?.();
      if (!info.isFile() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0) throw new Error('WALLET_ADMIN_CREDENTIAL_PERMISSIONS_REQUIRED');
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export function walletAdministrationProfileTemplate(input: { organizationId: string; adminUserId: string; mintRuntimeUserId: string; ownerId: string }) {
  if (![input.organizationId, input.adminUserId, input.mintRuntimeUserId, input.ownerId].every(value => ID.test(value)) || input.adminUserId === input.mintRuntimeUserId) throw new Error('WALLET_ADMIN_PROFILE_BINDING_REQUIRED');
  return {
    context: 'mintbot.wallet-administration-setup/v1', ...input,
    providerPolicyTemplate: { policyName: 'MintBot isolated wallet enrollment', ...turnkeyWalletAdminPolicyExpressions({ adminUserId: input.adminUserId }) },
    credentialFile: WALLET_ADMIN_CREDENTIAL_BASENAME,
    isolationProfileEnvironment: 'MINT_BOT_WALLET_ADMIN_ISOLATION_PROFILE_PATH',
    isolationGuide: 'ops/host/wallet-administration-isolation.md',
    credentialFields: ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_USER_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_WALLET_MAP_PATH', 'TURNKEY_POLICY_BUNDLE_PATH', 'TURNKEY_POLICY_APPROVER_PUBLIC_KEY_PATH', 'TURNKEY_WALLET_ADMIN_POLICY_RECORD_PATH'],
    requirements: ['Use a distinct non-root Turnkey user whose only ALLOW policy is the exact create/init-import/import policy above.', 'Install reviewed source supporting the independently signed non-signing management record before adding that policy to the existing mint organization.', 'Obtain the actual policy projection; create and sign the finite management record offline with the existing owner approval key. Never copy that private approval key to a host or chat.', 'Install a root-owned Linux isolation profile binding distinct nonroot UIDs, mint service groups, exact credential/DB/kill paths and owner ID. Keep credentials under an admin-owned0700 directory with0400/0600 single-link files. Never share the mint service secret group.', 'Run wallet-admin worker only as a separate OWNER-TRUSTED canonical DB writer with the explicit admin credential file, isolation profile and owner ID. Grant named-user ACLs only on the canonical DB directory and DB/WAL/SHM files. SQLite cannot restrict tables; this worker is trusted with the entire canonical DB. Use the exact shared kill path read-only. Do not give the mint service the admin credential.', 'Produce sealed imports with the genuine provider enclave import bundle on the owner side; this worker accepts only the resulting HPKE envelope, never plaintext keys.', 'New keys remain outside the mint fleet. Review enrollment drafts through the existing fleet-change proposal, offline sign/install, no-broadcast rehearsal and retirement/revocation procedure.', 'To retire the management role, revoke/remove its provider ALLOW policy before removing public record references. Expired or missing records with a remaining ALLOW block the strict mint inventory check.'],
    onlinePolicyAdministration: false, fundingAuthority: false, signedRecordInstalled: false,
  };
}

export async function createWalletAdministrationRuntime(options: WalletAdministrationRuntimeOptions): Promise<WalletAdministrationRuntime> {
  if (!ID.test(options.ownerId)) throw new Error('WALLET_ADMIN_OWNER_ID_REQUIRED');
  const now = options.now ?? (() => new Date()); const environment = options.environment ?? process.env; const mode = options.mode ?? 'public';
  const secretRoot = resolve(environment.MINT_BOT_SECRET_ROOT ?? configuredSecretRoot(options.runtimeRoot));
  const databasePath = resolve(options.runtimeRoot, environment.MINT_BOT_STATE_PATH ?? './Rets/state/backend.sqlite');
  const killSwitchPath = resolve(options.runtimeRoot, environment.KILL_SWITCH_PATH ?? 'Rets/state/killswitch');
  const assertIsolation = async () => {
    if (mode !== 'owner-admin') return;
    await (options.checkIsolation ?? assertWalletAdminLinuxIsolation)({ profilePath: environment.MINT_BOT_WALLET_ADMIN_ISOLATION_PROFILE_PATH, ownerId: options.ownerId, credentialPath: assertWalletAdminCredentialPath(environment.TURNKEY_SECRET_FILE, secretRoot), databasePath, killSwitchPath });
  };
  if (mode === 'owner-admin') {
    await assertIsolation();
    const path = assertWalletAdminCredentialPath(environment.TURNKEY_SECRET_FILE, secretRoot);
    try { await (options.checkAdminFile ?? checkWalletAdminCredentialFile)(path, secretRoot); }
    catch (error) { throw new Error(error instanceof Error && error.message === 'WALLET_ADMIN_CREDENTIAL_PERMISSIONS_REQUIRED' ? error.message : 'WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED'); }
  }
  else if (environment.TURNKEY_SECRET_FILE && basename(environment.TURNKEY_SECRET_FILE) === WALLET_ADMIN_CREDENTIAL_BASENAME) throw new Error('WALLET_ADMIN_PROFILE_FORBIDDEN_IN_MINT_RUNTIME');
  const database = options.store ? undefined : openDatabase(databasePath);
  const store = options.store ?? new CanonicalStoreBridge(database!);
  let provider = options.provider; let authorized = options.authorizedWallets;
  let providerForAuthority: ((authorize: () => Promise<WalletAdministrationAuthority>) => WalletAdministrationPort) | undefined;
  let profileStatus: WalletAdministrationRuntime['profileStatus'] = { code: mode === 'owner-admin' ? 'WALLET_ADMIN_SIGNED_POLICY_REQUIRED' : 'WALLET_OWNER_ADMIN_WORKER_REQUIRED' };
  try {
    if (!options.store) await store.open();
    if (!provider) {
      if (environment !== process.env && !options.loadConfig) throw new Error('WALLET_ADMIN_CONFIG_READER_REQUIRED');
      let config: TurnkeySecretConfig;
      try { config = await (options.loadConfig ?? readTurnkeySecretConfig)(secretRoot); }
      catch { throw new Error(mode === 'owner-admin' ? 'WALLET_ADMIN_CREDENTIAL_PROFILE_REQUIRED' : 'WALLET_ADMIN_RUNTIME_INVENTORY_UNAVAILABLE'); }
      const client = (options.clientFactory ?? createTurnkeyClient)(config.organizationId, config.apiPublicKey, config.apiPrivateKey);
      const base = createTurnkeyWalletAdministration({ client: client as unknown as TurnkeyWalletAdministrationClient, organizationId: config.organizationId, ownerUserId: config.userId, credentialPurpose: mode === 'owner-admin' ? 'owner-admin' : 'mint-runtime' });
      let management: Awaited<ReturnType<typeof readTurnkeyWalletAdminPolicyRecords>>;
      try { management = await readTurnkeyWalletAdminPolicyRecords(config, { role: mode === 'owner-admin' ? 'wallet-admin' : 'mint-runtime', now: now() }); }
      catch { throw new Error('WALLET_ADMIN_SIGNED_POLICY_INVALID_OR_EXPIRED'); }
      if (mode === 'owner-admin' && management.length !== 1) throw new Error('WALLET_ADMIN_SIGNED_POLICY_REQUIRED');
      const record = management[0];
      if (record) profileStatus = { code: mode === 'owner-admin' ? 'WALLET_ADMIN_SIGNED_PROFILE_LOADED' : 'WALLET_ADMIN_SIGNED_PROFILE_PUBLIC', organizationId: record.organizationId, adminUserId: record.adminUserId, mintRuntimeUserId: record.mintRuntimeUserId, policyId: record.policyId, expiresAt: record.expiresAt };
      const assertAdmin = async (): Promise<void> => {
        if (mode !== 'owner-admin' || !record) throw new Error('WALLET_ADMIN_SIGNED_POLICY_REQUIRED');
        await assertIsolation();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([(async () => {
            const [organization, policies, identity] = await Promise.all([client.getOrganizationConfigs({ organizationId: config.organizationId }), client.getPolicies({ organizationId: config.organizationId }), client.getWhoami({ organizationId: config.organizationId })]);
            const who = identity as { organizationId?: unknown; userId?: unknown };
            if (who.organizationId !== config.organizationId || who.userId !== record.adminUserId) throw new Error('WALLET_ADMIN_PROFILE_BINDING_REQUIRED');
            assertTurnkeyWalletAdminProviderState(record, { organizationId: String(who.organizationId), adminUserId: String(who.userId), environment: config.environment, organization, policies: policies.policies }, now());
          })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('WALLET_ADMIN_PROFILE_BINDING_REQUIRED')), 20_000); })]);
        } catch { throw new Error('WALLET_ADMIN_PROFILE_BINDING_REQUIRED'); }
        finally { if (timer) clearTimeout(timer); }
      };
      provider = base;
      if (mode === 'owner-admin') providerForAuthority = authorize => {
        const admin = client as unknown as TurnkeyWalletAdministrationClient;
        // Revalidate the original approval AFTER asynchronous provider policy/
        // identity checks, immediately before the actual SDK mutating method.
        const scopedClient: TurnkeyWalletAdministrationClient = {
          getWhoami: input => admin.getWhoami(input), getPrivateKeys: input => admin.getPrivateKeys(input),
          ...(admin.createPrivateKeys ? { createPrivateKeys: async input => { await assertAdmin(); await assertIsolation(); await authorize(); return admin.createPrivateKeys!(input); } } : {}),
          ...(admin.importPrivateKey ? { importPrivateKey: async input => { await assertAdmin(); await assertIsolation(); await authorize(); return admin.importPrivateKey!(input); } } : {}),
        };
        const scoped = createTurnkeyWalletAdministration({ client: scopedClient, organizationId: config.organizationId, ownerUserId: config.userId, credentialPurpose: 'owner-admin' });
        return { ...scoped, capability: async () => { await assertAdmin(); await authorize(); return scoped.capability(); } };
      };
      authorized ??= async () => {
        const records = await readTurnkeyApprovedPolicyRecords('mainnet', secretRoot, { role: mode === 'owner-admin' ? 'wallet-admin' : 'mint-runtime' }); const refs = new Map<string, WalletAdministrationReference>();
        for (const record of records) for (const wallet of record.wallets) { const chainId = record.enforcementPolicy.transaction.chainId; refs.set(`${chainId}:${wallet.address.toLowerCase()}`, { chainId, keyId: wallet.signWith, address: wallet.address }); }
        return [...refs.values()];
      };
    }
    const approvalCurrent = options.approvalCurrent ?? (async (approval: WalletAdministrationApproval) => {
      if (approval.ownerId !== options.ownerId || Date.parse(approval.expiresAt) <= now().getTime()) return false;
      if (approval.channel === 'owner-cli') return true;
      if (!database) return false;
      const session = new TelegramAccessRepository(database, now).openSession();
      if (!session || session.id !== approval.sessionId || Date.parse(session.expiresAt) <= now().getTime()) return false;
      const since = Date.parse(session.openedAt);
      if (!Number.isFinite(since) || store.snapshot().events.some(event => event.type === 'kill' && Date.parse(event.at) > since)) return false;
      const kill = (store as { killSwitchStatus?: () => { engaged: boolean; changedAt: string } }).killSwitchStatus?.();
      if (kill?.engaged && Date.parse(kill.changedAt) > since) return false;
      try { const file = await lstat(killSwitchPath); if (file.isSymbolicLink() || file.mtimeMs > since) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
      return true;
    });
    return { store, ownerId: options.ownerId, mode, profileStatus, serviceFor: authorize => {
      const currentAuthority = async (): Promise<WalletAdministrationAuthority> => {
        const authority = await authorize(); const current = now().getTime(); const expiry = Date.parse(authority.expiresAt);
        if (authority.ownerId !== options.ownerId || !['owner-cli', 'telegram'].includes(authority.channel) || !Number.isFinite(current) || !Number.isFinite(expiry) || expiry <= current || expiry - current > 12 * 3600_000) throw new Error('WALLET_ADMIN_APPROVAL_REQUIRED');
        return authority;
      };
      return createWalletAdministration({ store, ownerId: options.ownerId, provider: providerForAuthority?.(currentAuthority) ?? provider, authorizedWallets: authorized ?? (async () => []), authorize: currentAuthority, now });
    }, approvalCurrent, async close() { if (!options.store) (store as CanonicalStoreBridge).close(); } };
  } catch (error) { database?.close(); throw error; }
}

export interface WalletAdministrationOperatorAuthority extends WalletAdministrationApproval { assertCurrent(): Promise<void>; }
/** One shared public-operation path for CLI and owner-private Telegram. */
export async function runWalletAdministrationOperator(runtime: WalletAdministrationRuntime, input: { action: string; args: readonly string[]; authority: WalletAdministrationOperatorAuthority; now?: () => Date }): Promise<unknown> {
  const now = input.now ?? (() => new Date()); const { authority, args } = input;
  validateWalletAdministrationOperatorArguments(input.action, args);
  const authorize = async (): Promise<WalletAdministrationAuthority> => { await authority.assertCurrent(); if (authority.ownerId !== runtime.ownerId) throw new Error('WALLET_ADMIN_APPROVAL_REQUIRED'); return { ownerId: authority.ownerId, channel: authority.channel, expiresAt: authority.expiresAt }; };
  await authorize(); const administration = runtime.serviceFor(authorize);
  const ids = (text: string | undefined): string[] => (text ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const chains = (text: string | undefined): Array<1 | 8453 | 4663> => ids(text).map(value => { if (!['1', '8453', '4663'].includes(value)) throw new Error('WALLET_GROUP_CHAIN_INVALID'); return Number(value) as 1 | 8453 | 4663; });
  switch (input.action) {
    case 'status': return { ...(await administration.status()), operatorRequests: readWalletAdministrationQueue(runtime.store.snapshot().events), profile: runtime.profileStatus };
    case 'inventory': return administration.inventory();
    case 'groups': return (await administration.status()).groups;
    case 'generate': case 'import': {
      const request = { requestId: args[0] ?? `wallet_admin_${randomUUID()}`, kind: input.action, chainIds: chains(args[1]), ...(input.action === 'generate' ? { count: Number(args[2]) } : { expectedAddresses: ids(args[2]) }) } as const;
      await authority.assertCurrent(); return queueWalletAdministrationRequest({ store: runtime.store, ownerId: runtime.ownerId, authority, request, now });
    }
    case 'group': { const selected = chains(args[1]); if (selected.length !== 1) throw new Error('WALLET_GROUP_CHAIN_INVALID'); return administration.saveGroup({ id: args[0] ?? '', chainId: selected[0]!, name: args[2] ?? '', addresses: ids(args[3]) }); }
    case 'assign': return administration.assignCampaign({ campaignId: args[0] ?? '', groupId: args[1] ?? '' });
    case 'enroll': return administration.selectEnrollment({ requestId: args[0] ?? '', keyIds: ids(args[1]), replaceKeyIds: ids(args[2]) });
    case 'retire': return administration.draftRetirement({ requestId: args[0] ?? '', keyIds: ids(args[1]) });
    case 'reconcile': return reconcileWalletAdministrationOperatorRequest({ store: runtime.store, ownerId: runtime.ownerId, administration, requestId: args[0] ?? '', now });
    default: throw new Error('WALLET_ADMIN_COMMAND_INVALID');
  }
}
