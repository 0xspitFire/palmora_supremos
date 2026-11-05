import { keccak256, toBytes, type Address, type Hex } from 'viem';
import type { SupportedChainId, TransactionIntent } from './types.js';
import { SEADROP_V1_ADDRESS } from './chains.js';
import { buildAllowlistMint } from './allowlist-authority.js';

export type TurnkeyEnvironment = 'production' | 'testnet';

export interface TurnkeyProviderBinding {
  readonly provider: 'turnkey';
  readonly environment: TurnkeyEnvironment;
  readonly organizationId: string;
  readonly userId: string;
  readonly policyId: string;
  readonly policyDigest: Hex;
}

export interface TurnkeyPolicyScope {
  readonly provider: 'turnkey';
  readonly environment: TurnkeyEnvironment;
  readonly organizationId: string;
  readonly userId: string;
  readonly policyId: string;
  readonly keyIds: readonly string[];
}

export interface TurnkeyPolicyTransaction {
  readonly chainId: SupportedChainId;
  readonly from: readonly Address[];
  readonly to: Address;
  readonly valueWei: string;
  readonly data: Hex;
  readonly gasLimitMax: string;
  readonly maxFeePerGasMax: string;
  readonly maxPriorityFeePerGasMax: string;
  readonly accessList: readonly [];
}

/** Closed, bounded provider-side families; legacy Robinhood records remain valid. */
export interface TurnkeyPolicyFamily {
  readonly kind: 'robinhood-seadrop-public-v1' | 'seadrop-free-allowlist-v1' | 'seadrop-free-public-v1';
  readonly maxQuantity: number;
}

/**
 * Canonical allow-only policy AST. It intentionally has no `or`, wildcard,
 * substring, regex, deny/allow union, or unbounded transaction branch. The
 * optional family is a closed, enumerated bounded schema, not a free-form CEL
 * escape hatch.
 */
export interface TurnkeyPolicyAst {
  readonly version: 1;
  readonly effect: 'allow';
  readonly scope: TurnkeyPolicyScope;
  readonly transaction: TurnkeyPolicyTransaction;
  readonly family?: TurnkeyPolicyFamily;
}

export interface TurnkeyKeyInventoryEntry {
  readonly privateKeyId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly environment: TurnkeyEnvironment;
  readonly address: Address;
}

export interface TurnkeyKeyInventory {
  readonly organizationId: string;
  readonly userId: string;
  readonly environment: TurnkeyEnvironment;
  readonly privateKeys: readonly TurnkeyKeyInventoryEntry[];
}

export function normalizeHexBytes(value: string): Hex {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('TURNKEY_HEX_BYTES_INVALID');
  return value.toLowerCase() as Hex;
}

export function normalizeAccessList(value: readonly { address: Address; storageKeys: readonly Hex[] }[] | undefined): string {
  if (!value || value.length === 0) return '[]';
  const entries = value.map((entry) => {
    if (!isAddress(entry.address) || !Array.isArray(entry.storageKeys)) throw new Error('TURNKEY_ACCESS_LIST_INVALID');
    const storageKeys = entry.storageKeys.map((key) => {
      const normalized = normalizeHexBytes(key);
      if (normalized.length !== 66) throw new Error('TURNKEY_ACCESS_LIST_INVALID');
      return normalized;
    }).sort();
    return { address: entry.address.toLowerCase(), storageKeys };
  }).sort((left, right) => left.address.localeCompare(right.address) || JSON.stringify(left.storageKeys).localeCompare(JSON.stringify(right.storageKeys)));
  return JSON.stringify(entries);
}

