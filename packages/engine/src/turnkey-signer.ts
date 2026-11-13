import { resolveChainConfigFromSecrets } from './chains.js';
import { independentPublicRpcEndpoints } from './turnkey-public-authority.js';
import { verifyReviewedErc721Registry, verifyErc721WalletAuthority, verifyErc721RehearsalAuthority, assertErc721RehearsalIntent, assertErc721IntentAuthority, type VerifiedErc721RehearsalAuthority, type VerifiedReviewedErc721Registry, type VerifiedErc721Authority } from './verified-erc721-authority.js';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  keccak256,
  zeroAddress,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  encodeFunctionData,
  parseAbi,
  createPublicClient, http, type PublicClient,
  type Address,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { Turnkey } from '@turnkey/sdk-server';
import type { SecretScope } from './secrets.js';
import type { Signer, TransactionIntent, WalletInfo } from './types.js';
import {
  turnkeyPolicyRecordDigest,
  validateTurnkeyActualProviderState,
  validateTurnkeyCanonicalPolicyRecord,
  verifyTurnkeySignedPolicyRecord,
  verifyTurnkeySignedPolicyCatalog,
  type TurnkeyCanonicalPolicyRecord,
} from './turnkey-policy-record.js';
import {
  canonicalPolicyDigest,
  normalizeAccessList,
  normalizeHexBytes,
  turnkeyPolicyRef,
  validatePolicyBinding,
  validateTransactionIntent,
  type TurnkeyEnvironment,
  type TurnkeyPolicyAst,
  type TurnkeyProviderBinding,
} from './turnkey-policy.js';
import { allowlistLeaf } from './allowlist.js';
import { buildAllowlistMint, type VerifiedWalletProof } from './allowlist-authority.js';
import { SIGNED_MINT_ABI } from './signed-mint-authority.js';
import { verifyTurnkeySignedAuthority } from './turnkey-signed-authority.js';
import { verifyTurnkeyAllowlistAuthority } from './turnkey-allowlist-authority.js';
import { verifyTurnkeyPublicAuthority } from './turnkey-public-authority.js';
import { validateTurnkeyPolicyBundle } from './turnkey-bundle.js';
import { assertTurnkeyWalletAdminRecordCurrent, verifyTurnkeyWalletAdminPolicyRecord, type VerifiedTurnkeyWalletAdminPolicyRecord } from './turnkey-wallet-admin-policy.js';

export interface TurnkeyWalletReference {
  index: number;
  address: Address;
  signWith: string;
}

export interface TurnkeyWalletMap {
  version: 2;
  policyRecordDigest: `sha256:${string}`;
  wallets: TurnkeyWalletReference[];
}

export interface TurnkeySecretConfig {
  organizationId: string;
  environment: TurnkeyEnvironment;
  apiPublicKey: string;
  apiPrivateKey: string;
  userId: string;
  walletMapPath: string;
  policyRecordPath: string;
  policyApproverPublicKeyPath: string;
  policyCatalogPath?: string;
  policyBundlePath?: string;
  /** Public, separately owner-signed non-signing role record; never an admin credential. */
  walletAdminPolicyRecordPath?: string;
  reviewedProtocolRegistryPath?: string;
  appName?: string;
  attestationPath?: string;
  attestationActivityId?: string;
}

export type TurnkeyFundingCredentials = Pick<TurnkeySecretConfig, 'organizationId' | 'environment' | 'apiPublicKey' | 'apiPrivateKey' | 'userId'>;

/** Dedicated funding worker input. Never resolves the mint credential or any default path. */
export async function readTurnkeyFundingCredentials(path: string): Promise<TurnkeyFundingCredentials> {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== 'turnkey-funding.env') throw new Error('TURNKEY_FUNDING_CREDENTIAL_PATH_INVALID');
  const text = await readOwnerOnlyFile(path, 'TURNKEY_FUNDING_CREDENTIAL_PERMISSIONS_REQUIRED');
  return parseTurnkeyFundingCredentialText(text);
}

/** Pure decoder, kept separate so synthetic tests never need a real credential file. */
export function parseTurnkeyFundingCredentialText(text: string): TurnkeyFundingCredentials {
  const allowed = ['TURNKEY_ORGANIZATION_ID', 'TURNKEY_USER_ID', 'TURNKEY_API_PUBLIC_KEY', 'TURNKEY_API_PRIVATE_KEY', 'TURNKEY_ENVIRONMENT'];
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('TURNKEY_FUNDING_CREDENTIAL_INVALID');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!allowed.includes(key) || values.has(key) || !value || value.length > 10_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('TURNKEY_FUNDING_CREDENTIAL_INVALID');
    values.set(key, value);
  }
  if (values.size !== allowed.length || values.get('TURNKEY_ENVIRONMENT') !== 'production') throw new Error('TURNKEY_FUNDING_CREDENTIAL_INVALID');
  return { organizationId: values.get('TURNKEY_ORGANIZATION_ID')!, userId: values.get('TURNKEY_USER_ID')!, apiPublicKey: values.get('TURNKEY_API_PUBLIC_KEY')!, apiPrivateKey: values.get('TURNKEY_API_PRIVATE_KEY')!, environment: 'production' };
}

export interface TurnkeySignerClient {
  signTransaction(input: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_ETHEREUM';
    generateAppProofs?: boolean;
  }): Promise<{ signedTransaction: string; activity: TurnkeySigningActivity }>;
  getWhoami(input?: { organizationId?: string }): Promise<unknown>;
  getOrganizationConfigs(input: { organizationId: string }): Promise<unknown>;
  getPolicies(input: { organizationId: string }): Promise<{ policies: unknown[] }>;
  getPrivateKeys(input: { organizationId: string }): Promise<{ privateKeys: unknown[] }>;
}

export interface TurnkeySigningActivity {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
  readonly type: string;
  readonly fingerprint: string;
  readonly appProofs?: readonly unknown[];
  readonly intent: { readonly signTransactionIntentV2?: { readonly signWith?: string; readonly unsignedTransaction?: string; readonly type?: string } };
  readonly result: { readonly signTransactionResult?: { readonly signedTransaction?: string } };
}

export interface TurnkeySigningEvidence {
  readonly activityId: string;
  readonly activityFingerprint: string;
  readonly appProofCount: number;
}

export interface TurnkeyClient extends TurnkeySignerClient {
  initImportPrivateKey(input: {
    organizationId: string;
    userId: string;
    generateAppProofs?: boolean;
  }): Promise<{ importBundle: string }>;
  importPrivateKey(input: {
    organizationId: string;
    userId: string;
    privateKeyName: string;
    encryptedBundle: string;
    curve: 'CURVE_SECP256K1';
    addressFormats: ['ADDRESS_FORMAT_ETHEREUM'];
    generateAppProofs?: boolean;
  }): Promise<{
    privateKeyId: string;
    addresses: Array<{ format?: string; address?: string }>;
    activity: {
      organizationId: string;
      status: string;
      type: string;
      intent: { importPrivateKeyIntent?: { userId?: string } };
      result: { importPrivateKeyResult?: { privateKeyId?: string; addresses?: Array<{ format?: string; address?: string }> } };
    };
  }>;
  getActivities(input: {
    organizationId: string;
    paginationOptions?: { limit?: string };
  }): Promise<{ activities: Array<{ id: string; type: string; status: string; createdAt?: unknown; appProofs?: unknown[] }> }>;
  getAppProofs(input: { organizationId: string; activityId: string }): Promise<{ appProofs: unknown[] }>;
  getLatestBootProof(input: { organizationId: string; appName: string }): Promise<{ bootProof: unknown }>;
}

