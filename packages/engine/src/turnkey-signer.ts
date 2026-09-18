import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  decodeFunctionData,
  keccak256,
  toBytes,
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
  policyDigest?: Hex;
  policy?: TurnkeyPolicyBinding;
  wallets: TurnkeyWalletReference[];
}

export interface TurnkeyPolicyBinding {
  chainId: 1;
  to: Address;
  functionSelector: `0x${string}`;
  nftContract: Address;
  feeRecipient: Address;
  minterIfNotPayer: Address;
  quantity: string;
  maxValueWei: string;
  maxGasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface TurnkeySecretConfig {
  organizationId: string;
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
  getWhoami(input?: { organizationId?: string }): Promise<{ organizationId: string }>;
  getPolicies?(input: { organizationId: string }): Promise<{ policies: Array<{ policyId: string; effect?: string; condition?: string }> }>;
  getPrivateKeys?(input: { organizationId: string }): Promise<{ privateKeys: Array<{ privateKeyId: string; privateKeyName?: string; addresses: Array<{ format?: string; address?: string }> }> }>;
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
  policyId: string;
  policyDigest: Hex;
  policy: TurnkeyPolicyBinding;
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
  policy: TurnkeyPolicyBinding;
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

export async function readTurnkeySecretConfig(root = 'Rets', scope: SecretScope = 'mainnet'): Promise<TurnkeySecretConfig> {
  const secretRoot = resolve(root);
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
  return (value ?? '0x').toLowerCase();
}

function sameAddress(left: Address | null | undefined, right: Address): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function validatePolicyBinding(value: unknown): TurnkeyPolicyBinding {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_POLICY_BINDING_INVALID');
  const policy = value as Partial<TurnkeyPolicyBinding>;
  const addresses = [policy.to, policy.nftContract, policy.feeRecipient, policy.minterIfNotPayer];
  const amounts = [policy.quantity, policy.maxValueWei, policy.maxGasLimit, policy.maxFeePerGas, policy.maxPriorityFeePerGas];
  if (
    policy.chainId !== 1
    || !/^0x[0-9a-fA-F]{8}$/.test(policy.functionSelector ?? '')
    || addresses.some((address) => typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address))
    || amounts.some((amount) => typeof amount !== 'string' || !/^\d+$/.test(amount))
  ) throw new Error('TURNKEY_POLICY_BINDING_INVALID');
  return {
    chainId: 1,
    to: policy.to as Address,
    functionSelector: policy.functionSelector as `0x${string}`,
    nftContract: policy.nftContract as Address,
    feeRecipient: policy.feeRecipient as Address,
    minterIfNotPayer: policy.minterIfNotPayer as Address,
    quantity: policy.quantity as string,
    maxValueWei: policy.maxValueWei as string,
    maxGasLimit: policy.maxGasLimit as string,
    maxFeePerGas: policy.maxFeePerGas as string,
    maxPriorityFeePerGas: policy.maxPriorityFeePerGas as string,
  };
}

const SEA_DROP_ABI = [{
  type: 'function',
  name: 'mintPublic',
  inputs: [
    { name: 'nftContract', type: 'address' },
    { name: 'feeRecipient', type: 'address' },
    { name: 'minterIfNotPayer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
  ],
  outputs: [],
  stateMutability: 'payable',
}] as const;

function validateIntentAgainstPolicy(intent: TransactionIntent, policy: TurnkeyPolicyBinding): void {
  if (
    intent.chainId !== policy.chainId
    || !sameAddress(intent.to, policy.to)
    || intent.value > BigInt(policy.maxValueWei)
    || intent.gasLimit > BigInt(policy.maxGasLimit)
    || intent.maxFeePerGas > BigInt(policy.maxFeePerGas)
    || intent.maxPriorityFeePerGas > BigInt(policy.maxPriorityFeePerGas)
    || !intent.data.toLowerCase().startsWith(policy.functionSelector.toLowerCase())
  ) throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
  try {
    const decoded = decodeFunctionData({ abi: SEA_DROP_ABI, data: intent.data });
    const [nftContract, feeRecipient, minterIfNotPayer, quantity] = decoded.args as readonly [Address, Address, Address, bigint];
    if (
      decoded.functionName !== 'mintPublic'
      || !sameAddress(nftContract, policy.nftContract)
      || !sameAddress(feeRecipient, policy.feeRecipient)
      || !sameAddress(minterIfNotPayer, policy.minterIfNotPayer)
      || quantity !== BigInt(policy.quantity)
    ) throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
  } catch {
    throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
  }
}

function validateWalletMap(value: unknown): TurnkeyWalletMap {
  if (!value || typeof value !== 'object') throw new Error('TURNKEY_WALLET_MAP_INVALID');
  const candidate = value as Partial<TurnkeyWalletMap>;
  if (candidate.version !== 1 || !Array.isArray(candidate.wallets) || candidate.wallets.length === 0 || typeof candidate.policyId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(candidate.policyDigest ?? '')) {
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
  const policy = validatePolicyBinding(candidate.policy);
  return {
    version: 1,
    ...(typeof candidate.organizationId === 'string' ? { organizationId: candidate.organizationId } : {}),
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
  return validateWalletMap(parsed);
}

export class TurnkeySigner implements Signer {
  private client: TurnkeySignerClient | undefined;
  private readonly organizationId: string;
  private readonly policyId: string;
  private readonly policyDigest: Hex;
  private readonly policy: TurnkeyPolicyBinding;
  private readonly wallets: TurnkeyWalletReference[];
  private readonly generateAppProofs: boolean;

  public constructor(options: TurnkeySignerOptions) {
    if (!options.organizationId) throw new Error('TURNKEY_ORGANIZATION_REQUIRED');
    if (options.wallets.length === 0) throw new Error('TURNKEY_WALLET_MAP_EMPTY');
    if (!options.policyId || !/^0x[0-9a-fA-F]{64}$/.test(options.policyDigest)) throw new Error('TURNKEY_POLICY_DIGEST_REQUIRED');
    this.organizationId = options.organizationId;
    this.policyId = options.policyId;
    this.policyDigest = options.policyDigest;
    this.policy = { ...options.policy };
    this.wallets = options.wallets.map((wallet) => ({ ...wallet }));
    this.client = options.client;
    this.generateAppProofs = options.generateAppProofs ?? true;
  }

  public static async fromSecrets(scope: SecretScope = 'mainnet', root = 'Rets'): Promise<TurnkeySigner> {
    const { organizationId, apiPublicKey, apiPrivateKey, walletMapPath: mapPath } = await readTurnkeySecretConfig(root, scope);
    const map = await readTurnkeyWalletMap(mapPath);
    if (map.organizationId && map.organizationId !== organizationId) throw new Error('TURNKEY_ORGANIZATION_MISMATCH');
    if (!map.policyId || !map.policyDigest || !map.policy) throw new Error('TURNKEY_POLICY_REQUIRED');
    return new TurnkeySigner({
      organizationId,
      wallets: map.wallets,
      policyId: map.policyId,
      policyDigest: map.policyDigest,
      policy: map.policy,
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
    if (!this.policyId || intent.policyRef !== this.policyId) throw new Error('TURNKEY_POLICY_REFERENCE_MISMATCH');
    validateIntentAgainstPolicy(intent, this.policy);

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
      || (signed.accessList?.length ?? 0) !== 0
      || !sameAddress(recoveredAddress, wallet.address)
    ) throw new Error('TURNKEY_SIGNED_TRANSACTION_BOUNDARY_INVALID');

    return signedTransaction as Hex;
  }

  public async probe(): Promise<TurnkeyHealthReport> {
    const client = this.client;
    if (!client) throw new Error('TURNKEY_SIGNER_ZEROIZED');
    if (!this.policyId || !client.getPolicies) throw new Error('TURNKEY_POLICY_CLIENT_REQUIRED');
    const whoami = await client.getWhoami({ organizationId: this.organizationId });
    if (whoami.organizationId !== this.organizationId) throw new Error('TURNKEY_ORGANIZATION_MISMATCH');
    const policies = await client.getPolicies({ organizationId: this.organizationId });
    const policy = policies.policies.find((candidate) => candidate.policyId === this.policyId);
    if (!policy || policy.effect !== 'EFFECT_ALLOW' || !policy.condition || keccak256(toBytes(policy.condition)) !== this.policyDigest) throw new Error('TURNKEY_POLICY_NOT_FOUND');
    const condition = policy.condition.replace(/\s+/g, ' ').toLowerCase();
    const requiredClauses = [
      `eth.tx.chain_id == ${this.policy.chainId}`,
      `eth.tx.to == '${this.policy.to.toLowerCase()}'`,
      `eth.tx.value == ${this.policy.maxValueWei}`,
      `eth.tx.gas <= ${this.policy.maxGasLimit}`,
      `eth.tx.max_fee_per_gas <= ${this.policy.maxFeePerGas}`,
      `eth.tx.max_priority_fee_per_gas <= ${this.policy.maxPriorityFeePerGas}`,
      `eth.tx.function_signature == '${this.policy.functionSelector.toLowerCase()}'`,
      `eth.tx.contract_call_args['nftcontract'] == '${this.policy.nftContract.toLowerCase()}'`,
      `eth.tx.contract_call_args['feerecipient'] == '${this.policy.feeRecipient.toLowerCase()}'`,
      `eth.tx.contract_call_args['minterifnotpayer'] == '${this.policy.minterIfNotPayer.toLowerCase()}'`,
      `eth.tx.contract_call_args['quantity'] == ${this.policy.quantity}`,
    ];
    if (!requiredClauses.every((clause) => condition.includes(clause)) || !this.wallets.every((wallet) => condition.includes(wallet.address.toLowerCase()))) throw new Error('TURNKEY_POLICY_SEMANTICS_INVALID');
    if (!client.getPrivateKeys) throw new Error('TURNKEY_KEY_METADATA_CLIENT_REQUIRED');
    const keyMetadata = await client.getPrivateKeys({ organizationId: this.organizationId });
    if (!this.wallets.every((wallet) => {
      const key = keyMetadata.privateKeys.find((candidate) => candidate.privateKeyId === wallet.signWith);
      return key?.addresses.some((candidate) => candidate.address?.toLowerCase() === wallet.address.toLowerCase()) === true;
    })) throw new Error('TURNKEY_WALLET_REFERENCE_INVALID');
    return {
      status: 'ok',
      provider: 'turnkey',
      organizationId: this.organizationId,
      walletCount: this.wallets.length,
      policyId: this.policyId,
      policyDigest: this.policyDigest,
      policy: this.policy,
    };
  }

  public zeroize(): void {
    this.client = undefined;
    this.wallets.splice(0, this.wallets.length);
  }
}
