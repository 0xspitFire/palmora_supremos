import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
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
  appName?: string;
  attestationPath?: string;
  attestationActivityId?: string;
}

export interface TurnkeySignerClient {
  signTransaction(input: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_ETHEREUM';
    generateAppProofs?: boolean;
  }): Promise<{ signedTransaction: string; activity: TurnkeySigningActivity }>;
  getWhoami(input?: { organizationId?: string }): Promise<unknown>;
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
  client: TurnkeySignerClient;
  generateAppProofs?: boolean;
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
  if (file.uid === runtimeUid) return (permissions & 0o077) === 0 && (permissions & 0o400) !== 0;
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
  const attestationReference = values.get('TURNKEY_ATTESTATION_PATH');
  const attestationPath = attestationReference ? expandPath(attestationReference) : undefined;
  const attestationActivityId = values.get('TURNKEY_ATTESTATION_ACTIVITY_ID');
  if (!organizationId || !apiPublicKey || !apiPrivateKey || !userId || !walletMapPath) throw new Error('TURNKEY_SECRET_REQUIRED');
  if (!pathWithin(secretRoot, walletMapPath) || !pathWithin(secretRoot, policyRecordPath) || !pathWithin(secretRoot, policyApproverPublicKeyPath) || (attestationPath && !pathWithin(secretRoot, attestationPath))) throw new Error('TURNKEY_SECRET_PATH_INVALID');
  return {
    organizationId,
    environment: scope === 'mainnet' ? 'production' : 'testnet',
    apiPublicKey,
    apiPrivateKey,
    userId,
    walletMapPath,
    policyRecordPath,
    policyApproverPublicKeyPath,
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

export class TurnkeySigner implements Signer {
  private client: TurnkeySignerClient | undefined;
  private readonly organizationId: string;
  private readonly policyId: string;
  private readonly policyDigest: Hex;
  private readonly policy: TurnkeyPolicyAst;
  private readonly policyRecord: TurnkeyCanonicalPolicyRecord;
  private readonly policyRecordDigest: `sha256:${string}`;
  private readonly policyNotBefore: number;
  private readonly policyExpiresAt: number;
  private readonly wallets: TurnkeyWalletReference[];
  private readonly generateAppProofs: boolean;

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
    this.policyRecordDigest = turnkeyPolicyRecordDigest(record);
    this.policyNotBefore = Date.parse(record.issuedAt);
    this.policyExpiresAt = Date.parse(record.expiresAt);
    this.wallets = options.wallets.map((wallet) => ({ ...wallet }));
    this.client = options.client;
    this.generateAppProofs = options.generateAppProofs ?? true;
  }

  public static async fromSecrets(scope: SecretScope = 'mainnet', root = 'Rets'): Promise<TurnkeySigner> {
    const { organizationId, apiPublicKey, apiPrivateKey, userId, environment, walletMapPath: mapPath, policyRecordPath, policyApproverPublicKeyPath } = await readTurnkeySecretConfig(root, scope);
    const map = await readTurnkeyWalletMap(mapPath);
    let signedRecord: unknown;
    try { signedRecord = JSON.parse(await readOwnerOnlyFile(policyRecordPath, 'TURNKEY_POLICY_RECORD_PERMISSIONS_REQUIRED')) as unknown; } catch { throw new Error('TURNKEY_POLICY_RECORD_INVALID'); }
    const approverPublicKey = await readOwnerOnlyFile(policyApproverPublicKeyPath, 'TURNKEY_POLICY_APPROVER_KEY_PERMISSIONS_REQUIRED');
    const record = verifyTurnkeySignedPolicyRecord(signedRecord, approverPublicKey);
    if (turnkeyPolicyRecordDigest(record) !== map.policyRecordDigest) throw new Error('TURNKEY_POLICY_RECORD_DIGEST_MISMATCH');
    return new TurnkeySigner({
      organizationId,
      environment,
      userId,
      wallets: map.wallets,
      policyRecord: record,
      client: createTurnkeyClient(organizationId, apiPublicKey, apiPrivateKey),
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
    this.assertPolicyCurrent();
    const client = this.client;
    const wallet = this.wallets.find((candidate) => candidate.index === walletIndex);
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    if (!wallet) throw new Error('TURNKEY_WALLET_NOT_FOUND');
    if (!sameAddress(intent.from, wallet.address)) throw new Error('TURNKEY_SIGNER_WALLET_MISMATCH');
    const expectedPolicyRef = turnkeyPolicyRef(this.policyId, this.policyDigest);
    if (intent.policyRef !== expectedPolicyRef) throw new Error('TURNKEY_POLICY_REFERENCE_MISMATCH');
    validateTransactionIntent(intent, this.policy, expectedPolicyRef);

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
    const [whoami, policies, keyResponse] = await Promise.all([
      client.getWhoami({ organizationId: this.organizationId }),
      client.getPolicies({ organizationId: this.organizationId }),
      client.getPrivateKeys({ organizationId: this.organizationId }),
    ]);
    validateTurnkeyActualProviderState(this.policyRecord, { whoami, policies: policies.policies, privateKeys: keyResponse.privateKeys });
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
  }
}