export function validateTurnkeyPolicyAst(value: unknown): TurnkeyPolicyAst {
  if (!isRecord(value) || !([['version', 'effect', 'scope', 'transaction'], ['version', 'effect', 'scope', 'transaction', 'family']] as const).some((keys) => exactKeys(value, keys))) throw new Error('TURNKEY_POLICY_AST_INVALID');
  if (value.version !== 1 || value.effect !== 'allow' || !isRecord(value.scope) || !isRecord(value.transaction)) throw new Error('TURNKEY_POLICY_AST_INVALID');
  if (!exactKeys(value.scope, ['provider', 'environment', 'organizationId', 'userId', 'policyId', 'keyIds'])) throw new Error('TURNKEY_POLICY_SCOPE_INVALID');
  if (!exactKeys(value.transaction, ['chainId', 'from', 'to', 'valueWei', 'data', 'gasLimitMax', 'maxFeePerGasMax', 'maxPriorityFeePerGasMax', 'accessList'])) throw new Error('TURNKEY_POLICY_TRANSACTION_INVALID');
  const scope = value.scope;
  const tx = value.transaction;
  const familyValue = value.family;
  const familyRecord = familyValue as Record<string, unknown> | undefined;
  if (familyValue !== undefined && (!isRecord(familyValue) || !exactKeys(familyValue, ['kind', 'maxQuantity']) || !['robinhood-seadrop-public-v1', 'seadrop-free-allowlist-v1', 'seadrop-free-public-v1'].includes(String(familyRecord?.kind)) || !Number.isSafeInteger(familyRecord?.maxQuantity) || Number(familyRecord?.maxQuantity) < 1 || Number(familyRecord?.maxQuantity) > 15)) throw new Error('TURNKEY_POLICY_FAMILY_INVALID');
  const family = familyValue === undefined ? undefined : { kind: familyRecord!.kind as TurnkeyPolicyFamily['kind'], maxQuantity: Number(familyRecord?.maxQuantity) };
  if (scope.provider !== 'turnkey' || !isEnvironment(scope.environment) || !nonEmpty(scope.organizationId) || !nonEmpty(scope.userId) || !nonEmpty(scope.policyId) || !stringArray(scope.keyIds)) throw new Error('TURNKEY_POLICY_SCOPE_INVALID');
  const keyIds = uniqueStrings(scope.keyIds);
  if (!keyIds || keyIds.length === 0) throw new Error('TURNKEY_POLICY_SCOPE_INVALID');
  if (!isSupportedChainId(tx.chainId) || !Array.isArray(tx.from) || tx.from.length === 0 || !isAddress(tx.to) || typeof tx.valueWei !== 'string' || typeof tx.data !== 'string' || typeof tx.gasLimitMax !== 'string' || typeof tx.maxFeePerGasMax !== 'string' || typeof tx.maxPriorityFeePerGasMax !== 'string' || !Array.isArray(tx.accessList)) throw new Error('TURNKEY_POLICY_TRANSACTION_INVALID');
  const from = tx.from.map((address) => {
    if (!isAddress(address)) throw new Error('TURNKEY_POLICY_TRANSACTION_INVALID');
    return address.toLowerCase() as Address;
  });
  if (new Set(from).size !== from.length || tx.valueWei !== '0' || !isNonNegativeInteger(tx.valueWei) || !isNonNegativeInteger(tx.gasLimitMax) || !isNonNegativeInteger(tx.maxFeePerGasMax) || !isNonNegativeInteger(tx.maxPriorityFeePerGasMax) || tx.accessList.length !== 0) throw new Error('TURNKEY_POLICY_TRANSACTION_INVALID');
  const data = normalizeHexBytes(tx.data as string);
  if (data === '0x') throw new Error('TURNKEY_POLICY_TRANSACTION_INVALID');
  if (family?.kind === 'seadrop-free-public-v1') {
    if (family.maxQuantity > (tx.chainId === 8453 ? 4 : 10)) throw new Error('TURNKEY_POLICY_FAMILY_INVALID');
    const gas = BigInt(tx.gasLimitMax); const fee = BigInt(tx.maxFeePerGasMax); const tip = BigInt(tx.maxPriorityFeePerGasMax);
    if (gas < 1n || gas > 500_000n || fee < 1n || fee > 200_000_000n || tip > 100_000_000n || tip > fee) throw new Error('TURNKEY_POLICY_FAMILY_FEE_LIMIT_INVALID');
  }
  if (family?.kind === 'seadrop-free-allowlist-v1' && tx.chainId === 8453 && family.maxQuantity > 4) throw new Error('TURNKEY_POLICY_FAMILY_INVALID');
  if (family?.kind === 'seadrop-free-allowlist-v1') {
    const gas = BigInt(tx.gasLimitMax);
    const maxFee = BigInt(tx.maxFeePerGasMax);
    const tip = BigInt(tx.maxPriorityFeePerGasMax);
    const walletCap = tx.chainId === 1 ? 400_000_000_000_000n : 200_000_000_000_000n;
    const feeCap = tx.chainId === 1 ? 800_000_000n : 200_000_000n;
    if (gas < 1n || gas > 500_000n || maxFee < 1n || maxFee > feeCap || tip > 100_000_000n || tip > maxFee || gas * maxFee > walletCap) throw new Error('TURNKEY_POLICY_FAMILY_FEE_LIMIT_INVALID');
  }
  if (family !== undefined && (tx.to.toLowerCase() !== SEADROP_V1_ADDRESS.toLowerCase() || tx.valueWei !== '0' || (family.kind === 'robinhood-seadrop-public-v1' ? tx.chainId !== 4663 || data !== '0x161ac21f' : family.kind === 'seadrop-free-public-v1' ? data !== '0x161ac21f' : data !== '0x4300a4e6'))) throw new Error('TURNKEY_POLICY_FAMILY_INVALID');
  return {
    version: 1,
    effect: 'allow',
    scope: {
      provider: 'turnkey',
      environment: scope.environment,
      organizationId: scope.organizationId,
      userId: scope.userId,
      policyId: scope.policyId,
      keyIds: [...keyIds].sort(),
    },
    transaction: {
      chainId: tx.chainId,
      from: [...new Set(from)].sort() as Address[],
      to: tx.to.toLowerCase() as Address,
      valueWei: tx.valueWei,
      data,
      gasLimitMax: tx.gasLimitMax,
      maxFeePerGasMax: tx.maxFeePerGasMax,
      maxPriorityFeePerGasMax: tx.maxPriorityFeePerGasMax,
      accessList: [],
    },
    ...(family === undefined ? {} : { family: { kind: family.kind, maxQuantity: family.maxQuantity } }),
  };
}