export interface TurnkeySignerOptions {
  organizationId: string;
  environment: TurnkeyEnvironment;
  userId: string;
  wallets: readonly TurnkeyWalletReference[];
  policyRecord: TurnkeyCanonicalPolicyRecord;
  approvedPolicyRecords?: readonly TurnkeyCanonicalPolicyRecord[];
  walletAdminPolicyRecords?: readonly VerifiedTurnkeyWalletAdminPolicyRecord[];
  client: TurnkeySignerClient;
  generateAppProofs?: boolean;
  verifyAllowlistAuthority?: (intent: TransactionIntent) => Promise<void>;
  verifyPublicAuthority?: (intent: TransactionIntent) => Promise<void>;
  verifySignedAuthority?: (intent: TransactionIntent) => Promise<void>;
  verifyReviewedAuthority?: (intent: TransactionIntent) => Promise<VerifiedErc721Authority>;
  verifyReviewedRehearsalAuthority?: (intent: TransactionIntent) => Promise<VerifiedErc721RehearsalAuthority>;
}

export interface TurnkeyHealthReport {
  status: 'ok';
  provider: 'turnkey';
  organizationId: string;
  walletCount: number;
  policyId: string;
  policyDigest: Hex;
  policyRecordDigest: `sha256:${string}`;
}

export interface TurnkeyPolicySelection {
  readonly policyReference: string;
  readonly policyDigest: Hex;
  readonly recordDigest: `sha256:${string}`;
}

export function turnkeyPolicySelection(record: TurnkeyCanonicalPolicyRecord): TurnkeyPolicySelection {
  const policyDigest = canonicalPolicyDigest(record.enforcementPolicy);
  return {
    policyReference: turnkeyPolicyRef(record.enforcementPolicy.scope.policyId, policyDigest),
    policyDigest,
    recordDigest: turnkeyPolicyRecordDigest(record),
  };
}

export function selectTurnkeyPolicyRecord(records: readonly TurnkeyCanonicalPolicyRecord[], policyReference: string, recordDigest?: string): TurnkeyCanonicalPolicyRecord {
  const matches = records.filter((record) => {
    const selection = turnkeyPolicySelection(record);
    return selection.policyReference === policyReference && (recordDigest === undefined || selection.recordDigest === recordDigest);
  });
  if (matches.length !== 1) throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
  return matches[0]!;
}

