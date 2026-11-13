import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { serializeTransaction, type Address, type Hex } from 'viem';
import type { TransactionIntent } from './types.js';
import type { TurnkeySignerClient } from './turnkey-signer.js';
import { assertSignedMatchesIntent } from './pre-sign.js';

/** A separate native-transfer role. Mint-family records never authorize funding. */
export interface TurnkeyFundingRecord {
  version: 1; kind: 'native-fleet-topup-v1'; organizationId: string; mintOrganizationId: string; userId: string;
  keyId: string; policyId: string; chainId: 1 | 8453 | 4663; hub: string; recipients: string[];
  walletSetDigest: string; budgetProfileDigest: string; issuedAt: string; expiresAt: string;
  maxTransferWei: string; rollingPrincipalCapWei: string; rollingFeeCapWei: string; maxTransferFeeWei: string;
  hubMaxBalanceWei: string; recipientMaxBalanceWei: string; fleetMaxBalanceWei: string;
  gasLimitMax: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
}
export interface SignedTurnkeyFundingRecord { record: TurnkeyFundingRecord; recordDigest: string; approverKeyId: string; signature: string }
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const FIELDS = 'version kind organizationId mintOrganizationId userId keyId policyId chainId hub recipients walletSetDigest budgetProfileDigest issuedAt expiresAt maxTransferWei rollingPrincipalCapWei rollingFeeCapWei maxTransferFeeWei hubMaxBalanceWei recipientMaxBalanceWei fleetMaxBalanceWei gasLimitMax maxFeePerGas maxPriorityFeePerGas'.split(' ').sort();
const DOMAIN = 'mintbot.native-fleet-topup-v1\n';
const fail = (code: string): never => { throw new Error(`TURNKEY_FUNDING_${code}`); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail('RECORD_INVALID');
  return encoded;
}
const digest = (value: unknown) => `sha256:${createHash('sha256').update(DOMAIN + canonical(value)).digest('hex')}`;
function fundingPublicKey(pem: string) {
  if (typeof pem !== 'string' || /PRIVATE KEY/.test(pem)) return fail('PUBLIC_APPROVAL_KEY_REQUIRED');
  const key = createPublicKey(pem);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return fail('PUBLIC_APPROVAL_KEY_REQUIRED');
  return key;
}
const keyId = (pem: string) => `ed25519:${createHash('sha256').update(fundingPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex')}`;

