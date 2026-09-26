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
  canonicalPolicyDigest,
  normalizeAccessList,
  normalizeHexBytes,
  turnkeyPolicyRef,
  validateKeyInventory,
  validatePolicyBinding,
  validateTransactionIntent,
  validateTurnkeyPolicyAst,
  type TurnkeyEnvironment,
  type TurnkeyKeyInventory,
  type TurnkeyPolicyAst,
  type TurnkeyProviderBinding,
} from './turnkey-policy.js';

export interface TurnkeyWalletReference {
  index: number;
  address: Address;
  signWith: string;
}

export interface TurnkeyWalletMap {
  version: 1;
  organizationId: string;
  userId: string;
  environment: TurnkeyEnvironment;
  policyId: string;
  policyDigest: Hex;
  policy: TurnkeyPolicyAst;
  wallets: TurnkeyWalletReference[];
}

export interface TurnkeySecretConfig {
  organizationId: string;
  environment: TurnkeyEnvironment;
  apiPublicKey: string;
  apiPrivateKey: string;
  userId: string;
  walletMapPath: string;
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
  }): Promise<{ signedTransaction: string }>;
  getWhoami(input?: { organizationId?: string }): Promise<{ organizationId: string; userId?: string; environment?: TurnkeyEnvironment }>;
  getPolicies?(input: { organizationId: string }): Promise<{ policies: Array<{ policyId: string; effect?: string; condition?: string; digest?: Hex; ast?: unknown; providerBinding?: TurnkeyProviderBinding }> }>;
  getPrivateKeys?(input: { organizationId: string }): Promise<{ organizationId?: string; userId?: string; environment?: TurnkeyEnvironment; privateKeys: Array<{ privateKeyId: string; addresses: Array<{ format?: string; address?: string }>; organizationId?: string; userId?: string; environment?: TurnkeyEnvironment }> }>;
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
  policyId: string;
  policyDigest: Hex;
  policy: TurnkeyPolicyAst;
  providerBinding?: TurnkeyProviderBinding;
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
  policy: TurnkeyPolicyAst;
  providerBinding: TurnkeyProviderBinding;
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
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(errorCode);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
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
  const attestationReference = values.get('TURNKEY_ATTESTATION_PATH');
  const attestationPath = attestationReference ? expandPath(attestationReference) : undefined;
  const attestationActivityId = values.get('TURNKEY_ATTESTATION_ACTIVITY_ID');
  if (!organizationId || !apiPublicKey || !apiPrivateKey || !userId || !walletMapPath) throw new Error('TURNKEY_SECRET_REQUIRED');
  if (!pathWithin(secretRoot, walletMapPath) || (attestationPath && !pathWithin(secretRoot, attestationPath))) throw new Error('TURNKEY_SECRET_PATH_INVALID');
  return {
    organizationId,
    environment: scope === 'mainnet' ? 'production' : 'testnet',
    apiPublicKey,
    apiPrivateKey,
    userId,
    walletMapPath,
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
    candidate.version !== 1
    || !Array.isArray(candidate.wallets)
    || candidate.wallets.length === 0
    || typeof candidate.organizationId !== 'string'
    || typeof candidate.userId !== 'string'
    || (candidate.environment !== 'production' && candidate.environment !== 'testnet')
    || typeof candidate.policyId !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(candidate.policyDigest ?? '')
    || !candidate.policy
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
  const policy = validateTurnkeyPolicyAst(candidate.policy);
  const provider: TurnkeyProviderBinding = {
    provider: 'turnkey',
    environment: candidate.environment,
    organizationId: candidate.organizationId,
    userId: candidate.userId,
    policyId: candidate.policyId,
    policyDigest: candidate.policyDigest as Hex,
  };
  validatePolicyBinding(policy, provider, wallets);
  return {
    version: 1,
    organizationId: candidate.organizationId,
    userId: candidate.userId,
    environment: candidate.environment,
    policyId: candidate.policyId,
    policyDigest: candidate.policyDigest as Hex,
    policy,
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
  private readonly environment: TurnkeyEnvironment;
  private readonly userId: string;
  private readonly policyId: string;
  private readonly policyDigest: Hex;
  private readonly policy: TurnkeyPolicyAst;
  private readonly providerBinding: TurnkeyProviderBinding;
  private readonly wallets: TurnkeyWalletReference[];
  private readonly generateAppProofs: boolean;

  public constructor(options: TurnkeySignerOptions) {
    if (!options.organizationId) throw new Error('TURNKEY_ORGANIZATION_REQUIRED');
    if (!options.userId || (options.environment !== 'production' && options.environment !== 'testnet')) throw new Error('TURNKEY_PROVIDER_BINDING_REQUIRED');
    if (options.wallets.length === 0) throw new Error('TURNKEY_WALLET_MAP_EMPTY');
    if (!options.policyId || !/^0x[0-9a-fA-F]{64}$/.test(options.policyDigest)) throw new Error('TURNKEY_POLICY_DIGEST_REQUIRED');
    const providerBinding = options.providerBinding ?? {
      provider: 'turnkey' as const,
      environment: options.environment,
      organizationId: options.organizationId,
      userId: options.userId,
      policyId: options.policyId,
      policyDigest: options.policyDigest,
    };
    if (providerBinding.provider !== 'turnkey' || providerBinding.organizationId !== options.organizationId || providerBinding.userId !== options.userId || providerBinding.environment !== options.environment || providerBinding.policyId !== options.policyId || providerBinding.policyDigest.toLowerCase() !== options.policyDigest.toLowerCase()) throw new Error('TURNKEY_PROVIDER_BINDING_REQUIRED');
    const policy = validatePolicyBinding(options.policy, providerBinding, options.wallets);
    if (canonicalPolicyDigest(policy).toLowerCase() !== options.policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_DIGEST_MISMATCH');
    this.organizationId = options.organizationId;
    this.environment = options.environment;
    this.userId = options.userId;
    this.policyId = options.policyId;
    this.policyDigest = options.policyDigest;
    this.policy = policy;
    this.providerBinding = providerBinding;
    this.wallets = options.wallets.map((wallet) => ({ ...wallet }));
    this.client = options.client;
    this.generateAppProofs = options.generateAppProofs ?? true;
  }

  public static async fromSecrets(scope: SecretScope = 'mainnet', root = 'Rets'): Promise<TurnkeySigner> {
    const { organizationId, apiPublicKey, apiPrivateKey, userId, environment, walletMapPath: mapPath } = await readTurnkeySecretConfig(root, scope);
    const map = await readTurnkeyWalletMap(mapPath);
    if (map.organizationId !== organizationId || map.userId !== userId || map.environment !== environment) throw new Error('TURNKEY_PROVIDER_BINDING_MISMATCH');
    if (!map.policyId || !map.policyDigest || !map.policy) throw new Error('TURNKEY_POLICY_REQUIRED');
    return new TurnkeySigner({
      organizationId,
      environment,
      userId,
      wallets: map.wallets,
      policyId: map.policyId,
      policyDigest: map.policyDigest,
      policy: map.policy,
      providerBinding: {
        provider: 'turnkey',
        environment,
        organizationId,
        userId,
        policyId: map.policyId,
        policyDigest: map.policyDigest,
      },
      client: createTurnkeyClient(organizationId, apiPublicKey, apiPrivateKey),
    });
  }

  public async listWallets(): Promise<WalletInfo[]> {
    if (!this.client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    return this.wallets.map(({ index, address }) => ({ index, address }));
  }

  public async signTransaction(walletIndex: number, intent: TransactionIntent): Promise<Hex> {
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

    let response: { signedTransaction: string };
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
        && signed.gas === intent.gasLimit
        && signed.maxFeePerGas === intent.maxFeePerGas
        && signed.maxPriorityFeePerGas === intent.maxPriorityFeePerGas;
    } catch {
      transactionFieldsMatch = false;
    }
    if (
      !transactionFieldsMatch
      || !accessListMatches
      || !sameAddress(recoveredAddress, wallet.address)
    ) throw new Error('TURNKEY_SIGNED_TRANSACTION_BOUNDARY_INVALID');

    return signedTransaction as Hex;
  }

  public async probe(): Promise<TurnkeyHealthReport> {
    const client = this.client;
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    if (!this.policyId || !client.getPolicies) throw new Error('TURNKEY_POLICY_CLIENT_REQUIRED');
    const whoami = await client.getWhoami({ organizationId: this.organizationId });
    if (whoami.organizationId !== this.organizationId || whoami.userId !== this.userId || whoami.environment !== this.environment) throw new Error('TURNKEY_PROVIDER_BINDING_MISMATCH');
    const policies = await client.getPolicies({ organizationId: this.organizationId });
    const policy = policies.policies.find((candidate) => candidate.policyId === this.policyId);
    if (!policy) throw new Error('TURNKEY_POLICY_NOT_FOUND');
    if (policy.effect !== 'EFFECT_ALLOW' || !policy.ast || !policy.digest || !policy.providerBinding) throw new Error('TURNKEY_POLICY_NOT_FOUND');
    if (policy.digest.toLowerCase() !== this.policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_DIGEST_MISMATCH');
    if (policy.condition && /(?:\b(?:or|any|all|wildcard|regex)\b|\|\|)/i.test(policy.condition)) throw new Error('TURNKEY_POLICY_SEMANTICS_INVALID');
    if (policy.providerBinding.provider !== this.providerBinding.provider || policy.providerBinding.environment !== this.providerBinding.environment || policy.providerBinding.organizationId !== this.providerBinding.organizationId || policy.providerBinding.userId !== this.providerBinding.userId || policy.providerBinding.policyId !== this.providerBinding.policyId || policy.providerBinding.policyDigest.toLowerCase() !== this.providerBinding.policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
    const providerPolicy = validateTurnkeyPolicyAst(policy.ast);
    if (canonicalPolicyDigest(providerPolicy).toLowerCase() !== this.policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_DIGEST_MISMATCH');
    validatePolicyBinding(providerPolicy, this.providerBinding, this.wallets);
    if (!client.getPrivateKeys) throw new Error('TURNKEY_KEY_METADATA_CLIENT_REQUIRED');
    const keyResponse = await client.getPrivateKeys({ organizationId: this.organizationId });
    if (keyResponse.organizationId !== this.organizationId || keyResponse.userId !== this.userId || keyResponse.environment !== this.environment) throw new Error('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
    const inventory: TurnkeyKeyInventory = {
      organizationId: keyResponse.organizationId,
      userId: keyResponse.userId,
      environment: keyResponse.environment,
      privateKeys: keyResponse.privateKeys.map((key) => {
        const address = key.addresses.find((candidate) => candidate.format === 'ADDRESS_FORMAT_ETHEREUM')?.address ?? key.addresses.find((candidate) => candidate.address)?.address;
        if (!address || !key.organizationId || !key.userId || !key.environment) throw new Error('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
        return { privateKeyId: key.privateKeyId, organizationId: key.organizationId, userId: key.userId, environment: key.environment, address: address as Address };
      }),
    };
    validateKeyInventory(inventory, this.providerBinding, this.wallets);
    return {
      status: 'ok',
      provider: 'turnkey',
      organizationId: this.organizationId,
      walletCount: this.wallets.length,
      policyId: this.policyId,
      policyDigest: this.policyDigest,
      policy: this.policy,
      providerBinding: this.providerBinding,
    };
  }

  public zeroize(): void {
    this.client = undefined;
    this.wallets.splice(0, this.wallets.length);
  }
}