/** Loads only an optional public signed sidecar; never an admin credential or signing client. */
export async function readTurnkeyWalletAdminPolicyRecords(config: Pick<TurnkeySecretConfig, 'organizationId' | 'userId' | 'environment' | 'policyApproverPublicKeyPath' | 'walletAdminPolicyRecordPath'>, options: { now?: Date; role?: 'mint-runtime' | 'wallet-admin'; pinnedPublicKey?: string | Buffer } = {}): Promise<readonly VerifiedTurnkeyWalletAdminPolicyRecord[]> {
  if (!config.walletAdminPolicyRecordPath) return [];
  let raw: unknown;
  try { raw = JSON.parse(await readOwnerOnlyFile(config.walletAdminPolicyRecordPath, 'TURNKEY_WALLET_ADMIN_RECORD_PERMISSIONS_REQUIRED')); }
  catch { throw new Error('TURNKEY_WALLET_ADMIN_RECORD_INVALID'); }
  const publicKey = options.pinnedPublicKey ?? await readOwnerOnlyFile(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
  const record = verifyTurnkeyWalletAdminPolicyRecord(raw, publicKey, options.now);
  const selectedUser = options.role === 'wallet-admin' ? record.adminUserId : record.mintRuntimeUserId;
  if (record.organizationId !== config.organizationId || record.environment !== config.environment || selectedUser !== config.userId) throw new Error('TURNKEY_WALLET_ADMIN_BINDING_INVALID');
  return [record];
}

/** Reads the owner-approved mint catalog without constructing a signing client. */
export async function readTurnkeyApprovedPolicyRecords(scope: SecretScope = 'mainnet', root = 'Rets', options: { role?: 'mint-runtime' | 'wallet-admin' } = {}): Promise<readonly TurnkeyCanonicalPolicyRecord[]> {
  const config = await readTurnkeySecretConfig(root, scope);
  const publicKey = await readOwnerOnlyFile(config.policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
  const adminRecords = await readTurnkeyWalletAdminPolicyRecords(config, { pinnedPublicKey: publicKey, role: options.role });
  const assertBindings = (records: readonly TurnkeyCanonicalPolicyRecord[]) => {
    const mintUser = options.role === 'wallet-admin' ? adminRecords[0]?.mintRuntimeUserId : config.userId;
    if (!mintUser || records.some(record => record.providerIdentity.organizationId !== config.organizationId || record.environment !== config.environment || record.providerIdentity.userId !== mintUser)) throw new Error('TURNKEY_PROVIDER_BINDING_REQUIRED');
    return records;
  };
  if (config.policyBundlePath) {
    let bundle: unknown;
    try { bundle = JSON.parse(await readOwnerOnlyFile(config.policyBundlePath, 'TURNKEY_POLICY_BUNDLE_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_BUNDLE_INVALID'); }
    return assertBindings(verifyTurnkeySignedPolicyCatalog(validateTurnkeyPolicyBundle(bundle, publicKey).catalog, publicKey));
  }
  if (config.policyCatalogPath) {
    let catalog: unknown;
    try { catalog = JSON.parse(await readOwnerOnlyFile(config.policyCatalogPath, 'TURNKEY_POLICY_CATALOG_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_CATALOG_INVALID'); }
    return assertBindings(verifyTurnkeySignedPolicyCatalog(catalog, publicKey));
  }
  let signed: unknown;
  try { signed = JSON.parse(await readOwnerOnlyFile(config.policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_RECORD_INVALID'); }
  return assertBindings([verifyTurnkeySignedPolicyRecord(signed, publicKey)]);
}

export function createTurnkeyClient(
  organizationId: string,
  apiPublicKey: string,
  apiPrivateKey: string,
): TurnkeyClient {
  const turnkey = new Turnkey({
    apiBaseUrl: 'https://api.turnkey.com',
    apiPrivateKey,
    apiPublicKey,
    defaultOrganizationId: organizationId,
  });
  return turnkey.apiClient() as TurnkeyClient;
}

function expandPath(value: string): string {
  return value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(value);
}

function pathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/** Protected public profile. Missing configuration never authorizes a generic destination. */
export async function readTurnkeyReviewedRegistries(config: Pick<TurnkeySecretConfig,'reviewedProtocolRegistryPath'|'policyApproverPublicKeyPath'|'organizationId'|'userId'|'environment'>, now: Date = new Date()): Promise<readonly VerifiedReviewedErc721Registry[]> {
 if(!config.reviewedProtocolRegistryPath)throw new Error('ERC721_OWNER_REGISTRY_REQUIRED');
 let raw:unknown;try{raw=JSON.parse(await readOwnerOnlyFile(config.reviewedProtocolRegistryPath,'ERC721_REGISTRY_PERMISSIONS_REQUIRED'));}catch{throw new Error('ERC721_REGISTRY_UNVERIFIED');}
 const publicKey=await readOwnerOnlyFile(config.policyApproverPublicKeyPath,'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
 const catalog=raw as {version?:unknown;context?:unknown;records?:unknown};
 let records:unknown[];
 if(catalog?.context==='mintbot.reviewed-erc721-registries/v1'){
  if(catalog.version!==1||Object.keys(catalog).sort().join(',')!=='context,records,version'||!Array.isArray(catalog.records)||catalog.records.length<1||catalog.records.length>3)throw new Error('ERC721_REGISTRY_UNVERIFIED');records=catalog.records;
 }else records=[raw];
 const registries=records.map(value=>verifyReviewedErc721Registry(value,publicKey,now));
 if(new Set(registries.map(value=>value.chainId)).size!==registries.length || registries.some(registry=>registry.organizationId!==config.organizationId || registry.userId!==config.userId || registry.environment!==config.environment))throw new Error('ERC721_REGISTRY_BINDING_INVALID');return registries;
}
export async function readTurnkeyReviewedRegistry(config: Pick<TurnkeySecretConfig,'reviewedProtocolRegistryPath'|'policyApproverPublicKeyPath'|'organizationId'|'userId'|'environment'>, now: Date = new Date(), chainId?: number): Promise<VerifiedReviewedErc721Registry> {
 const records=(await readTurnkeyReviewedRegistries(config,now)).filter(value=>chainId===undefined||value.chainId===chainId);
 if(records.length!==1)throw new Error('ERC721_REGISTRY_BINDING_INVALID');return records[0]!;
}

async function readOwnerOnlyFile(path: string, errorCode: string): Promise<string> {
  let handle;
  try {
    await assertNoSymlinkParents(path, errorCode);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = await handle.stat();
    const runtimeUid = typeof process.geteuid === 'function' ? process.geteuid() : process.getuid?.();
    const runtimeGroups = typeof process.getgroups === 'function' ? process.getgroups() : [];
    if (!file.isFile() || runtimeUid === undefined || !isSecureTurnkeyFileAccess(file, runtimeUid, runtimeGroups)) throw new Error(errorCode);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/** Local owner-only files and production root-owned/group-readable files are accepted; writable group/world modes are rejected. */
export function isSecureTurnkeyFileAccess(file: { mode: number; uid: number; gid: number }, runtimeUid: number, runtimeGroups: readonly number[]): boolean {
  const permissions = file.mode & 0o777;
  // Root-owned production files are deliberately group-readable (root:mintbot
  // 0640/0440) so the service can read them. When the verifier itself runs as
  // root, the owner branch must preserve that production shape; otherwise root
  // rejects the same files that the mintbot service is allowed to read.
  if (file.uid === runtimeUid) {
    const groupReadableRoot = runtimeUid === 0 && (permissions & 0o037) === 0;
    return (groupReadableRoot || (permissions & 0o077) === 0) && (permissions & 0o400) !== 0;
  }
  return file.uid === 0
    && runtimeGroups.includes(file.gid)
    && (permissions & 0o037) === 0
    && (permissions & 0o040) !== 0;
}

async function assertNoSymlinkParents(path: string, errorCode: string): Promise<void> {
  let current = dirname(resolve(path));
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error(errorCode);
    } catch (error) {
      if (error instanceof Error && error.message === errorCode) throw error;
      if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(errorCode);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function readTurnkeySecretConfig(root = 'Rets', scope: SecretScope = 'mainnet'): Promise<TurnkeySecretConfig> {
  const secretRoot = resolve(root);
  await assertNoSymlinkParents(resolve(secretRoot, '.path-check'), 'TURNKEY_SECRET_PATH_INVALID');
  const defaultName = scope === 'mainnet' ? 'turnkey.env' : 'turnkey-testnet.env';
  const path = expandPath(process.env.TURNKEY_SECRET_FILE ?? resolve(secretRoot, defaultName));
  if (scope !== 'mainnet' && basename(path) === 'turnkey.env') throw new Error('TURNKEY_SCOPE_FILE_INVALID');
  if (!pathWithin(secretRoot, path)) throw new Error('TURNKEY_SECRET_PATH_INVALID');
  const values = new Map<string, string>();
  for (const raw of (await readOwnerOnlyFile(path, 'TURNKEY_SECRET_PERMISSIONS_REQUIRED')).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (values.has(key)) throw new Error('TURNKEY_SECRET_DUPLICATE');
    values.set(key, value);
  }
  const organizationId = values.get('TURNKEY_ORGANIZATION_ID');
  const apiPublicKey = values.get('TURNKEY_API_PUBLIC_KEY');
  const apiPrivateKey = values.get('TURNKEY_API_PRIVATE_KEY');
  const userId = values.get('TURNKEY_USER_ID');
  const walletMapReference = values.get('TURNKEY_WALLET_MAP_PATH');
  const walletMapPath = walletMapReference ? expandPath(walletMapReference) : undefined;
  const policyRecordReference = values.get('TURNKEY_POLICY_RECORD_PATH');
  const policyRecordPath = expandPath(policyRecordReference ?? resolve(secretRoot, 'turnkey-policy-record.json'));
  const approverKeyReference = values.get('TURNKEY_POLICY_APPROVER_PUBLIC_KEY_PATH');
  const policyApproverPublicKeyPath = expandPath(approverKeyReference ?? resolve(secretRoot, 'turnkey-policy-approver.pub'));
  const policyCatalogReference = values.get('TURNKEY_POLICY_CATALOG_PATH');
  const policyCatalogPath = policyCatalogReference ? expandPath(policyCatalogReference) : undefined;
  const policyBundleReference = values.get('TURNKEY_POLICY_BUNDLE_PATH');
  const policyBundlePath = policyBundleReference ? expandPath(policyBundleReference) : undefined;
  const walletAdminReference = values.get('TURNKEY_WALLET_ADMIN_POLICY_RECORD_PATH');
  const walletAdminPolicyRecordPath = walletAdminReference ? expandPath(walletAdminReference) : undefined;
  const reviewedReference = values.get('TURNKEY_REVIEWED_PROTOCOL_REGISTRY_PATH');
  const reviewedProtocolRegistryPath = reviewedReference ? expandPath(reviewedReference) : undefined;
  const attestationReference = values.get('TURNKEY_ATTESTATION_PATH');
  const attestationPath = attestationReference ? expandPath(attestationReference) : undefined;
  const attestationActivityId = values.get('TURNKEY_ATTESTATION_ACTIVITY_ID');
  if (!organizationId || !apiPublicKey || !apiPrivateKey || !userId || !walletMapPath) throw new Error('TURNKEY_SECRET_REQUIRED');
  if (!pathWithin(secretRoot, walletMapPath) || !pathWithin(secretRoot, policyRecordPath) || !pathWithin(secretRoot, policyApproverPublicKeyPath) || (policyCatalogPath && !pathWithin(secretRoot, policyCatalogPath)) || (policyBundlePath && !pathWithin(secretRoot, policyBundlePath)) || (walletAdminPolicyRecordPath && !pathWithin(secretRoot, walletAdminPolicyRecordPath)) || (attestationPath && !pathWithin(secretRoot, attestationPath)) || (reviewedProtocolRegistryPath && !pathWithin(secretRoot, reviewedProtocolRegistryPath))) throw new Error('TURNKEY_SECRET_PATH_INVALID');
  return {
    organizationId,
    environment: scope === 'mainnet' ? 'production' : 'testnet',
    apiPublicKey,
    apiPrivateKey,
    userId,
    walletMapPath,
    policyRecordPath,
    policyApproverPublicKeyPath,
    ...(policyCatalogPath ? { policyCatalogPath } : {}),
    ...(policyBundlePath ? { policyBundlePath } : {}),
    ...(walletAdminPolicyRecordPath ? { walletAdminPolicyRecordPath } : {}),
    ...(reviewedProtocolRegistryPath ? { reviewedProtocolRegistryPath } : {}),
    ...(values.get('TURNKEY_APP_NAME') ? { appName: values.get('TURNKEY_APP_NAME') } : {}),
    ...(attestationPath ? { attestationPath } : {}),
    ...(attestationActivityId ? { attestationActivityId } : {}),
  };
}

function normalizeData(value: Hex | undefined): string {
  return normalizeHexBytes(value ?? '0x');
}

function sameAddress(left: Address | null | undefined, right: Address): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

export function validateTurnkeyWalletMap(value: unknown): TurnkeyWalletMap {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_WALLET_MAP_INVALID');
  const candidate = value as Partial<TurnkeyWalletMap>;
  if (
    candidate.version !== 2
    || !Array.isArray(candidate.wallets)
    || candidate.wallets.length === 0
    || !/^sha256:[0-9a-f]{64}$/.test(candidate.policyRecordDigest ?? '')
    || JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(['policyRecordDigest', 'version', 'wallets'])
  ) {
    throw new Error('TURNKEY_WALLET_MAP_INVALID');
  }
  const wallets = candidate.wallets.map((wallet, position) => {
    if (!wallet || typeof wallet !== 'object') throw new Error('TURNKEY_WALLET_MAP_INVALID');
    const item = wallet as Partial<TurnkeyWalletReference>;
    if (
      item.index !== position
      || !Number.isSafeInteger(item.index)
      || typeof item.address !== 'string'
      || !/^0x[0-9a-fA-F]{40}$/.test(item.address)
      || typeof item.signWith !== 'string'
      || item.signWith.length === 0
    ) throw new Error('TURNKEY_WALLET_MAP_INVALID');
    return { index: position, address: item.address as Address, signWith: item.signWith };
  });
  const addresses = new Set<string>();
  const signWith = new Set<string>();
  for (const wallet of wallets) {
    const address = wallet.address.toLowerCase();
    if (addresses.has(address) || signWith.has(wallet.signWith)) throw new Error('TURNKEY_WALLET_MAP_DUPLICATE');
    addresses.add(address);
    signWith.add(wallet.signWith);
  }
  return {
    version: 2,
    policyRecordDigest: candidate.policyRecordDigest as `sha256:${string}`,
    wallets,
  };
}

export async function readTurnkeyWalletMap(path: string): Promise<TurnkeyWalletMap> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readOwnerOnlyFile(path, 'TURNKEY_WALLET_MAP_PERMISSIONS_REQUIRED')) as unknown;
  } catch {
    throw new Error('TURNKEY_WALLET_MAP_INVALID');
  }
  return validateTurnkeyWalletMap(parsed);
}

function signedRehearsalCalldata(): Hex {
  return encodeFunctionData({ abi: SIGNED_MINT_ABI, functionName: 'mintSigned', args: [zeroAddress, zeroAddress, zeroAddress, 1n, { mintPrice: 0n, maxTotalMintableByWallet: 1n, startTime: 1n, endTime: 7_258_118_400n, dropStageIndex: 1n, maxTokenSupplyForStage: 1n, feeBps: 0n, restrictFeeRecipients: true }, 0n, `0x${'0'.repeat(130)}`] });
}

export class TurnkeySigner implements Signer {
  private client: TurnkeySignerClient | undefined;
  private readonly organizationId: string;
  private readonly policyId: string;
  private readonly policyDigest: Hex;
  private readonly policy: TurnkeyPolicyAst;
  private readonly policyRecord: TurnkeyCanonicalPolicyRecord;
  private readonly approvedPolicyRecords?: readonly TurnkeyCanonicalPolicyRecord[];
  private readonly walletAdminPolicyRecords: readonly VerifiedTurnkeyWalletAdminPolicyRecord[];
  private readonly policyRecordDigest: `sha256:${string}`;
  private readonly policyNotBefore: number;
  private readonly policyExpiresAt: number;
  private readonly wallets: TurnkeyWalletReference[];
  private readonly generateAppProofs: boolean;
  private readonly verifyAllowlistAuthority?: (intent: TransactionIntent) => Promise<void>;
  private readonly verifyPublicAuthority?: (intent: TransactionIntent) => Promise<void>;
  private readonly verifySignedAuthority?: (intent: TransactionIntent) => Promise<void>;
  private readonly verifyReviewedAuthority?: (intent: TransactionIntent) => Promise<VerifiedErc721Authority>;
  private readonly verifyReviewedRehearsalAuthority?: (intent: TransactionIntent) => Promise<VerifiedErc721RehearsalAuthority>;

  public constructor(options: TurnkeySignerOptions) {
    if (!options.organizationId) throw new Error('TURNKEY_ORGANIZATION_REQUIRED');
    if (!options.userId || (options.environment !== 'production' && options.environment !== 'testnet')) throw new Error('TURNKEY_PROVIDER_BINDING_REQUIRED');
    if (options.wallets.length === 0) throw new Error('TURNKEY_WALLET_MAP_EMPTY');
    const record = validateTurnkeyCanonicalPolicyRecord(options.policyRecord);
    const policy = record.enforcementPolicy;
    const providerBinding: TurnkeyProviderBinding = {
      provider: 'turnkey',
      environment: options.environment,
      organizationId: options.organizationId,
      userId: options.userId,
      policyId: policy.scope.policyId,
      policyDigest: canonicalPolicyDigest(policy),
    };
    if (record.environment !== options.environment || record.providerIdentity.organizationId !== options.organizationId || record.providerIdentity.userId !== options.userId) throw new Error('TURNKEY_PROVIDER_BINDING_REQUIRED');
    validatePolicyBinding(policy, providerBinding, options.wallets);
    if (JSON.stringify(record.wallets.map(({ index, address, signWith }) => ({ index, address, signWith }))) !== JSON.stringify(options.wallets.map(({ index, address, signWith }) => ({ index, address: address.toLowerCase(), signWith })))) throw new Error('TURNKEY_POLICY_RECORD_WALLET_MAP_MISMATCH');
    this.organizationId = options.organizationId;
    this.policyId = policy.scope.policyId;
    this.policyDigest = canonicalPolicyDigest(policy);
    this.policy = policy;
    this.policyRecord = record;
    this.approvedPolicyRecords = options.approvedPolicyRecords?.map(validateTurnkeyCanonicalPolicyRecord);
    this.walletAdminPolicyRecords = [...(options.walletAdminPolicyRecords ?? [])];
    for (const admin of this.walletAdminPolicyRecords) {
      assertTurnkeyWalletAdminRecordCurrent(admin);
      if (admin.organizationId !== options.organizationId || admin.mintRuntimeUserId !== options.userId || admin.environment !== options.environment) throw new Error('TURNKEY_WALLET_ADMIN_BINDING_INVALID');
    }
    this.policyRecordDigest = turnkeyPolicyRecordDigest(record);
    this.policyNotBefore = Date.parse(record.issuedAt);
    this.policyExpiresAt = Date.parse(record.expiresAt);
    this.wallets = options.wallets.map((wallet) => ({ ...wallet }));
    this.client = options.client;
    this.generateAppProofs = options.generateAppProofs ?? true;
    this.verifyAllowlistAuthority = options.verifyAllowlistAuthority;
    this.verifyPublicAuthority = options.verifyPublicAuthority;
    this.verifySignedAuthority = options.verifySignedAuthority;
    this.verifyReviewedAuthority = options.verifyReviewedAuthority;
    this.verifyReviewedRehearsalAuthority = options.verifyReviewedRehearsalAuthority;
  }

  public static async fromSecrets(scope: SecretScope = 'mainnet', root = 'Rets', policyReference?: string, recordDigest?: string): Promise<TurnkeySigner> {
    if (policyReference && !recordDigest) throw new Error('TURNKEY_POLICY_RECORD_DIGEST_REQUIRED');
    const config = await readTurnkeySecretConfig(root, scope);
    const { organizationId, apiPublicKey, apiPrivateKey, userId, environment, walletMapPath: mapPath, policyRecordPath, policyApproverPublicKeyPath, policyCatalogPath, policyBundlePath } = config;
    let map = policyBundlePath ? undefined : await readTurnkeyWalletMap(mapPath);
    let signedRecord: unknown;
    let bundledCatalog: unknown;
    if (policyBundlePath) {
      let raw: unknown;
      try { raw = JSON.parse(await readOwnerOnlyFile(policyBundlePath, 'TURNKEY_POLICY_BUNDLE_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_BUNDLE_INVALID'); }
      const approverPublicKey = await readOwnerOnlyFile(policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
      const bundle = validateTurnkeyPolicyBundle(raw, approverPublicKey);
      signedRecord = bundle.activeRecord;
      bundledCatalog = bundle.catalog;
      map = validateTurnkeyWalletMap(bundle.walletMap);
    } else {
      try { signedRecord = JSON.parse(await readOwnerOnlyFile(policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_RECORD_INVALID'); }
    }
    const approverPublicKey = await readOwnerOnlyFile(policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
    const activeRecord = verifyTurnkeySignedPolicyRecord(signedRecord, approverPublicKey);
    const walletAdminPolicyRecords = await readTurnkeyWalletAdminPolicyRecords(config, { pinnedPublicKey: approverPublicKey });
    let record = activeRecord;
    let approvedPolicyRecords: readonly TurnkeyCanonicalPolicyRecord[] | undefined;
    if (bundledCatalog || policyCatalogPath) {
      let catalog: unknown;
      if (bundledCatalog) catalog = bundledCatalog;
      else try { catalog = JSON.parse(await readOwnerOnlyFile(policyCatalogPath!, 'TURNKEY_POLICY_CATALOG_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_CATALOG_INVALID'); }
      approvedPolicyRecords = verifyTurnkeySignedPolicyCatalog(catalog, approverPublicKey);
      if (!approvedPolicyRecords.some((candidate) => turnkeyPolicyRecordDigest(candidate) === turnkeyPolicyRecordDigest(activeRecord))) throw new Error('TURNKEY_PROVIDER_POLICY_CATALOG_ACTIVE_RECORD_MISSING');
      if (policyReference) record = selectTurnkeyPolicyRecord(approvedPolicyRecords, policyReference, recordDigest);
    } else if ((policyReference && turnkeyPolicySelection(activeRecord).policyReference !== policyReference) || (recordDigest !== undefined && turnkeyPolicyRecordDigest(activeRecord) !== recordDigest)) {
      throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
    }
    if (recordDigest !== undefined && turnkeyPolicyRecordDigest(record) !== recordDigest) throw new Error('TURNKEY_POLICY_SELECTION_NOT_FOUND');
    if (!map) throw new Error('TURNKEY_WALLET_MAP_INVALID');
    const mapRecordAllowed = approvedPolicyRecords
      ? approvedPolicyRecords.some((candidate) => turnkeyPolicyRecordDigest(candidate) === map.policyRecordDigest)
      : turnkeyPolicyRecordDigest(record) === map.policyRecordDigest;
    if (!mapRecordAllowed) throw new Error('TURNKEY_POLICY_RECORD_DIGEST_MISMATCH');
    return new TurnkeySigner({
      organizationId,
      environment,
      userId,
      wallets: map.wallets,
      policyRecord: record,
      ...(approvedPolicyRecords ? { approvedPolicyRecords } : {}),
      walletAdminPolicyRecords,
      client: createTurnkeyClient(organizationId, apiPublicKey, apiPrivateKey),
      verifyAllowlistAuthority: (intent) => verifyTurnkeyAllowlistAuthority(intent, scope, root),
      verifyPublicAuthority: (intent) => verifyTurnkeyPublicAuthority(intent, scope, root),
      verifySignedAuthority: (intent) => verifyTurnkeySignedAuthority(intent, scope, root),
      verifyReviewedRehearsalAuthority: async intent => {
        const currentConfig=await readTurnkeySecretConfig(root,scope),registry=await readTurnkeyReviewedRegistry(currentConfig,new Date(),intent.chainId),family=record.enforcementPolicy.family;
        const descriptorDigest=intent.familyContext?.reviewedErc721RehearsalDescriptorDigest;
        if(family?.kind!=='erc721-reviewed-public-v1'||registry.digest!==family.registryDigest||!descriptorDigest||!family.descriptorDigests.includes(descriptorDigest))throw new Error('ERC721_REHEARSAL_BINDING_INVALID');
        const endpoints=independentPublicRpcEndpoints((await resolveChainConfigFromSecrets(intent.chainId,scope,root)).rpcEndpoints);
        const clients=endpoints.map(endpoint=>createPublicClient({transport:http(endpoint,{timeout:10000,retryCount:0})})) as [PublicClient,PublicClient];
        return verifyErc721RehearsalAuthority({registry,descriptorDigest,clients,contract:intent.to,wallet:intent.from});
      },
      verifyReviewedAuthority: async (intent) => {
        const currentConfig = await readTurnkeySecretConfig(root,scope);
        const registry = await readTurnkeyReviewedRegistry(currentConfig,new Date(),intent.chainId);
        const family = record.enforcementPolicy.family;
        if(family?.kind !== 'erc721-reviewed-public-v1' || registry.digest !== family.registryDigest || registry.chainId !== intent.chainId)throw new Error('ERC721_REGISTRY_BINDING_INVALID');
        const digest = intent.familyContext?.reviewedErc721Authority?.descriptorDigest;
        if(!digest || !family.descriptorDigests.includes(digest))throw new Error('ERC721_DESCRIPTOR_NOT_APPROVED');
        const endpoints=independentPublicRpcEndpoints((await resolveChainConfigFromSecrets(intent.chainId,scope,root)).rpcEndpoints);
        const clients=endpoints.map(endpoint=>createPublicClient({transport:http(endpoint,{timeout:10000,retryCount:0})})) as [PublicClient,PublicClient];
        return verifyErc721WalletAuthority({registry,descriptorDigest:digest,clients,contract:intent.to,wallet:intent.from,quantity:intent.familyContext!.reviewedErc721Authority!.quantity});
      },
    });
  }

  public async listWallets(): Promise<WalletInfo[]> {
    if (!this.client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    return this.wallets.map(({ index, address }) => ({ index, address }));
  }

  /** Public policy reference already authenticated by the signed local record. */
  public policyReference(): string {
    if (!this.client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    return turnkeyPolicyRef(this.policyId, this.policyDigest);
  }

  public async signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex> {
    return (await this.signTransactionWithEvidence(walletIndex, intent)).signedTransaction;
  }

  public async signTransactionWithEvidence(walletIndex: number, intent: TransactionIntent): Promise<{ signedTransaction: Hex; evidence: TurnkeySigningEvidence }> {
    return this.signWithEvidence(walletIndex, intent, false);
  }

  /** Zero-gas, impossible-to-broadcast policy-only rehearsal; it never returns signed bytes. */
  public async rehearseFreeAllowlist(walletIndex: number, assertStopped: () => Promise<void>): Promise<{ signedTransactionHash: Hex; evidence: TurnkeySigningEvidence }> {
    if (this.policy.family?.kind !== 'seadrop-free-allowlist-v1') throw new Error('TURNKEY_ALLOWLIST_REHEARSAL_POLICY_REQUIRED');
    const wallet = this.wallets.find((item) => item.index === walletIndex);
    if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
    await assertStopped();
    const params = { mintPrice: 0n, maxTotalMintableByWallet: 1n, startTime: 1n, endTime: 7_258_118_400n, dropStageIndex: 1n, maxTokenSupplyForStage: 1n, feeBps: 0n, restrictFeeRecipients: false };
    const proof: VerifiedWalletProof = { wallet: wallet.address, mintParams: params, proof: [], source: { chainId: this.policy.transaction.chainId, nftContract: zeroAddress, stageIndex: '1', sourceId: 'rehearsal', contentDigest: `sha256:${'0'.repeat(64)}` }, authority: { chainId: this.policy.transaction.chainId, nftContract: zeroAddress, seaDrop: this.policy.transaction.to, root: allowlistLeaf(wallet.address, params), blockNumber: 0n, blockHash: `0x${'0'.repeat(64)}` as Hex, observedAt: new Date().toISOString(), feeRecipient: zeroAddress } };
    const data = buildAllowlistMint(proof, wallet.address, 1).data;
    const result = await this.signWithEvidence(walletIndex, { chainId: this.policy.transaction.chainId, nonce: Number.MAX_SAFE_INTEGER, from: wallet.address, to: this.policy.transaction.to, value: 0n, data, gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], campaignId: 'rehearsal', runId: 'rehearsal', policyRef: this.policyReference(), familyContext: { nftContract: zeroAddress, feeRecipient: zeroAddress, allowlistProof: proof, assertReady: assertStopped } }, true);
    return { signedTransactionHash: keccak256(result.signedTransaction), evidence: result.evidence };
  }

  /** Policy-only public rehearsal: zero gas, maximum nonce, no real collection or returned signed bytes. */
  public async rehearseFreePublic(walletIndex: number, assertStopped: () => Promise<void>): Promise<{ signedTransactionHash: Hex; evidence: TurnkeySigningEvidence }> {
    if (this.policy.family?.kind !== 'seadrop-free-public-v1') throw new Error('TURNKEY_PUBLIC_REHEARSAL_POLICY_REQUIRED');
    const wallet = this.wallets.find((item) => item.index === walletIndex);
    if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
    await assertStopped();
    const data = encodeFunctionData({ abi: parseAbi(['function mintPublic(address,address,address,uint256)']), functionName: 'mintPublic', args: [zeroAddress, zeroAddress, zeroAddress, 1n] });
    const result = await this.signWithEvidence(walletIndex, { chainId: this.policy.transaction.chainId, nonce: Number.MAX_SAFE_INTEGER, from: wallet.address, to: this.policy.transaction.to, value: 0n, data, gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], campaignId: 'rehearsal', runId: 'rehearsal', policyRef: this.policyReference(), familyContext: { nftContract: zeroAddress, feeRecipient: zeroAddress, assertReady: assertStopped } }, true);
    return { signedTransactionHash: keccak256(result.signedTransaction), evidence: result.evidence };
  }

  /** Inert signed-family rehearsal, with no real collection, valid authorization, gas or returned bytes. */
  public async rehearseFreeSigned(walletIndex: number, assertStopped: () => Promise<void>): Promise<{ signedTransactionHash: Hex; evidence: TurnkeySigningEvidence }> {
    if (this.policy.family?.kind !== 'seadrop-free-signed-v1') throw new Error('TURNKEY_SIGNED_REHEARSAL_POLICY_REQUIRED');
    const wallet = this.wallets.find((item) => item.index === walletIndex);
    if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
    await assertStopped();
    const result = await this.signWithEvidence(walletIndex, { chainId: this.policy.transaction.chainId, nonce: Number.MAX_SAFE_INTEGER, from: wallet.address, to: this.policy.transaction.to, value: 0n, data: signedRehearsalCalldata(), gasLimit: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, accessList: [], campaignId: 'rehearsal', runId: 'rehearsal', policyRef: this.policyReference(), familyContext: { nftContract: zeroAddress, feeRecipient: zeroAddress, assertReady: assertStopped } }, true);
    return { signedTransactionHash: keccak256(result.signedTransaction), evidence: result.evidence };
  }

  /** Distinct code-provenance rehearsal: closed stages are allowed, live eligibility is never waived. */
  public async rehearseReviewedErc721(walletIndex:number,input:{contract:Address;descriptorDigest:string;assertStopped:()=>Promise<void>}):Promise<{signedTransactionHash:Hex;evidence:TurnkeySigningEvidence;authority:{registryDigest:string;descriptorDigest:string;chainId:number;contract:Address;blockNumber:string;blockHash:Hex}}> {
    const family=this.policy.family;if(family?.kind!=='erc721-reviewed-public-v1'||!family.descriptorDigests.includes(input.descriptorDigest)||!this.verifyReviewedRehearsalAuthority)throw new Error('ERC721_REHEARSAL_POLICY_REQUIRED');
    const wallet=this.wallets.find(value=>value.index===walletIndex);if(!wallet)throw new Error('TURNKEY_WALLET_NOT_FOUND');await input.assertStopped();
    let intent:TransactionIntent={chainId:this.policy.transaction.chainId,from:wallet.address,to:input.contract,value:0n,data:('0xa0712d68'+'0'.repeat(63)+'1') as Hex,nonce:Number.MAX_SAFE_INTEGER,gasLimit:0n,maxFeePerGas:0n,maxPriorityFeePerGas:0n,accessList:[],policyRef:this.policyReference(),campaignId:'reviewed-rehearsal',runId:'reviewed-rehearsal',familyContext:{nftContract:input.contract,feeRecipient:zeroAddress,reviewedErc721RehearsalDescriptorDigest:input.descriptorDigest,assertReady:input.assertStopped}};
    const authority=await this.verifyReviewedRehearsalAuthority(intent);intent={...intent,familyContext:{...intent.familyContext!,reviewedErc721RehearsalAuthority:authority}};
    const result=await this.signWithEvidence(walletIndex,intent,true);
    const finalAuthority=result.reviewedRehearsalAuthority;if(!finalAuthority)throw new Error('ERC721_INERT_REHEARSAL_REQUIRED');
    await input.assertStopped();await this.probe();await input.assertStopped();this.assertPolicyCurrent();
    assertErc721RehearsalIntent({...intent,familyContext:{...intent.familyContext!,reviewedErc721RehearsalAuthority:finalAuthority}},family.registryDigest,family.descriptorDigests);
    return {signedTransactionHash:keccak256(result.signedTransaction),evidence:result.evidence,authority:{registryDigest:finalAuthority.registryDigest,descriptorDigest:finalAuthority.descriptorDigest,chainId:finalAuthority.chainId,contract:finalAuthority.contract,blockNumber:finalAuthority.blockNumber.toString(),blockHash:finalAuthority.blockHash}};
  }

  private async signWithEvidence(walletIndex: number, intent: TransactionIntent, rehearsal: boolean): Promise<{ signedTransaction: Hex; evidence: TurnkeySigningEvidence; reviewedRehearsalAuthority?: VerifiedErc721RehearsalAuthority }> {
    this.assertPolicyCurrent();
    // Optional admin authority is never a cached blanket exemption from strict live inventory.
    if (this.walletAdminPolicyRecords.length) await this.probe();
    this.assertPolicyCurrent();
    const client = this.client;
    const wallet = this.wallets.find((candidate) => candidate.index === walletIndex);
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
    if (!sameAddress(intent.from, wallet.address)) throw new Error('TURNKEY_SIGNER_WALLET_MISMATCH');
    const expectedPolicyRef = turnkeyPolicyRef(this.policyId, this.policyDigest);
    if (intent.policyRef !== expectedPolicyRef) throw new Error('TURNKEY_POLICY_REFERENCE_MISMATCH');
    const validateIntent = () => {
      if(rehearsal && this.policy.family?.kind==='erc721-reviewed-public-v1'){
        assertErc721RehearsalIntent(intent,this.policy.family.registryDigest,this.policy.family.descriptorDigests);
        const {family:_family,...exact}=this.policy;
        validateTransactionIntent(intent,{...exact,transaction:{...exact.transaction,to:intent.to,data:intent.data}},expectedPolicyRef);
      } else if (rehearsal && this.policy.family?.kind === 'seadrop-free-signed-v1') {
        const { family: _family, ...exact } = this.policy;
        validateTransactionIntent(intent, { ...exact, transaction: { ...exact.transaction, data: signedRehearsalCalldata() } }, expectedPolicyRef);
      } else validateTransactionIntent(intent, this.policy, expectedPolicyRef);
    };
    validateIntent();
    if (this.policy.family?.kind === 'seadrop-free-public-v1') {
      if (!intent.campaignId || !intent.runId || !intent.familyContext?.assertReady) throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
      if (rehearsal) {
        if (intent.gasLimit !== 0n || intent.value !== 0n || intent.maxFeePerGas !== 0n || intent.maxPriorityFeePerGas !== 0n || intent.nonce !== Number.MAX_SAFE_INTEGER || intent.familyContext.nftContract !== zeroAddress || intent.familyContext.feeRecipient !== zeroAddress) throw new Error('TURNKEY_PUBLIC_REHEARSAL_UNSAFE');
      } else {
        if (intent.gasLimit <= 0n || intent.maxFeePerGas <= 0n || intent.familyContext.nftContract === zeroAddress || !this.verifyPublicAuthority) throw new Error('TURNKEY_PUBLIC_AUTHORITY_REQUIRED');
        await this.verifyPublicAuthority(intent);
      }
      await intent.familyContext.assertReady();
      this.assertPolicyCurrent();
      validateTransactionIntent(intent, this.policy, expectedPolicyRef);
    }
    if (this.policy.family?.kind === 'seadrop-free-allowlist-v1') {
      if (!intent.familyContext?.assertReady) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
      if (rehearsal) {
        if (intent.gasLimit !== 0n || intent.value !== 0n || intent.maxFeePerGas !== 0n || intent.maxPriorityFeePerGas !== 0n || intent.nonce !== Number.MAX_SAFE_INTEGER || intent.familyContext.nftContract !== zeroAddress || intent.familyContext.feeRecipient !== zeroAddress) throw new Error('TURNKEY_ALLOWLIST_REHEARSAL_UNSAFE');
      } else {
        if (!this.verifyAllowlistAuthority) throw new Error('TURNKEY_ALLOWLIST_AUTHORITY_REQUIRED');
        await this.verifyAllowlistAuthority(intent);
      }
      await intent.familyContext.assertReady();
      this.assertPolicyCurrent();
      validateTransactionIntent(intent, this.policy, expectedPolicyRef);
    }

    if (this.policy.family?.kind === 'seadrop-free-signed-v1') {
      if (!intent.campaignId || !intent.runId || !intent.familyContext?.assertReady) throw new Error('TURNKEY_SIGNED_AUTHORITY_REQUIRED');
      if (rehearsal) {
        if (intent.gasLimit !== 0n || intent.value !== 0n || intent.maxFeePerGas !== 0n || intent.maxPriorityFeePerGas !== 0n || intent.nonce !== Number.MAX_SAFE_INTEGER || intent.familyContext.nftContract !== zeroAddress || intent.familyContext.feeRecipient !== zeroAddress) throw new Error('TURNKEY_SIGNED_REHEARSAL_UNSAFE');
      } else {
        if (intent.gasLimit <= 0n || intent.maxFeePerGas <= 0n || !intent.familyContext.signedAuthorization || !this.verifySignedAuthority) throw new Error('TURNKEY_SIGNED_AUTHORITY_REQUIRED');
        await this.verifySignedAuthority(intent);
      }
      await intent.familyContext.assertReady();
      this.assertPolicyCurrent();
      validateIntent();
    }

    if (this.policy.family?.kind === 'erc721-reviewed-public-v1') {
      if(rehearsal){
        if(!intent.familyContext?.assertReady||!this.verifyReviewedRehearsalAuthority)throw new Error('ERC721_INERT_REHEARSAL_REQUIRED');
        const fresh=await this.verifyReviewedRehearsalAuthority(intent);intent={...intent,familyContext:{...intent.familyContext,reviewedErc721RehearsalAuthority:fresh}};
        await this.probe();await intent.familyContext!.assertReady!();this.assertPolicyCurrent();
        if(this.client!==client)throw new Error('TURNKEY_SIGNER_ZEROIZED');validateIntent();
      }else{
        if(!intent.familyContext?.assertReady || !this.verifyReviewedAuthority || intent.gasLimit<=0n || intent.maxFeePerGas<=0n)throw new Error('ERC721_VERIFIED_AUTHORITY_REQUIRED');
        const fresh=await this.verifyReviewedAuthority(intent);intent={...intent,familyContext:{...intent.familyContext,reviewedErc721Authority:fresh}};
        await intent.familyContext!.assertReady!();this.assertPolicyCurrent();
        assertErc721IntentAuthority(intent,this.policy.family.registryDigest,this.policy.family.descriptorDigests);validateTransactionIntent(intent,this.policy,expectedPolicyRef);
      }
    }
    const unsignedTransaction = serializeTransaction({
      type: 'eip1559',
      chainId: intent.chainId,
      nonce: intent.nonce,
      to: intent.to,
      value: intent.value,
      data: intent.data,
      gas: intent.gasLimit,
      maxFeePerGas: intent.maxFeePerGas,
      maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
      accessList: intent.accessList,
    });

    let response: { signedTransaction: string; activity: TurnkeySigningActivity };
    try {
      response = await client.signTransaction({
        signWith: wallet.signWith,
        unsignedTransaction,
        type: 'TRANSACTION_TYPE_ETHEREUM',
        generateAppProofs: this.generateAppProofs,
      });
    } catch {
      throw new Error('TURNKEY_SIGN_TRANSACTION_FAILED');
    }
    const signedTransaction = typeof response.signedTransaction === 'string' && response.signedTransaction.startsWith('0x')
      ? response.signedTransaction
      : typeof response.signedTransaction === 'string' ? `0x${response.signedTransaction}` : undefined;
    if (!signedTransaction || !/^0x[0-9a-f]+$/i.test(signedTransaction)) {
      throw new Error('TURNKEY_SIGNED_TRANSACTION_INVALID');
    }
    const activityIntent = response.activity?.intent?.signTransactionIntentV2;
    const activitySigned = response.activity?.result?.signTransactionResult?.signedTransaction;
    const normalizedActivitySigned = typeof activitySigned === 'string' && activitySigned.startsWith('0x') ? activitySigned : typeof activitySigned === 'string' ? `0x${activitySigned}` : undefined;
    if (
      response.activity?.organizationId !== this.organizationId
      || response.activity?.status !== 'ACTIVITY_STATUS_COMPLETED'
      || response.activity?.type !== 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'
      || !response.activity.id
      || !response.activity.fingerprint
      || activityIntent?.signWith !== wallet.signWith
      || activityIntent?.unsignedTransaction !== unsignedTransaction
      || activityIntent?.type !== 'TRANSACTION_TYPE_ETHEREUM'
      || normalizedActivitySigned?.toLowerCase() !== signedTransaction.toLowerCase()
      || (response.activity.appProofs !== undefined && !Array.isArray(response.activity.appProofs))
    ) throw new Error('TURNKEY_SIGNING_ACTIVITY_INVALID');

    let signed;
    try {
      signed = parseTransaction(signedTransaction as Hex);
    } catch {
      throw new Error('TURNKEY_SIGNED_TRANSACTION_INVALID');
    }
    let recoveredAddress: Address;
    try {
      recoveredAddress = await recoverTransactionAddress({ serializedTransaction: signedTransaction as TransactionSerialized });
    } catch {
      throw new Error('TURNKEY_SIGNED_TRANSACTION_INVALID');
    }
    let accessListMatches = false;
    try {
      accessListMatches = normalizeAccessList(signed.accessList) === normalizeAccessList(intent.accessList);
    } catch {
      accessListMatches = false;
    }
    let transactionFieldsMatch = false;
    try {
      transactionFieldsMatch = signed.type === 'eip1559'
        && signed.chainId === intent.chainId
        && signed.nonce === intent.nonce
        && sameAddress(signed.to, intent.to)
        && (signed.value ?? 0n) === intent.value
        && normalizeData(signed.data) === normalizeData(intent.data)
        && (signed.gas ?? 0n) === intent.gasLimit
        && (signed.maxFeePerGas ?? 0n) === intent.maxFeePerGas
        && (signed.maxPriorityFeePerGas ?? 0n) === intent.maxPriorityFeePerGas;
    } catch {
      transactionFieldsMatch = false;
    }
    if (
      !transactionFieldsMatch
      || !accessListMatches
      || !sameAddress(recoveredAddress, wallet.address)
    ) throw new Error('TURNKEY_SIGNED_TRANSACTION_BOUNDARY_INVALID');

    return {
      ...(rehearsal && intent.familyContext?.reviewedErc721RehearsalAuthority ? {reviewedRehearsalAuthority:intent.familyContext.reviewedErc721RehearsalAuthority} : {}),
      signedTransaction: signedTransaction as Hex,
      evidence: {
        activityId: response.activity.id,
        activityFingerprint: response.activity.fingerprint,
        appProofCount: response.activity.appProofs?.length ?? 0,
      },
    };
  }

  public async probe(): Promise<TurnkeyHealthReport> {
    this.assertPolicyCurrent();
    const client = this.client;
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    const [whoami, organization, policies, keyResponse] = await Promise.all([
      client.getWhoami({ organizationId: this.organizationId }),
      client.getOrganizationConfigs({ organizationId: this.organizationId }),
      client.getPolicies({ organizationId: this.organizationId }),
      client.getPrivateKeys({ organizationId: this.organizationId }),
    ]);
    validateTurnkeyActualProviderState(this.policyRecord, { whoami, organization, policies: policies.policies, privateKeys: keyResponse.privateKeys }, this.approvedPolicyRecords, this.walletAdminPolicyRecords);
    return {
      status: 'ok',
      provider: 'turnkey',
      organizationId: this.organizationId,
      walletCount: this.wallets.length,
      policyId: this.policyId,
      policyDigest: this.policyDigest,
      policyRecordDigest: this.policyRecordDigest,
    };
  }

  public zeroize(): void {
    this.client = undefined;
    this.wallets.splice(0, this.wallets.length);
  }

  private assertPolicyCurrent(now = Date.now()): void {
    if (!Number.isFinite(now) || now < this.policyNotBefore || now >= this.policyExpiresAt) throw new Error('TURNKEY_POLICY_RECORD_NOT_CURRENT');
    for (const admin of this.walletAdminPolicyRecords) assertTurnkeyWalletAdminRecordCurrent(admin, new Date(now));
  }
}