/** Stable public bindings; no wallet ordering or address casing changes authority. */
export function turnkeyFundingWalletSetDigest(chainId: number, recipients: readonly string[]): string {
  return digest({ kind: 'funding-wallet-set-v1', chainId, recipients: recipients.map(value => value.toLowerCase()).sort() });
}
const BUDGET_FIELDS = ['maxTransferWei', 'rollingPrincipalCapWei', 'rollingFeeCapWei', 'maxTransferFeeWei', 'hubMaxBalanceWei', 'recipientMaxBalanceWei', 'fleetMaxBalanceWei', 'gasLimitMax', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
export function turnkeyFundingBudgetProfileDigest(record: Omit<TurnkeyFundingRecord, 'walletSetDigest' | 'budgetProfileDigest'>): string {
  return digest({ kind: 'funding-budget-profile-v1', chainId: record.chainId, hub: record.hub.toLowerCase(), ...Object.fromEntries(BUDGET_FIELDS.map(field => [field, record[field]])) });
}
export function createTurnkeyFundingRecord(input: Omit<TurnkeyFundingRecord, 'walletSetDigest' | 'budgetProfileDigest'>, now = new Date()): TurnkeyFundingRecord {
  return validateTurnkeyFundingRecord({ ...input, walletSetDigest: turnkeyFundingWalletSetDigest(input.chainId, input.recipients), budgetProfileDigest: turnkeyFundingBudgetProfileDigest(input) }, now);
}
export const turnkeyFundingApproverKeyId = (publicKey: string): string => keyId(publicKey);
export const turnkeyFundingRecordDigest = (record: TurnkeyFundingRecord): string => digest(record);

export function validateTurnkeyFundingRecord(input: unknown, now = new Date()): TurnkeyFundingRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join('|') !== FIELDS.join('|')) fail('RECORD_INVALID');
  const record = input as TurnkeyFundingRecord;
  if (record.version !== 1 || record.kind !== 'native-fleet-topup-v1' || ![1, 8453, 4663].includes(record.chainId)) fail('RECORD_INVALID');
  // A funding policy must not become an unrecorded ALLOW policy in the mint organisation.
  if (![record.organizationId, record.mintOrganizationId, record.userId, record.keyId, record.policyId].every(value => typeof value === 'string' && ID.test(value)) || record.organizationId === record.mintOrganizationId) fail('ISOLATED_ORGANIZATION_REQUIRED');
  if (!ADDRESS.test(record.hub) || /^0x0{40}$/i.test(record.hub) || !Array.isArray(record.recipients) || record.recipients.length < 1 || record.recipients.length > 10 || record.recipients.some(value => !ADDRESS.test(value) || value.toLowerCase() === record.hub.toLowerCase() || /^0x0{40}$/i.test(value)) || new Set(record.recipients.map(value => value.toLowerCase())).size !== record.recipients.length) fail('RECIPIENTS_INVALID');
  if (!DIGEST.test(record.walletSetDigest) || !DIGEST.test(record.budgetProfileDigest) || record.walletSetDigest !== turnkeyFundingWalletSetDigest(record.chainId, record.recipients) || record.budgetProfileDigest !== turnkeyFundingBudgetProfileDigest(record)) fail('BINDING_REQUIRED');
  const at = now.getTime(), start = Date.parse(record.issuedAt), end = Date.parse(record.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) || start > at || end <= at || end - start > 30 * 86_400_000) fail('RECORD_EXPIRED');
  const amounts = ['maxTransferWei', 'rollingPrincipalCapWei', 'rollingFeeCapWei', 'maxTransferFeeWei', 'hubMaxBalanceWei', 'recipientMaxBalanceWei', 'fleetMaxBalanceWei', 'gasLimitMax', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
  if (amounts.some(field => typeof record[field] !== 'string' || !UINT.test(record[field]) || record[field].length > 40 || BigInt(record[field]) <= 0n)) fail('BOUNDS_INVALID');
  if (BigInt(record.maxTransferWei) > 4_100_000_000_000_000n || BigInt(record.rollingPrincipalCapWei) > 8_500_000_000_000_000n || BigInt(record.rollingFeeCapWei) > 200_000_000_000_000n || BigInt(record.maxTransferFeeWei) > 20_000_000_000_000n || BigInt(record.hubMaxBalanceWei) > 8_700_000_000_000_000n || BigInt(record.recipientMaxBalanceWei) > 4_100_000_000_000_000n || BigInt(record.fleetMaxBalanceWei) > 8_500_000_000_000_000n || (record.chainId === 4663 ? BigInt(record.gasLimitMax) > 100_000n || BigInt(record.gasLimitMax) < 21_000n : BigInt(record.gasLimitMax) !== 21_000n) || BigInt(record.maxFeePerGas) > 200_000_000n || BigInt(record.maxPriorityFeePerGas) > 100_000_000n || BigInt(record.maxPriorityFeePerGas) > BigInt(record.maxFeePerGas)) fail('BOUNDS_INVALID');
  if (BigInt(record.maxTransferWei) > BigInt(record.recipientMaxBalanceWei) || BigInt(record.maxTransferWei) > BigInt(record.rollingPrincipalCapWei) || BigInt(record.maxTransferFeeWei) > BigInt(record.rollingFeeCapWei) || BigInt(record.gasLimitMax) * BigInt(record.maxFeePerGas) > BigInt(record.maxTransferFeeWei)) fail('BOUNDS_INVALID');
  return structuredClone(record);
}

