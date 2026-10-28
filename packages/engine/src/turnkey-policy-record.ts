import {
  createHash,
  createPublicKey,
  KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import type { Address } from 'viem';
import { validateTurnkeyPolicyAst, type TurnkeyEnvironment, type TurnkeyPolicyAst } from './turnkey-policy.js';

const RECORD_CONTEXT = 'mintbot.turnkey-policy-record/v1' as const;
const SIGNATURE_CONTEXT = 'mintbot.turnkey-policy-record/signature/v1\0';
const CATALOG_CONTEXT = 'mintbot.turnkey-policy-catalog/v1' as const;

export interface TurnkeyProviderTimestamp {
  readonly seconds: string;
  readonly nanos: string;
}

export interface TurnkeyProviderIdentityProjection {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly userId: string;
  readonly username: string;
}

export interface TurnkeyProviderPolicyProjection {
  readonly policyId: string;
  readonly policyName: string;
  readonly effect: 'EFFECT_ALLOW' | 'EFFECT_DENY';
  readonly createdAt: TurnkeyProviderTimestamp;
  readonly updatedAt: TurnkeyProviderTimestamp;
  readonly notes: string;
  readonly consensus: string;
  readonly condition: string;
  readonly time: string | null;
}

export interface TurnkeyProviderAddressProjection {
  readonly format: string | null;
  readonly address: string | null;
}

export interface TurnkeyProviderKeyProjection {
  readonly privateKeyId: string;
  readonly publicKey: string;
  readonly privateKeyName: string;
  readonly curve: string;
  readonly addresses: readonly TurnkeyProviderAddressProjection[];
  readonly privateKeyTags: readonly string[];
  readonly createdAt: TurnkeyProviderTimestamp;
  readonly updatedAt: TurnkeyProviderTimestamp | null;
  readonly exported: boolean;
  readonly imported: boolean;
}

export interface TurnkeyPolicyRecordWallet {
  readonly index: number;
  readonly address: Address;
  readonly signWith: string;
  readonly providerKey: TurnkeyProviderKeyProjection;
}

export interface TurnkeyCanonicalPolicyRecord {
  readonly version: 1;
  readonly context: typeof RECORD_CONTEXT;
  readonly environment: TurnkeyEnvironment;
  readonly providerIdentity: TurnkeyProviderIdentityProjection;
  readonly providerPolicy: TurnkeyProviderPolicyProjection;
  readonly enforcementPolicy: TurnkeyPolicyAst;
  readonly wallets: readonly TurnkeyPolicyRecordWallet[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TurnkeySignedPolicyRecord {
  readonly version: 1;
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly recordDigest: `sha256:${string}`;
  readonly record: TurnkeyCanonicalPolicyRecord;
  readonly signature: string;
}

/**
 * A catalog is deliberately only a container of independently owner-signed
 * records. Adding an allow policy therefore still requires the offline owner
 * signature, while removing an entry can only cause a fail-closed outage.
 */
export interface TurnkeySignedPolicyCatalog {
  readonly version: 1;
  readonly context: typeof CATALOG_CONTEXT;
  readonly records: readonly TurnkeySignedPolicyRecord[];
}

export interface TurnkeyActualProviderState {
  readonly whoami: unknown;
  readonly organization: unknown;
  readonly policies: readonly unknown[];
  readonly privateKeys: readonly unknown[];
}

function assertNonRootRuntimeUser(organizationValue: unknown, identity: TurnkeyProviderIdentityProjection): void {
  if (!organizationValue || typeof organizationValue !== 'object' || Array.isArray(organizationValue)) throw new Error('TURNKEY_PROVIDER_ORGANIZATION_INVALID');
  const configs = (organizationValue as { configs?: unknown }).configs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) throw new Error('TURNKEY_PROVIDER_ORGANIZATION_INVALID');
  const quorumValue = (configs as { quorum?: unknown }).quorum;
  if (!quorumValue || typeof quorumValue !== 'object' || Array.isArray(quorumValue)) throw new Error('TURNKEY_PROVIDER_ORGANIZATION_INVALID');
  const quorum = quorumValue as { threshold?: unknown; userIds?: unknown };
  if (!Number.isSafeInteger(quorum.threshold) || Number(quorum.threshold) < 1 || !Array.isArray(quorum.userIds) || quorum.userIds.length === 0 || !quorum.userIds.every((id) => typeof id === 'string' && id.length > 0)) throw new Error('TURNKEY_PROVIDER_ORGANIZATION_INVALID');
  if (quorum.userIds.includes(identity.userId)) throw new Error('TURNKEY_PROVIDER_RUNTIME_USER_MUST_BE_NON_ROOT');
}

/**
 * The provider policy is the custody boundary.  Keep this projection deliberately
 * boring and exact: the owner-signed local AST is not allowed to describe a
 * narrower transaction than Turnkey itself will authorize.
 */
export function turnkeyProviderPolicyExpressions(policyValue: unknown): { consensus: string; condition: string } {
  const policy = validateTurnkeyPolicyAst(policyValue);
  const quote = (value: string): string => {
    if (!/^[A-Za-z0-9_:.\/-]+$/.test(value)) throw new Error('TURNKEY_PROVIDER_POLICY_EXPRESSION_INVALID');
    return `'${value}'`;
  };
  const list = (values: readonly string[]): string => `[${[...values].sort().map(quote).join(', ')}]`;
  const tx = policy.transaction;
  const dataCondition = policy.family?.kind === 'robinhood-seadrop-public-v1'
    ? [
      `eth.tx.data[0..10] == ${quote(tx.data.toLowerCase())}`,
      "eth.tx.data[138..202] == '0000000000000000000000000000000000000000000000000000000000000000'",
      `eth.tx.data[202..266].hex_to_uint() >= 1`,
      `eth.tx.data[202..266].hex_to_uint() <= ${policy.family.maxQuantity}`,
    ].join(' && ')
    : `eth.tx.data == ${quote(tx.data.toLowerCase())}`;
  return {
    consensus: `approvers.any(user, user.id == ${quote(policy.scope.userId)})`,
    condition: [
      "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'",
      `private_key.id in ${list(policy.scope.keyIds)}`,
      `eth.tx.chain_id == ${tx.chainId}`,
      `eth.tx.from in ${list(tx.from.map((address) => address.toLowerCase()))}`,
      `eth.tx.to == ${quote(tx.to.toLowerCase())}`,
      `eth.tx.value == ${tx.valueWei}`,
      dataCondition,
      `eth.tx.gas <= ${tx.gasLimitMax}`,
      `eth.tx.max_fee_per_gas <= ${tx.maxFeePerGasMax}`,
      `eth.tx.max_priority_fee_per_gas <= ${tx.maxPriorityFeePerGasMax}`,
    ].join(' && '),
  };
}

type VerificationKey = KeyObject | string | Buffer;

export function projectTurnkeyProviderIdentity(value: unknown): TurnkeyProviderIdentityProjection {
  const item = exactRecord(value, ['organizationId', 'organizationName', 'userId', 'username'], 'TURNKEY_PROVIDER_IDENTITY_INVALID');
  return {
    organizationId: requiredString(item.organizationId, 'TURNKEY_PROVIDER_IDENTITY_INVALID'),
    organizationName: stringValue(item.organizationName, 'TURNKEY_PROVIDER_IDENTITY_INVALID'),
    userId: requiredString(item.userId, 'TURNKEY_PROVIDER_IDENTITY_INVALID'),
    username: stringValue(item.username, 'TURNKEY_PROVIDER_IDENTITY_INVALID'),
  };
}

export function projectTurnkeyProviderPolicy(value: unknown): TurnkeyProviderPolicyProjection {
  const item = optionalExactRecord(value, ['policyId', 'policyName', 'effect', 'createdAt', 'updatedAt', 'notes', 'consensus', 'condition'], ['time'], 'TURNKEY_PROVIDER_POLICY_INVALID');
  if (item.effect !== 'EFFECT_ALLOW' && item.effect !== 'EFFECT_DENY') throw new Error('TURNKEY_PROVIDER_POLICY_INVALID');
  return {
    policyId: requiredString(item.policyId, 'TURNKEY_PROVIDER_POLICY_INVALID'),
    policyName: stringValue(item.policyName, 'TURNKEY_PROVIDER_POLICY_INVALID'),
    effect: item.effect,
    createdAt: providerTimestamp(item.createdAt),
    updatedAt: providerTimestamp(item.updatedAt),
    notes: stringValue(item.notes, 'TURNKEY_PROVIDER_POLICY_INVALID'),
    consensus: stringValue(item.consensus, 'TURNKEY_PROVIDER_POLICY_INVALID'),
    condition: stringValue(item.condition, 'TURNKEY_PROVIDER_POLICY_INVALID'),
    time: item.time === undefined ? null : nullableString(item.time, 'TURNKEY_PROVIDER_POLICY_INVALID'),
  };
}

export function projectTurnkeyProviderKey(value: unknown): TurnkeyProviderKeyProjection {
  const item = exactRecord(value, ['privateKeyId', 'publicKey', 'privateKeyName', 'curve', 'addresses', 'privateKeyTags', 'createdAt', 'updatedAt', 'exported', 'imported'], 'TURNKEY_PROVIDER_KEY_INVALID');
  if (!Array.isArray(item.addresses) || !Array.isArray(item.privateKeyTags) || typeof item.exported !== 'boolean' || typeof item.imported !== 'boolean') throw new Error('TURNKEY_PROVIDER_KEY_INVALID');
  const addresses = item.addresses.map((address) => {
    const candidate = optionalExactRecord(address, [], ['format', 'address'], 'TURNKEY_PROVIDER_KEY_INVALID');
    return {
      format: candidate.format === undefined ? null : nullableString(candidate.format, 'TURNKEY_PROVIDER_KEY_INVALID'),
      address: candidate.address === undefined ? null : nullableString(candidate.address, 'TURNKEY_PROVIDER_KEY_INVALID')?.toLowerCase() ?? null,
    };
  }).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const tags = item.privateKeyTags.map((tag) => requiredString(tag, 'TURNKEY_PROVIDER_KEY_INVALID')).sort();
  if (new Set(tags).size !== tags.length) throw new Error('TURNKEY_PROVIDER_KEY_INVALID');
  const publicKey = requiredString(item.publicKey, 'TURNKEY_PROVIDER_KEY_INVALID').replace(/^0x/i, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(publicKey)) throw new Error('TURNKEY_PROVIDER_KEY_INVALID');
  return {
    privateKeyId: requiredString(item.privateKeyId, 'TURNKEY_PROVIDER_KEY_INVALID'),
    publicKey,
    privateKeyName: requiredString(item.privateKeyName, 'TURNKEY_PROVIDER_KEY_INVALID'),
    curve: requiredString(item.curve, 'TURNKEY_PROVIDER_KEY_INVALID'),
    addresses,
    privateKeyTags: tags,
    createdAt: providerTimestamp(item.createdAt),
    updatedAt: item.updatedAt === null ? null : providerTimestamp(item.updatedAt),
    exported: item.exported,
    imported: item.imported,
  };
}

export function createTurnkeyPolicyRecord(input: {
  environment: TurnkeyEnvironment;
  providerIdentity: unknown;
  providerPolicy: unknown;
  enforcementPolicy: unknown;
  walletReferences: readonly { index: number; address: Address; signWith: string }[];
  providerKeys: readonly unknown[];
  issuedAt: string;
  expiresAt: string;
}): TurnkeyCanonicalPolicyRecord {
  const keys = input.providerKeys.map(projectTurnkeyProviderKey);
  const byId = new Map(keys.map((key) => [key.privateKeyId, key]));
  if (byId.size !== keys.length) throw new Error('TURNKEY_PROVIDER_KEY_DUPLICATE');
  const wallets = input.walletReferences.map((wallet, index) => {
    if (wallet.index !== index) throw new Error('TURNKEY_POLICY_RECORD_WALLET_INDEX_INVALID');
    const providerKey = byId.get(wallet.signWith);
    if (!providerKey) throw new Error('TURNKEY_PROVIDER_KEY_NOT_FOUND');
    return { index, address: wallet.address, signWith: wallet.signWith, providerKey };
  });
  return validateTurnkeyCanonicalPolicyRecord({
    version: 1,
    context: RECORD_CONTEXT,
    environment: input.environment,
    providerIdentity: projectTurnkeyProviderIdentity(input.providerIdentity),
    providerPolicy: projectTurnkeyProviderPolicy(input.providerPolicy),
    enforcementPolicy: input.enforcementPolicy,
    wallets,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
}

export function validateTurnkeyCanonicalPolicyRecord(value: unknown): TurnkeyCanonicalPolicyRecord {
  const item = exactRecord(value, ['version', 'context', 'environment', 'providerIdentity', 'providerPolicy', 'enforcementPolicy', 'wallets', 'issuedAt', 'expiresAt'], 'TURNKEY_POLICY_RECORD_INVALID');
  if (item.version !== 1 || item.context !== RECORD_CONTEXT || (item.environment !== 'production' && item.environment !== 'testnet') || !Array.isArray(item.wallets) || item.wallets.length === 0) throw new Error('TURNKEY_POLICY_RECORD_INVALID');
  const providerIdentity = projectTurnkeyProviderIdentity(item.providerIdentity);
  const providerPolicy = projectTurnkeyProviderPolicy(item.providerPolicy);
  const enforcementPolicy = validateTurnkeyPolicyAst(item.enforcementPolicy);
  const expectedProviderExpressions = turnkeyProviderPolicyExpressions(enforcementPolicy);
  const issuedAt = canonicalIso(item.issuedAt, 'TURNKEY_POLICY_RECORD_INVALID');
  const expiresAt = canonicalIso(item.expiresAt, 'TURNKEY_POLICY_RECORD_INVALID');
  if (Date.parse(issuedAt) >= Date.parse(expiresAt)) throw new Error('TURNKEY_POLICY_RECORD_INVALID');
  const wallets = item.wallets.map((wallet, index) => {
    const candidate = exactRecord(wallet, ['index', 'address', 'signWith', 'providerKey'], 'TURNKEY_POLICY_RECORD_INVALID');
    const address = requiredString(candidate.address, 'TURNKEY_POLICY_RECORD_INVALID').toLowerCase();
    const signWith = requiredString(candidate.signWith, 'TURNKEY_POLICY_RECORD_INVALID');
    if (candidate.index !== index || !/^0x[0-9a-f]{40}$/.test(address)) throw new Error('TURNKEY_POLICY_RECORD_INVALID');
    const providerKey = projectTurnkeyProviderKey(candidate.providerKey);
    const ethereumAddresses = providerKey.addresses.filter((entry) => entry.format === 'ADDRESS_FORMAT_ETHEREUM').map((entry) => entry.address);
    if (providerKey.privateKeyId !== signWith || providerKey.curve !== 'CURVE_SECP256K1' || providerKey.exported || !ethereumAddresses.includes(address)) throw new Error('TURNKEY_POLICY_RECORD_KEY_BINDING_INVALID');
    return { index, address: address as Address, signWith, providerKey };
  });
  if (new Set(wallets.map((wallet) => wallet.address)).size !== wallets.length || new Set(wallets.map((wallet) => wallet.signWith)).size !== wallets.length) throw new Error('TURNKEY_POLICY_RECORD_WALLET_DUPLICATE');
  if (
    providerPolicy.effect !== 'EFFECT_ALLOW'
    || providerPolicy.condition !== expectedProviderExpressions.condition
    || providerPolicy.consensus !== expectedProviderExpressions.consensus
    || providerPolicy.time !== null
    || providerPolicy.policyId !== enforcementPolicy.scope.policyId
    || providerIdentity.organizationId !== enforcementPolicy.scope.organizationId
    || providerIdentity.userId !== enforcementPolicy.scope.userId
    || item.environment !== enforcementPolicy.scope.environment
    || stableStringify(wallets.map((wallet) => wallet.signWith).sort()) !== stableStringify([...enforcementPolicy.scope.keyIds].sort())
    || stableStringify(wallets.map((wallet) => wallet.address).sort()) !== stableStringify([...enforcementPolicy.transaction.from].map((address) => address.toLowerCase()).sort())
  ) throw new Error('TURNKEY_POLICY_RECORD_BINDING_INVALID');
  return { version: 1, context: RECORD_CONTEXT, environment: item.environment, providerIdentity, providerPolicy, enforcementPolicy, wallets, issuedAt, expiresAt };
}

export function canonicalTurnkeyPolicyRecordJson(value: unknown): string {
  return stableStringify(validateTurnkeyCanonicalPolicyRecord(value));
}

export function turnkeyPolicyRecordDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(signaturePayload(value)).digest('hex')}`;
}

export function turnkeyPolicyApproverKeyId(publicKey: VerificationKey): string {
  const key = asPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  const digest = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  return `ed25519:${digest}`;
}

export function signTurnkeyPolicyRecord(record: unknown, privateKey: VerificationKey): TurnkeySignedPolicyRecord {
  const validated = validateTurnkeyCanonicalPolicyRecord(record);
  const publicKey = derivePublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  return {
    version: 1,
    algorithm: 'Ed25519',
    keyId: turnkeyPolicyApproverKeyId(publicKey),
    recordDigest: turnkeyPolicyRecordDigest(validated),
    record: validated,
    signature: signBytes(null, signaturePayload(validated), privateKey).toString('base64url'),
  };
}

function authenticateTurnkeySignedPolicyRecord(value: unknown, pinnedPublicKey: VerificationKey): TurnkeyCanonicalPolicyRecord {
  if (pinnedPublicKey instanceof KeyObject && pinnedPublicKey.type !== 'public') throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  const verifier = asPublicKey(pinnedPublicKey);
  const envelope = exactRecord(value, ['version', 'algorithm', 'keyId', 'recordDigest', 'record', 'signature'], 'TURNKEY_POLICY_SIGNATURE_INVALID');
  if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519' || envelope.keyId !== turnkeyPolicyApproverKeyId(verifier) || typeof envelope.signature !== 'string') throw new Error('TURNKEY_POLICY_SIGNATURE_INVALID');
  const record = validateTurnkeyCanonicalPolicyRecord(envelope.record);
  if (envelope.recordDigest !== turnkeyPolicyRecordDigest(record)) throw new Error('TURNKEY_POLICY_RECORD_DIGEST_MISMATCH');
  let signature: Buffer;
  try { signature = Buffer.from(envelope.signature, 'base64url'); } catch { throw new Error('TURNKEY_POLICY_SIGNATURE_INVALID'); }
  if (signature.length !== 64 || !verifyBytes(null, signaturePayload(record), verifier, signature)) throw new Error('TURNKEY_POLICY_SIGNATURE_INVALID');
  return record;
}

export function verifyTurnkeySignedPolicyRecord(value: unknown, pinnedPublicKey: VerificationKey, now = new Date()): TurnkeyCanonicalPolicyRecord {
  const record = authenticateTurnkeySignedPolicyRecord(value, pinnedPublicKey);
  const instant = now.getTime();
  if (!Number.isFinite(instant) || instant < Date.parse(record.issuedAt) || instant >= Date.parse(record.expiresAt)) throw new Error('TURNKEY_POLICY_RECORD_NOT_CURRENT');
  return record;
}

function authenticateCatalog(value: unknown, pinnedPublicKey: VerificationKey, enforceRetentionLimit: boolean): { item: Record<string, unknown>; records: TurnkeyCanonicalPolicyRecord[] } {
  const item = exactRecord(value, ['version', 'context', 'records'], 'TURNKEY_POLICY_CATALOG_INVALID');
  if (item.version !== 1 || item.context !== CATALOG_CONTEXT || !Array.isArray(item.records) || item.records.length === 0 || item.records.length > 1_000 || (enforceRetentionLimit && item.records.length > 25)) throw new Error('TURNKEY_POLICY_CATALOG_INVALID');
  const records = item.records.map((record) => authenticateTurnkeySignedPolicyRecord(record, pinnedPublicKey));
  const first = records[0]!;
  const policyIds = new Set<string>();
  const recordDigests = new Set<string>();
  for (const record of records) {
    const digest = turnkeyPolicyRecordDigest(record);
    if (
      record.environment !== first.environment
      || stableStringify(record.providerIdentity) !== stableStringify(first.providerIdentity)
      || stableStringify(record.wallets) !== stableStringify(first.wallets)
      || policyIds.has(record.providerPolicy.policyId)
      || recordDigests.has(digest)
    ) throw new Error('TURNKEY_POLICY_CATALOG_BINDING_INVALID');
    policyIds.add(record.providerPolicy.policyId);
    recordDigests.add(digest);
  }
  return { item, records };
}

export function verifyTurnkeySignedPolicyCatalog(value: unknown, pinnedPublicKey: VerificationKey, now = new Date()): readonly TurnkeyCanonicalPolicyRecord[] {
  const { records } = authenticateCatalog(value, pinnedPublicKey, true);
  const instant = now.getTime();
  if (!Number.isFinite(instant)) throw new Error('TURNKEY_POLICY_RECORD_NOT_CURRENT');
  return records.filter((record) => instant >= Date.parse(record.issuedAt) && instant < Date.parse(record.expiresAt));
}

/** Authenticates every retained entry, then removes expired/future records and explicit retirements. */
export function pruneTurnkeySignedPolicyCatalog(value: unknown, pinnedPublicKey: VerificationKey, options: { now?: Date; retirePolicyIds?: readonly string[] } = {}): TurnkeySignedPolicyCatalog {
  const { item } = authenticateCatalog(value, pinnedPublicKey, false);
  const now = (options.now ?? new Date()).getTime();
  const retired = new Set(options.retirePolicyIds ?? []);
  const records = (item.records as TurnkeySignedPolicyRecord[]).filter((signed) => {
    const record = authenticateTurnkeySignedPolicyRecord(signed, pinnedPublicKey);
    return !retired.has(record.providerPolicy.policyId) && now >= Date.parse(record.issuedAt) && now < Date.parse(record.expiresAt);
  });
  if (records.length === 0) throw new Error('TURNKEY_POLICY_CATALOG_PRUNE_EMPTY');
  if (records.length > 25) throw new Error('TURNKEY_POLICY_CATALOG_RETENTION_LIMIT');
  return { version: 1, context: CATALOG_CONTEXT, records };
}

export function validateTurnkeyActualProviderState(recordValue: unknown, state: TurnkeyActualProviderState, approvedRecords?: readonly unknown[]): void {
  const record = validateTurnkeyCanonicalPolicyRecord(recordValue);
  if (stableStringify(projectTurnkeyProviderIdentity(state.whoami)) !== stableStringify(record.providerIdentity)) throw new Error('TURNKEY_PROVIDER_IDENTITY_DRIFT');
  const policies = state.policies.map(projectTurnkeyProviderPolicy);
  assertNonRootRuntimeUser(state.organization, record.providerIdentity);
  const approved = approvedRecords?.map(validateTurnkeyCanonicalPolicyRecord);
  if (approved) {
    if (approved.length === 0 || !approved.some((candidate) => turnkeyPolicyRecordDigest(candidate) === turnkeyPolicyRecordDigest(record))) throw new Error('TURNKEY_PROVIDER_POLICY_CATALOG_ACTIVE_RECORD_MISSING');
    if (approved.some((candidate) => candidate.environment !== record.environment
      || stableStringify(candidate.providerIdentity) !== stableStringify(record.providerIdentity)
      || stableStringify(candidate.wallets) !== stableStringify(record.wallets))) throw new Error('TURNKEY_POLICY_CATALOG_BINDING_INVALID');
    const approvedPolicies = new Map(approved.map((candidate) => [candidate.providerPolicy.policyId, candidate.providerPolicy]));
    if (approvedPolicies.size !== approved.length) throw new Error('TURNKEY_POLICY_CATALOG_BINDING_INVALID');
    for (const policy of policies) {
      if (policy.effect !== 'EFFECT_ALLOW') continue;
      const expected = approvedPolicies.get(policy.policyId);
      if (!expected || stableStringify(policy) !== stableStringify(expected)) throw new Error('TURNKEY_PROVIDER_POLICY_NOT_APPROVED');
    }
    for (const expected of approvedPolicies.values()) {
      const matches = policies.filter((candidate) => candidate.policyId === expected.policyId);
      if (matches.length !== 1 || stableStringify(matches[0]) !== stableStringify(expected)) throw new Error('TURNKEY_PROVIDER_POLICY_DRIFT');
    }
  } else if (policies.length !== 1) throw new Error('TURNKEY_PROVIDER_POLICY_INVENTORY_NOT_ISOLATED');
  const matches = policies.filter((policy) => policy.policyId === record.providerPolicy.policyId);
  if (matches.length !== 1 || stableStringify(matches[0]) !== stableStringify(record.providerPolicy)) throw new Error('TURNKEY_PROVIDER_POLICY_DRIFT');
  const keys = state.privateKeys.map(projectTurnkeyProviderKey);
  const byId = new Map(keys.map((key) => [key.privateKeyId, key]));
  if (byId.size !== keys.length) throw new Error('TURNKEY_PROVIDER_KEY_DUPLICATE');
  for (const wallet of record.wallets) {
    const actual = byId.get(wallet.signWith);
    if (!actual || stableStringify(actual) !== stableStringify(wallet.providerKey)) throw new Error('TURNKEY_PROVIDER_KEY_DRIFT');
  }
}

function signaturePayload(value: unknown): Buffer {
  return Buffer.from(`${SIGNATURE_CONTEXT}${canonicalTurnkeyPolicyRecordJson(value)}`, 'utf8');
}

function asPublicKey(value: VerificationKey): KeyObject {
  if ((typeof value === 'string' || Buffer.isBuffer(value)) && /PRIVATE KEY/.test(value.toString())) throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  const key = value instanceof KeyObject && value.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  return key;
}

function derivePublicKey(value: VerificationKey): KeyObject {
  const key = value instanceof KeyObject && value.type === 'public' ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('TURNKEY_POLICY_APPROVER_KEY_INVALID');
  return key;
}

function providerTimestamp(value: unknown): TurnkeyProviderTimestamp {
  const item = exactRecord(value, ['seconds', 'nanos'], 'TURNKEY_PROVIDER_TIMESTAMP_INVALID');
  const seconds = requiredIntegerString(item.seconds, 'TURNKEY_PROVIDER_TIMESTAMP_INVALID');
  const nanos = requiredIntegerString(item.nanos, 'TURNKEY_PROVIDER_TIMESTAMP_INVALID');
  if (BigInt(nanos) < 0n || BigInt(nanos) > 999_999_999n) throw new Error('TURNKEY_PROVIDER_TIMESTAMP_INVALID');
  return { seconds, nanos };
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || stableStringify(Object.keys(value as object).sort()) !== stableStringify([...keys].sort())) throw new Error(code);
  return value as Record<string, unknown>;
}

function optionalExactRecord(value: unknown, required: readonly string[], optional: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const keys = Object.keys(value as object);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw new Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) throw new Error(code);
  return value;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(code);
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return stringValue(value, code);
}

function requiredIntegerString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(code);
  return value;
}

function canonicalIso(value: unknown, code: string): string {
  if (typeof value !== 'string') throw new Error(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(code);
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