export function canonicalPolicyJson(policy: TurnkeyPolicyAst): string {
  return stableStringify(validateTurnkeyPolicyAst(policy));
}

export function canonicalPolicyDigest(policy: TurnkeyPolicyAst): Hex {
  return keccak256(toBytes(canonicalPolicyJson(policy)));
}

export function turnkeyPolicyRef(policyId: string, policyDigest: Hex): string {
  if (!nonEmpty(policyId) || !/^0x[0-9a-f]{64}$/i.test(policyDigest)) throw new Error('TURNKEY_POLICY_REFERENCE_INVALID');
  return `turnkey:${policyId}:${policyDigest.toLowerCase()}`;
}

export function validatePolicyBinding(
  policy: TurnkeyPolicyAst,
  provider: TurnkeyProviderBinding,
  wallets: readonly { signWith: string; address: Address }[],
): TurnkeyPolicyAst {
  const normalized = validateTurnkeyPolicyAst(policy);
  if (provider.provider !== 'turnkey' || !/^0x[0-9a-f]{64}$/i.test(provider.policyDigest) || provider.policyId !== normalized.scope.policyId || provider.organizationId !== normalized.scope.organizationId || provider.userId !== normalized.scope.userId || provider.environment !== normalized.scope.environment || canonicalPolicyDigest(normalized).toLowerCase() !== provider.policyDigest.toLowerCase()) throw new Error('TURNKEY_POLICY_PROVIDER_BINDING_INVALID');
  const walletIds = wallets.map((wallet) => wallet.signWith).sort();
  const walletAddresses = wallets.map((wallet) => wallet.address.toLowerCase()).sort();
  if (JSON.stringify(walletIds) !== JSON.stringify(normalized.scope.keyIds) || JSON.stringify(walletAddresses) !== JSON.stringify(normalized.transaction.from)) throw new Error('TURNKEY_POLICY_WALLET_SCOPE_INVALID');
  return normalized;
}

