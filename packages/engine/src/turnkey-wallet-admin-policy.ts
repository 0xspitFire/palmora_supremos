import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { projectTurnkeyProviderPolicy, turnkeyPolicyApproverKeyId, type TurnkeyProviderPolicyProjection } from './turnkey-policy-record.js';
import type { TurnkeyEnvironment } from './turnkey-policy.js';

const CONTEXT = 'mintbot.turnkey-wallet-admin-policy-record/v1' as const;
const SIGNATURE_CONTEXT = 'mintbot.turnkey-wallet-admin-policy-record/signature/v1\0';
const MAX_LIFETIME_MS = 30 * 86_400_000;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const verifiedRecords = new WeakSet<object>();
type Key = KeyObject | string | Buffer;

export const TURNKEY_WALLET_ADMIN_ACTIVITIES = Object.freeze([
  'ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2', 'ACTIVITY_TYPE_INIT_IMPORT_PRIVATE_KEY', 'ACTIVITY_TYPE_IMPORT_PRIVATE_KEY',
] as const);
export interface TurnkeyWalletAdminPolicyRecord {
  readonly version: 1; readonly context: typeof CONTEXT; readonly environment: TurnkeyEnvironment;
  readonly organizationId: string; readonly adminUserId: string; readonly mintRuntimeUserId: string;
  readonly policyId: string; readonly consensus: string; readonly condition: string;
  readonly providerPolicy: TurnkeyProviderPolicyProjection;
  readonly issuedAt: string; readonly expiresAt: string;
}
export interface TurnkeySignedWalletAdminPolicyRecord {
  readonly version: 1; readonly algorithm: 'Ed25519'; readonly keyId: string;
  readonly recordDigest: `sha256:${string}`; readonly record: TurnkeyWalletAdminPolicyRecord; readonly signature: string;
}
/** Runtime provenance is maintained by a WeakSet, not a serializable flag callers can forge. */
export type VerifiedTurnkeyWalletAdminPolicyRecord = TurnkeyWalletAdminPolicyRecord;

const fail = (code: string): never => { throw new Error(`TURNKEY_WALLET_ADMIN_${code}`); };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('RECORD_INVALID');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail('RECORD_INVALID'); return value as string; }
function iso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('RECORD_INVALID');
  return value as string;
}

/** No caller-supplied DSL or consensus is accepted by this builder. */
export function turnkeyWalletAdminPolicyExpressions(input: { adminUserId: string }): { effect: 'EFFECT_ALLOW'; consensus: string; condition: string } {
  const admin = identifier(input.adminUserId);
  return {
    effect: 'EFFECT_ALLOW', consensus: `approvers.any(user, user.id == '${admin}')`,
    condition: `activity.type in [${TURNKEY_WALLET_ADMIN_ACTIVITIES.map(activity => `'${activity}'`).join(', ')}]`,
  };
}

export function validateTurnkeyWalletAdminPolicyRecord(value: unknown): TurnkeyWalletAdminPolicyRecord {
  const item = object(value, ['version', 'context', 'environment', 'organizationId', 'adminUserId', 'mintRuntimeUserId', 'policyId', 'consensus', 'condition', 'providerPolicy', 'issuedAt', 'expiresAt']);
  if (item.version !== 1 || item.context !== CONTEXT || item.environment !== 'production' && item.environment !== 'testnet') fail('RECORD_INVALID');
  const organizationId = identifier(item.organizationId); const adminUserId = identifier(item.adminUserId);
  const mintRuntimeUserId = identifier(item.mintRuntimeUserId); const policyId = identifier(item.policyId);
  if (adminUserId === mintRuntimeUserId) fail('DISTINCT_USER_REQUIRED');
  const expressions = turnkeyWalletAdminPolicyExpressions({ adminUserId });
  const providerPolicy = projectTurnkeyProviderPolicy(item.providerPolicy);
  if (providerPolicy.policyId !== policyId || providerPolicy.effect !== 'EFFECT_ALLOW' || providerPolicy.consensus !== expressions.consensus || providerPolicy.condition !== expressions.condition || providerPolicy.time !== null || item.consensus !== expressions.consensus || item.condition !== expressions.condition) fail('NON_SIGNING_POLICY_REQUIRED');
  const issuedAt = iso(item.issuedAt); const expiresAt = iso(item.expiresAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_MS) fail('LIFETIME_INVALID');
  return { version: 1, context: CONTEXT, environment: item.environment as TurnkeyEnvironment, organizationId, adminUserId, mintRuntimeUserId, policyId, consensus: expressions.consensus, condition: expressions.condition, providerPolicy, issuedAt, expiresAt };
}

export function createTurnkeyWalletAdminPolicyRecord(input: {
  environment: TurnkeyEnvironment; organizationId: string; adminUserId: string; mintRuntimeUserId: string;
  providerPolicy: unknown; issuedAt: string; expiresAt: string;
}): TurnkeyWalletAdminPolicyRecord {
  const providerPolicy = projectTurnkeyProviderPolicy(input.providerPolicy);
  const expressions = turnkeyWalletAdminPolicyExpressions(input);
  return validateTurnkeyWalletAdminPolicyRecord({ version: 1, context: CONTEXT, ...input, policyId: providerPolicy.policyId, consensus: expressions.consensus, condition: expressions.condition, providerPolicy });
}
function payload(value: unknown): Buffer { return Buffer.from(`${SIGNATURE_CONTEXT}${canonical(validateTurnkeyWalletAdminPolicyRecord(value))}`, 'utf8'); }
export function turnkeyWalletAdminPolicyRecordDigest(value: unknown): `sha256:${string}` { return `sha256:${createHash('sha256').update(payload(value)).digest('hex')}`; }
export function signTurnkeyWalletAdminPolicyRecord(value: unknown, privateKey: Key): TurnkeySignedWalletAdminPolicyRecord {
  const record = validateTurnkeyWalletAdminPolicyRecord(value);
  const publicKey = privateKey instanceof KeyObject && privateKey.type === 'public' ? privateKey : createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('APPROVER_KEY_INVALID');
  return { version: 1, algorithm: 'Ed25519', keyId: turnkeyPolicyApproverKeyId(publicKey), recordDigest: turnkeyWalletAdminPolicyRecordDigest(record), record, signature: sign(null, payload(record), privateKey).toString('base64url') };
}

export function verifyTurnkeyWalletAdminPolicyRecord(value: unknown, pinnedPublicKey: Key, now = new Date()): VerifiedTurnkeyWalletAdminPolicyRecord {
  if (pinnedPublicKey instanceof KeyObject && pinnedPublicKey.type !== 'public' || (typeof pinnedPublicKey === 'string' || Buffer.isBuffer(pinnedPublicKey)) && /PRIVATE KEY/.test(pinnedPublicKey.toString())) fail('APPROVER_KEY_INVALID');
  let publicKey: KeyObject;
  try { publicKey = pinnedPublicKey instanceof KeyObject ? pinnedPublicKey : createPublicKey(pinnedPublicKey); } catch { fail('APPROVER_KEY_INVALID'); }
  if (publicKey!.asymmetricKeyType !== 'ed25519') fail('APPROVER_KEY_INVALID');
  const envelope = object(value, ['version', 'algorithm', 'keyId', 'recordDigest', 'record', 'signature']);
  if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519' || envelope.keyId !== turnkeyPolicyApproverKeyId(publicKey!) || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) fail('SIGNATURE_INVALID');
  const record = validateTurnkeyWalletAdminPolicyRecord(envelope.record);
  if (envelope.recordDigest !== turnkeyWalletAdminPolicyRecordDigest(record)) fail('DIGEST_MISMATCH');
  const signature = Buffer.from(envelope.signature as string, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== envelope.signature || !verify(null, payload(record), publicKey!, signature)) fail('SIGNATURE_INVALID');
  assertCurrentTime(record, now);
  Object.freeze(record.providerPolicy.createdAt); Object.freeze(record.providerPolicy.updatedAt); Object.freeze(record.providerPolicy); Object.freeze(record);
  verifiedRecords.add(record);
  return record;
}
function assertCurrentTime(record: TurnkeyWalletAdminPolicyRecord, now: Date): void {
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(record.issuedAt) || now.getTime() >= Date.parse(record.expiresAt)) fail('RECORD_NOT_CURRENT');
}
export function assertTurnkeyWalletAdminRecordCurrent(record: VerifiedTurnkeyWalletAdminPolicyRecord, now = new Date()): void {
  if (!verifiedRecords.has(record)) fail('SIGNATURE_VERIFICATION_REQUIRED');
  assertCurrentTime(record, now);
}

/** Exact metadata/DSL/time match; cosmetic edits also need a fresh owner-signed record. */
export function assertTurnkeyWalletAdminProviderState(record: VerifiedTurnkeyWalletAdminPolicyRecord, state: {
  organizationId: string; adminUserId: string; mintRuntimeUserId?: string; environment?: TurnkeyEnvironment;
  organization: unknown; policies: readonly unknown[];
}, now = new Date()): void {
  assertTurnkeyWalletAdminRecordCurrent(record, now);
  if (state.organizationId !== record.organizationId || state.adminUserId !== record.adminUserId || state.mintRuntimeUserId !== undefined && state.mintRuntimeUserId !== record.mintRuntimeUserId || state.environment !== undefined && state.environment !== record.environment) fail('BINDING_INVALID');
  const org = state.organization as { configs?: { quorum?: { threshold?: unknown; userIds?: unknown } } } | undefined;
  const quorum = org?.configs?.quorum;
  if (!quorum || !Number.isSafeInteger(quorum.threshold) || Number(quorum.threshold) < 1 || !Array.isArray(quorum.userIds) || !quorum.userIds.length || !quorum.userIds.every(id => typeof id === 'string' && ID.test(id))) fail('ORGANIZATION_INVALID');
  const rootUsers = quorum!.userIds as string[];
  if (rootUsers.includes(record.adminUserId) || rootUsers.includes(record.mintRuntimeUserId)) fail('NON_ROOT_USER_REQUIRED');
  const policies = state.policies.map(projectTurnkeyProviderPolicy);
  const matches = policies.filter(policy => policy.policyId === record.policyId);
  if (matches.length !== 1 || canonical(matches[0]) !== canonical(record.providerPolicy)) fail('PROVIDER_POLICY_DRIFT');
  const mintOnlyConsensus = `approvers.any(user, user.id == '${record.mintRuntimeUserId}')`;
  if (policies.some(policy => policy.effect === 'EFFECT_ALLOW' && policy.policyId !== record.policyId && policy.consensus !== mintOnlyConsensus)) fail('PROVIDER_POLICY_NOT_APPROVED');
}
