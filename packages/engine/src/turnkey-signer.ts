import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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

export interface TurnkeyWalletReference {
  index: number;
  address: Address;
  signWith: string;
}

export interface TurnkeyWalletMap {
  version: 1;
  organizationId?: string;
  policyId?: string;
  wallets: TurnkeyWalletReference[];
}

export interface TurnkeySecretConfig {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  userId: string;
  walletMapPath: string;
  appName?: string;
  attestationPath?: string;
}

export interface TurnkeySignerClient {
  signTransaction(input: {
    signWith: string;
    unsignedTransaction: string;
    type: 'TRANSACTION_TYPE_ETHEREUM';
    generateAppProofs?: boolean;
  }): Promise<{ signedTransaction: string }>;
  getWhoami(input?: { organizationId?: string }): Promise<{ organizationId: string }>;
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
  wallets: readonly TurnkeyWalletReference[];
  policyId?: string;
  client: TurnkeySignerClient;
  generateAppProofs?: boolean;
}

export interface TurnkeyHealthReport {
  status: 'ok';
  provider: 'turnkey';
  organizationId: string;
  walletCount: number;
  policyId?: string;
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

export async function readTurnkeySecretConfig(root = 'Rets'): Promise<TurnkeySecretConfig> {
  const path = resolve(process.env.TURNKEY_SECRET_FILE ?? resolve(root, 'turnkey.env'));
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error('TURNKEY_SECRET_PERMISSIONS_REQUIRED');
  const values = new Map<string, string>();
  for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
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
  const walletMapPath = walletMapReference?.startsWith('~/') ? resolve(homedir(), walletMapReference.slice(2)) : walletMapReference;
  const attestationReference = values.get('TURNKEY_ATTESTATION_PATH');
  const attestationPath = attestationReference?.startsWith('~/') ? resolve(homedir(), attestationReference.slice(2)) : attestationReference;
  if (!organizationId || !apiPublicKey || !apiPrivateKey || !userId || !walletMapPath) throw new Error('TURNKEY_SECRET_REQUIRED');
  return {
    organizationId,
    apiPublicKey,
    apiPrivateKey,
    userId,
    walletMapPath,
    ...(values.get('TURNKEY_APP_NAME') ? { appName: values.get('TURNKEY_APP_NAME') } : {}),
    ...(attestationPath ? { attestationPath } : {}),
  };
}

function normalizeData(value: Hex | undefined): string {
  return (value ?? '0x').toLowerCase();
}

function sameAddress(left: Address | null | undefined, right: Address): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function validateWalletMap(value: unknown): TurnkeyWalletMap {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_WALLET_MAP_INVALID');
  const candidate = value as Partial<TurnkeyWalletMap>;
  if (candidate.version !== 1 || !Array.isArray(candidate.wallets) || candidate.wallets.length === 0) {
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
  return {
    version: 1,
    ...(typeof candidate.organizationId === 'string' ? { organizationId: candidate.organizationId } : {}),
    ...(typeof candidate.policyId === 'string' ? { policyId: candidate.policyId } : {}),
    wallets,
  };
}

export async function readTurnkeyWalletMap(path: string): Promise<TurnkeyWalletMap> {
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error('TURNKEY_WALLET_MAP_PERMISSIONS_REQUIRED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error('TURNKEY_WALLET_MAP_INVALID');
  }
  return validateWalletMap(parsed);
}

export class TurnkeySigner implements Signer {
  private client: TurnkeySignerClient | undefined;
  private readonly organizationId: string;
  private readonly policyId?: string;
  private readonly wallets: TurnkeyWalletReference[];
  private readonly generateAppProofs: boolean;

  public constructor(options: TurnkeySignerOptions) {
    if (!options.organizationId) throw new Error('TURNKEY_ORGANIZATION_REQUIRED');
    if (options.wallets.length === 0) throw new Error('TURNKEY_WALLET_MAP_EMPTY');
    this.organizationId = options.organizationId;
    this.policyId = options.policyId;
    this.wallets = options.wallets.map((wallet) => ({ ...wallet }));
    this.client = options.client;
    this.generateAppProofs = options.generateAppProofs ?? true;
  }

  public static async fromSecrets(scope: SecretScope = 'mainnet', root = 'Rets'): Promise<TurnkeySigner> {
    void scope;
    const { organizationId, apiPublicKey, apiPrivateKey, walletMapPath: mapPath } = await readTurnkeySecretConfig(root);
    const map = await readTurnkeyWalletMap(mapPath);
    if (map.organizationId && map.organizationId !== organizationId) throw new Error('TURNKEY_ORGANIZATION_MISMATCH');
    if (!map.policyId) throw new Error('TURNKEY_POLICY_REQUIRED');
    return new TurnkeySigner({
      organizationId,
      wallets: map.wallets,
      ...(map.policyId ? { policyId: map.policyId } : {}),
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
    if (
      signed.type !== 'eip1559'
      || signed.chainId !== intent.chainId
      || signed.nonce !== intent.nonce
      || !sameAddress(signed.to, intent.to)
      || (signed.value ?? 0n) !== intent.value
      || normalizeData(signed.data) !== normalizeData(intent.data)
      || signed.gas !== intent.gasLimit
      || signed.maxFeePerGas !== intent.maxFeePerGas
      || signed.maxPriorityFeePerGas !== intent.maxPriorityFeePerGas
      || !sameAddress(recoveredAddress, wallet.address)
    ) throw new Error('TURNKEY_SIGNED_TRANSACTION_BOUNDARY_INVALID');

    return signedTransaction as Hex;
  }

  public async probe(): Promise<TurnkeyHealthReport> {
    const client = this.client;
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    const whoami = await client.getWhoami({ organizationId: this.organizationId });
    if (whoami.organizationId !== this.organizationId) throw new Error('TURNKEY_ORGANIZATION_MISMATCH');
    return {
      status: 'ok',
      provider: 'turnkey',
      organizationId: this.organizationId,
      walletCount: this.wallets.length,
      ...(this.policyId ? { policyId: this.policyId } : {}),
    };
  }

  public zeroize(): void {
    this.client = undefined;
    this.wallets.splice(0, this.wallets.length);
  }
}