export function turnkeyFundingProviderPolicy(input: TurnkeyFundingRecord) {
  const r = validateTurnkeyFundingRecord(input);
  const recipients = [...r.recipients].map(address => `'${address.toLowerCase()}'`).join(', ');
  return { effect: 'EFFECT_ALLOW', consensus: `approvers.any(user, user.id == '${r.userId}')`, condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && private_key.id == '${r.keyId}' && eth.tx.chain_id == ${r.chainId} && eth.tx.from == '${r.hub.toLowerCase()}' && eth.tx.to in [${recipients}] && eth.tx.value > 0 && eth.tx.value <= ${r.maxTransferWei} && eth.tx.data == '0x' && eth.tx.gas <= ${r.gasLimitMax} && eth.tx.max_fee_per_gas <= ${r.maxFeePerGas} && eth.tx.max_priority_fee_per_gas <= ${r.maxPriorityFeePerGas}` };
}

/** Intended for the owner's offline signing computer, never the funding worker. */
export function signTurnkeyFundingRecord(input: TurnkeyFundingRecord, approvalKey: string, now = new Date()): SignedTurnkeyFundingRecord {
  const record = validateTurnkeyFundingRecord(input, now), privateKey = createPrivateKey(approvalKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('APPROVAL_KEY_INVALID');
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return { record, recordDigest: digest(record), approverKeyId: keyId(publicPem), signature: sign(null, Buffer.from(DOMAIN + canonical(record)), privateKey).toString('base64') };
}

export function verifyTurnkeyFundingRecord(input: unknown, approvalPublicKey: string, now = new Date()): SignedTurnkeyFundingRecord {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join('|') !== ['approverKeyId', 'record', 'recordDigest', 'signature'].sort().join('|')) fail('SIGNATURE_INVALID');
  const envelope = input as SignedTurnkeyFundingRecord, record = validateTurnkeyFundingRecord(envelope.record, now);
  const key = fundingPublicKey(approvalPublicKey);
  if (key.asymmetricKeyType !== 'ed25519' || envelope.approverKeyId !== keyId(approvalPublicKey) || envelope.recordDigest !== digest(record) || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) || !verify(null, Buffer.from(DOMAIN + canonical(record)), key, Buffer.from(envelope.signature, 'base64'))) fail('SIGNATURE_INVALID');
  return structuredClone(envelope);
}

/** The worker never accepts a caller-supplied wider budget alongside a signed record. */
export function projectTurnkeyFundingPolicy(input: SignedTurnkeyFundingRecord, publicKey: string, active: boolean, now = new Date()) {
  const envelope = verifyTurnkeyFundingRecord(input, publicKey, now), r = envelope.record;
  if (typeof active !== 'boolean') fail('ACTIVATION_INVALID');
  return { kind: 'native-fleet-topup-v1' as const, active, chainId: r.chainId, hub: r.hub, recipients: [...r.recipients],
    walletSetDigest: r.walletSetDigest, recordDigest: envelope.recordDigest, budgetProfileDigest: r.budgetProfileDigest,
    policyReference: `turnkey-funding:${r.policyId}`, expiresAt: r.expiresAt, hubReserveWei: 0n,
    maxTransferWei: BigInt(r.maxTransferWei), rollingPrincipalCapWei: BigInt(r.rollingPrincipalCapWei), rollingFeeCapWei: BigInt(r.rollingFeeCapWei),
    maxTransferFeeWei: BigInt(r.maxTransferFeeWei), hubMaxBalanceWei: BigInt(r.hubMaxBalanceWei),
    recipientMaxBalanceWei: BigInt(r.recipientMaxBalanceWei), fleetMaxBalanceWei: BigInt(r.fleetMaxBalanceWei),
    gasLimitMax: BigInt(r.gasLimitMax), maxFeePerGas: BigInt(r.maxFeePerGas), maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas) };
}

/** No credentials or signatures are returned by this public comparison. */
export function assertTurnkeyFundingProviderState(records: readonly TurnkeyFundingRecord[], state: { whoami: unknown; organization: unknown; policies: unknown[]; privateKeys: unknown[] }): void {
  if (records.length < 1 || records.length > 3 || new Set(records.map(r => r.chainId)).size !== records.length || new Set(records.map(r => r.policyId)).size !== records.length) fail('CATALOG_INVALID');
  const who = state.whoami as { organizationId?: unknown; userId?: unknown } | null;
  if (!who || records.some(r => r.organizationId !== who.organizationId || r.userId !== who.userId)) fail('PROVIDER_IDENTITY_INVALID');
  if (state.policies.some(p => !p || typeof p !== 'object' || !['EFFECT_ALLOW', 'EFFECT_DENY'].includes(String((p as { effect?: unknown }).effect)))) fail('POLICY_INVENTORY_NOT_ISOLATED');
  const quorum = (state.organization as { configs?: { quorum?: { threshold?: number; userIds?: string[] } } } | null)?.configs?.quorum;
  if (!quorum || !Number.isSafeInteger(quorum.threshold) || quorum.threshold! < 1 || !Array.isArray(quorum.userIds) || !quorum.userIds.length || quorum.userIds.some(id => typeof id !== 'string') || records.some(r => quorum.userIds!.includes(r.userId))) fail('NON_ROOT_CREDENTIAL_REQUIRED');
  const allowed = state.policies.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as { effect?: unknown }).effect === 'EFFECT_ALLOW');
  if (allowed.length !== records.length) fail('POLICY_INVENTORY_NOT_ISOLATED');
  for (const record of records) {
    const p = allowed.find(p => p.policyId === record.policyId), expected = turnkeyFundingProviderPolicy(record);
    if (!p || p.effect !== expected.effect || p.consensus !== expected.consensus || p.condition !== expected.condition || p.time !== undefined && p.time !== null && p.time !== '') fail('PROVIDER_POLICY_DRIFT');
    const key = state.privateKeys.find(k => k !== null && typeof k === 'object' && (k as { privateKeyId?: unknown }).privateKeyId === record.keyId) as { curve?: unknown; isExported?: unknown; exported?: unknown; addresses?: Array<{ format?: string; address?: string }> } | undefined;
    if (!key || key.curve !== 'CURVE_SECP256K1' || key.isExported === true || key.exported === true || key.isExported !== false && key.exported !== false || !Array.isArray(key.addresses) || !key.addresses.some(a => a.format === 'ADDRESS_FORMAT_ETHEREUM' && a.address?.toLowerCase() === record.hub.toLowerCase())) fail('PROVIDER_HUB_INVALID');
  }
}

export class TurnkeyFundingSigner {
  constructor(private readonly options: { catalog: readonly SignedTurnkeyFundingRecord[]; publicKey: string; chainId: 1 | 8453 | 4663; client: TurnkeySignerClient; now?: () => Date }) {}
  public get address(): Address {
    const selected = this.options.catalog.map(record => verifyTurnkeyFundingRecord(record, this.options.publicKey, this.options.now?.() ?? new Date()).record).find(record => record.chainId === this.options.chainId);
    if (!selected) return fail('CHAIN_NOT_APPROVED');
    return selected.hub as Address;
  }
  private async current(): Promise<TurnkeyFundingRecord> {
    const records = this.options.catalog.map(record => verifyTurnkeyFundingRecord(record, this.options.publicKey, this.options.now?.() ?? new Date()).record);
    const selected = records.find(r => r.chainId === this.options.chainId);
    if (!selected) return fail('CHAIN_NOT_APPROVED');
    const client = this.options.client;
    const [whoami, organization, policies, keys] = await Promise.all([client.getWhoami({ organizationId: selected.organizationId }), client.getOrganizationConfigs({ organizationId: selected.organizationId }), client.getPolicies({ organizationId: selected.organizationId }), client.getPrivateKeys({ organizationId: selected.organizationId })]);
    assertTurnkeyFundingProviderState(records, { whoami, organization, policies: policies.policies, privateKeys: keys.privateKeys });
    validateTurnkeyFundingRecord(selected, this.options.now?.() ?? new Date());
    return selected;
  }
  async sign(intent: TransactionIntent, assertCurrent: () => Promise<void>): Promise<Hex> {
    try {
      intent = Object.freeze(structuredClone(intent));
      const r = await this.current();
      if (intent.chainId !== r.chainId || intent.from.toLowerCase() !== r.hub.toLowerCase() || !r.recipients.some(a => a.toLowerCase() === intent.to.toLowerCase()) || intent.data !== '0x' || intent.value <= 0n || intent.value > BigInt(r.maxTransferWei) || intent.gasLimit < 21_000n || intent.gasLimit > BigInt(r.gasLimitMax) || intent.maxFeePerGas > BigInt(r.maxFeePerGas) || intent.maxPriorityFeePerGas > BigInt(r.maxPriorityFeePerGas) || (intent.accessList?.length ?? 0) !== 0) fail('INTENT_OUTSIDE_POLICY');
      await assertCurrent();
      validateTurnkeyFundingRecord(r, this.options.now?.() ?? new Date());
      const unsigned = serializeTransaction({ type: 'eip1559', chainId: intent.chainId, nonce: intent.nonce, to: intent.to, value: intent.value, data: '0x', gas: intent.gasLimit, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas, accessList: [] });
      const result = await this.options.client.signTransaction({ signWith: r.keyId, unsignedTransaction: unsigned, type: 'TRANSACTION_TYPE_ETHEREUM', generateAppProofs: true });
      const raw = result.signedTransaction?.startsWith('0x') ? result.signedTransaction : `0x${result.signedTransaction}`;
      const a = result.activity, binding = a?.intent?.signTransactionIntentV2;
      const activityRaw = a?.result?.signTransactionResult?.signedTransaction;
      if (!/^0x[0-9a-f]+$/i.test(raw) || a?.organizationId !== r.organizationId || a.status !== 'ACTIVITY_STATUS_COMPLETED' || a.type !== 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' || !a.id || !a.fingerprint || binding?.signWith !== r.keyId || binding.unsignedTransaction !== unsigned || binding.type !== 'TRANSACTION_TYPE_ETHEREUM' || (activityRaw?.startsWith('0x') ? activityRaw : `0x${activityRaw}`).toLowerCase() !== raw.toLowerCase()) fail('SIGNATURE_ACTIVITY_INVALID');
      await assertSignedMatchesIntent(raw as Hex, intent);
      await this.current();
      await assertCurrent();
      return raw as Hex;
    } catch (error) {
      if (error instanceof Error && /^TURNKEY_FUNDING_[A-Z_]{3,80}$/.test(error.message)) throw error;
      throw new Error('TURNKEY_FUNDING_PROVIDER_UNAVAILABLE');
    }
  }
}