export function validateKeyInventory(inventory: TurnkeyKeyInventory, provider: TurnkeyProviderBinding, wallets: readonly { signWith: string; address: Address }[]): void {
  if (inventory.organizationId !== provider.organizationId || inventory.userId !== provider.userId || inventory.environment !== provider.environment || inventory.privateKeys.length !== wallets.length) throw new Error('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
  const expected = new Map(wallets.map((wallet) => [wallet.signWith, wallet.address.toLowerCase()]));
  const seen = new Set<string>();
  for (const key of inventory.privateKeys) {
    if (seen.has(key.privateKeyId) || !expected.has(key.privateKeyId) || key.organizationId !== provider.organizationId || key.userId !== provider.userId || key.environment !== provider.environment || !isAddress(key.address) || key.address.toLowerCase() !== expected.get(key.privateKeyId)) throw new Error('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
    seen.add(key.privateKeyId);
  }
  if (seen.size !== expected.size) throw new Error('TURNKEY_KEY_INVENTORY_BINDING_INVALID');
}

export function validateTransactionIntent(intent: TransactionIntent, policy: TurnkeyPolicyAst, expectedPolicyRef: string): void {
  try {
    const normalized = validateTurnkeyPolicyAst(policy);
    const common = intent.policyRef === expectedPolicyRef
      && intent.chainId === normalized.transaction.chainId
      && intent.nonce >= 0
      && isAddress(intent.from)
      && normalized.transaction.from.includes(intent.from.toLowerCase() as Address)
      && isAddress(intent.to)
      && intent.to.toLowerCase() === normalized.transaction.to
      && intent.value === BigInt(normalized.transaction.valueWei)
      && intent.gasLimit >= 0n
      && intent.maxFeePerGas >= 0n
      && intent.maxPriorityFeePerGas >= 0n
      && intent.gasLimit <= BigInt(normalized.transaction.gasLimitMax)
      && intent.maxFeePerGas <= BigInt(normalized.transaction.maxFeePerGasMax)
      && intent.maxPriorityFeePerGas <= BigInt(normalized.transaction.maxPriorityFeePerGasMax)
      && normalizeAccessList(intent.accessList) === '[]';
    const data = normalizeHexBytes(intent.data);
    const exactData = normalized.family === undefined && data === normalized.transaction.data;
    const familyData = normalized.family?.kind === 'robinhood-seadrop-public-v1' || normalized.family?.kind === 'seadrop-free-public-v1' ? robinhoodFamilyCalldata(data, normalized.family.maxQuantity, intent.familyContext) : normalized.family?.kind === 'seadrop-free-allowlist-v1' ? allowlistFamilyCalldata(intent, data, normalized.family.maxQuantity) : false;
    if (!common || (!exactData && !familyData)) throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
  } catch (error) {
    if (error instanceof Error && error.message === 'TURNKEY_POLICY_INTENT_BLOCKED') throw error;
    throw new Error('TURNKEY_POLICY_INTENT_BLOCKED');
  }
}

/** Exact calldata validation retained locally when Turnkey uses the bounded family policy. */
function robinhoodFamilyCalldata(data: Hex, maxQuantity: number, context: TransactionIntent['familyContext']): boolean {
  if (data.length !== 266 || data.slice(0, 10).toLowerCase() !== '0x161ac21f') return false;
  if (!/^0{24}$/.test(data.slice(10, 34)) || !/^0{24}$/.test(data.slice(74, 98))) return false;
  if (!context || !isAddress(context.nftContract) || !isAddress(context.feeRecipient)) return false;
  if (`0x${data.slice(34, 74)}`.toLowerCase() !== context.nftContract.toLowerCase() || `0x${data.slice(98, 138)}`.toLowerCase() !== context.feeRecipient.toLowerCase()) return false;
  if (!/^0{64}$/.test(data.slice(138, 202))) return false;
  try {
    const quantity = BigInt(`0x${data.slice(202, 266)}`);
    return quantity >= 1n && quantity <= BigInt(maxQuantity);
  } catch { return false; }
}

/** Verify the canonical wallet-bound proof against the fresh authority supplied by the guarded engine. */
function allowlistFamilyCalldata(intent: TransactionIntent, data: Hex, maxQuantity: number): boolean {
  const context = intent.familyContext;
  const proof = context?.allowlistProof;
  if (!intent.campaignId || !intent.runId || !context || !proof || proof.source.chainId !== intent.chainId || proof.source.nftContract.toLowerCase() !== context.nftContract.toLowerCase() || proof.source.stageIndex !== proof.mintParams.dropStageIndex.toString() || proof.authority.chainId !== intent.chainId || proof.authority.nftContract.toLowerCase() !== context.nftContract.toLowerCase() || proof.authority.feeRecipient.toLowerCase() !== context.feeRecipient.toLowerCase() || proof.authority.seaDrop.toLowerCase() !== intent.to.toLowerCase() || proof.mintParams.mintPrice !== 0n || proof.proof.length > 64) return false;
  for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
    try {
      const reconstructed = buildAllowlistMint(proof, intent.from, quantity);
      if (reconstructed.value === 0n && reconstructed.data.toLowerCase() === data.toLowerCase()) return true;
    } catch { return false; }
  }
  return false;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnvironment(value: unknown): value is TurnkeyEnvironment { return value === 'production' || value === 'testnet'; }
function isSupportedChainId(value: unknown): value is SupportedChainId { return value === 1 || value === 8453 || value === 4663; }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !/[\s\r\n]/.test(value); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonEmpty); }
function uniqueStrings(value: readonly string[]): readonly string[] | null { return new Set(value).size === value.length ? value : null; }
function isNonNegativeInteger(value: string): boolean { return /^(?:0|[1-9]\d*)$/.test(value); }
function isAddress(value: unknown): value is Address { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }
