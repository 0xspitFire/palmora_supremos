import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export type NativeFundingState = 'reserved' | 'signing' | 'signed' | 'unknown' | 'submitted' | 'settled' | 'released';
export interface NativeFundingPolicy {
  kind: 'native-fleet-topup-v1'; active: boolean; chainId: 1 | 8453 | 4663;
  hub: string; recipients: readonly string[]; walletSetDigest: string;
  recordDigest: string; budgetProfileDigest: string; policyReference: string; expiresAt: string;
  maxTransferWei: bigint; rollingPrincipalCapWei: bigint; rollingFeeCapWei: bigint;
  maxTransferFeeWei: bigint; hubMaxBalanceWei: bigint;
  hubReserveWei: bigint; recipientMaxBalanceWei: bigint; fleetMaxBalanceWei: bigint;
  gasLimitMax: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
}
export interface NativeFundingRequest {
  id: string; idempotencyKey: string; parentRunId: string; parentHoldId: string; parentHoldDigest: string;
  chainId: 1 | 8453 | 4663; recipient: string; requiredBalanceWei: bigint; expiresAt: string;
}
/** Prepared by the engine's two independent read ports, never from a user supplied balance. */
export interface NativeFundingPreparation {
  hub: string; recipientBalanceWei: bigint; fleetBalanceWei: bigint; hubBalanceWei: bigint;
  valueWei: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  l1DataFeeBoundWei: bigint; operatorFeeBoundWei: bigint; nonce: number;
  observedAt: string; blockNumber: bigint; blockHash: string; recipientCode: '0x';
}
export interface NativeFundingRecord {
  request: NativeFundingRequest; preparation: NativeFundingPreparation; policy: NativeFundingPolicy;
  state: NativeFundingState; requestDigest: string; feeBudgetWei: bigint;
  transactionHash?: string; actualPrincipalWei?: bigint; actualFeeWei?: bigint;
  createdAt: string; updatedAt: string; settledAt?: string;
  receipt?: NativeFundingReceiptObservation;
  finalityObservations?: readonly NativeFundingReceiptObservation[];
}
/** Finality is established by the injected chain-specific observer, not by a receipt's status alone. */
export interface NativeFundingReceiptObservation {
  readerHost: string; observedAt: string; chainId: number; transactionHash: string;
  from: string; to: string; valueWei: bigint; data: '0x'; nonce: number;
  blockNumber: bigint; blockHash: string; gasUsed: bigint; effectiveGasPrice: bigint;
  l1DataFeeWei: bigint; operatorFeeWei: bigint; success: boolean;
  finalityStage: 'ethereum_final'; robinhoodFinality?: 'final'; finalityEvidenceReference: string;
}
export interface NativeFundingCanonicalBlockObservation {
  readerHost: string; observedAt: string; chainId: number; blockNumber: bigint; blockHash: string;
}
export interface NativeFundingAuthority {
  /** Synchronous, runs inside the same BEGIN IMMEDIATE as every admission/pre-sign claim.
   * Must verify the canonical parent hold is reserved and matches requiredBalanceWei,
   * recipient/chain/digest, and current owner policy, chain and budget authority.
   * Implementations MUST throw on missing evidence; a no-op is not a live authority. */
  assertCurrent(request: NativeFundingRequest, policy: NativeFundingPolicy, preparation: NativeFundingPreparation): void;
  /** Canonical dependents/cost authority invalidated under the SAME reorg write lock. */
  onReorg?(record: NativeFundingRecord): void;
}

/** Owner-approved 13 November; ceilings only, never an active profile or hub selection. */
export const APPROVED_NATIVE_FUNDING_LIMITS = Object.freeze({
  rollingPrincipalCapWei: 8_500_000_000_000_000n, rollingFeeCapWei: 200_000_000_000_000n,
  maxTransferFeeWei: 20_000_000_000_000n, hubMaxBalanceWei: 8_700_000_000_000_000n,
  recipientMaxBalanceWei: 4_100_000_000_000_000n, fleetMaxBalanceWei: 8_500_000_000_000_000n,
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9_.:-]{1,180}$/;
const onlyKeys = (value: object, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const pending = (state: NativeFundingState) => state !== 'settled' && state !== 'released';
const fail = (code: string): never => { throw new Error(`NATIVE_FUNDING_${code}`); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { wei: item.toString() } : item);
const parse = <T>(value: string): T => JSON.parse(value, (_key, item: unknown) => item && typeof item === 'object' && Object.keys(item).length === 1 && 'wei' in item ? BigInt((item as { wei: string }).wei) : item) as T;
const stamp = (value: string) => { const ms = Date.parse(value); if (!Number.isFinite(ms)) fail('TIME_INVALID'); return ms; };
const fresh = (at: string, now: Date) => { const age = now.getTime() - stamp(at); if (!Number.isFinite(age) || age < 0 || age > 60_000) fail('OBSERVATION_STALE'); };

export function assertNativeFundingPolicy(policy: NativeFundingPolicy, now: Date): void {
  if (!onlyKeys(policy, ['kind', 'active', 'chainId', 'hub', 'recipients', 'walletSetDigest', 'recordDigest', 'budgetProfileDigest', 'policyReference', 'expiresAt', 'maxTransferWei', 'rollingPrincipalCapWei', 'rollingFeeCapWei', 'maxTransferFeeWei', 'hubMaxBalanceWei', 'hubReserveWei', 'recipientMaxBalanceWei', 'fleetMaxBalanceWei', 'gasLimitMax', 'maxFeePerGas', 'maxPriorityFeePerGas']) || typeof policy.policyReference !== 'string') fail('POLICY_REQUIRED');
  const amounts = [policy.maxTransferWei, policy.rollingPrincipalCapWei, policy.rollingFeeCapWei, policy.maxTransferFeeWei, policy.hubMaxBalanceWei, policy.recipientMaxBalanceWei, policy.fleetMaxBalanceWei, policy.gasLimitMax, policy.maxFeePerGas];
  if (!Number.isFinite(now.getTime()) || policy.kind !== 'native-fleet-topup-v1' || policy.active !== true || ![1, 8453, 4663].includes(policy.chainId) || !ADDRESS.test(policy.hub) || BigInt(policy.hub) === 0n || !DIGEST.test(policy.recordDigest) || !DIGEST.test(policy.walletSetDigest) || !DIGEST.test(policy.budgetProfileDigest) || !REF.test(policy.policyReference) || stamp(policy.expiresAt) <= now.getTime() || !amounts.every(value => typeof value === 'bigint' && value > 0n && value < 2n ** 256n) || typeof policy.hubReserveWei !== 'bigint' || policy.hubReserveWei < 0n || typeof policy.maxPriorityFeePerGas !== 'bigint' || policy.maxPriorityFeePerGas < 0n || policy.maxPriorityFeePerGas > policy.maxFeePerGas || !policy.recipients.length || policy.recipients.length > 100 || policy.recipients.some(value => !ADDRESS.test(value) || BigInt(value) === 0n || same(value, policy.hub)) || new Set(policy.recipients.map(value => value.toLowerCase())).size !== policy.recipients.length) fail('POLICY_REQUIRED');
  if (Object.entries(APPROVED_NATIVE_FUNDING_LIMITS).some(([key, limit]) => policy[key as keyof typeof APPROVED_NATIVE_FUNDING_LIMITS] > limit) || policy.maxTransferWei > policy.recipientMaxBalanceWei) fail('POLICY_EXCEEDS_APPROVED_LIMITS');
}

export const NATIVE_FUNDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS native_funding (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id IN (1,8453,4663)), hub TEXT NOT NULL, recipient TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK(nonce >= 0), parent_hold_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','signing','signed','unknown','submitted','settled','released')),
  principal_wei TEXT NOT NULL, fee_budget_wei TEXT NOT NULL, payload_json TEXT NOT NULL,
  transaction_hash TEXT, actual_principal_wei TEXT, actual_fee_wei TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT, receipt_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS native_funding_live_nonce ON native_funding(chain_id,hub,nonce) WHERE state <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS native_funding_parent_recipient ON native_funding(parent_hold_id,chain_id,recipient) WHERE state <> 'released';
CREATE TABLE IF NOT EXISTS native_funding_clock (id INTEGER PRIMARY KEY CHECK(id=1), admitted_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS native_funding_identity_immutable BEFORE UPDATE OF id,idempotency_key,request_digest,chain_id,hub,recipient,nonce,parent_hold_id,principal_wei,fee_budget_wei,payload_json,created_at ON native_funding
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_no_delete BEFORE DELETE ON native_funding
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_hash_immutable BEFORE UPDATE OF transaction_hash ON native_funding
WHEN OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS NOT OLD.transaction_hash
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_HASH_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_state_guard BEFORE UPDATE OF state ON native_funding
WHEN NOT (OLD.state=NEW.state OR OLD.state='reserved' AND NEW.state IN ('signing','released') OR OLD.state='signing' AND NEW.state IN ('signed','unknown') OR OLD.state='signed' AND NEW.state IN ('unknown','settled') OR OLD.state='unknown' AND NEW.state IN ('submitted','settled') OR OLD.state='submitted' AND NEW.state IN ('unknown','settled') OR OLD.state='settled' AND NEW.state='unknown')
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_STATE_INVALID'); END;
`;

/** Explicit initializer only; constructors never alter a database. Root migration owns production installation. */
export function initializeNativeFundingRepository(db: SqliteDatabase): void {
  if (db.inTransaction) fail('TRANSACTION_REQUIRED');
  db.transaction(() => db.exec(NATIVE_FUNDING_SCHEMA_SQL)).immediate();
}
interface Row {
  id: string; state: NativeFundingState; payload_json: string; request_digest: string; principal_wei: string; fee_budget_wei: string;
  transaction_hash: string | null; actual_principal_wei: string | null; actual_fee_wei: string | null;
  created_at: string; updated_at: string; settled_at: string | null; receipt_json: string | null;
}

export class NativeFundingRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly authority: NativeFundingAuthority) {}

  public get(id: string): NativeFundingRecord | undefined {
    const row = this.db.prepare('SELECT * FROM native_funding WHERE id=?').get(id) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  public admit(request: NativeFundingRequest, preparation: NativeFundingPreparation, policy: NativeFundingPolicy, now: Date): NativeFundingRecord {
    request = structuredClone(request); preparation = structuredClone(preparation); policy = structuredClone(policy);
    assertNativeFundingPolicy(policy, now);
    const { recipient } = request;
    if (!onlyKeys(request, ['id', 'idempotencyKey', 'parentRunId', 'parentHoldId', 'parentHoldDigest', 'chainId', 'recipient', 'requiredBalanceWei', 'expiresAt']) || ![request.id, request.idempotencyKey, request.parentRunId, request.parentHoldId].every(value => typeof value === 'string' && REF.test(value)) || !DIGEST.test(request.parentHoldDigest) || !ADDRESS.test(recipient) || request.chainId !== policy.chainId || !policy.recipients.some(value => same(value, recipient)) || typeof request.requiredBalanceWei !== 'bigint' || request.requiredBalanceWei <= 0n || request.requiredBalanceWei > policy.recipientMaxBalanceWei || stamp(request.expiresAt) <= now.getTime()) fail('REQUEST_INVALID');
    if (!onlyKeys(preparation, ['hub', 'recipientBalanceWei', 'fleetBalanceWei', 'hubBalanceWei', 'valueWei', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'l1DataFeeBoundWei', 'operatorFeeBoundWei', 'nonce', 'observedAt', 'blockNumber', 'blockHash', 'recipientCode'])) fail('PREPARATION_INVALID');
    const normalizedRequest = { ...request, recipient: recipient.toLowerCase() };
    const requestDigest = `sha256:${createHash('sha256').update(json(normalizedRequest)).digest('hex')}`;
    return this.atomic(() => {
      this.assertCurrent(normalizedRequest, policy, preparation);
      const existing = this.db.prepare('SELECT * FROM native_funding WHERE idempotency_key=? OR id=?').all(request.idempotencyKey, request.id) as Row[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0]!.id !== request.id || existing[0]!.request_digest !== requestDigest) fail('IDEMPOTENCY_CONFLICT');
        return this.decode(existing[0]!);
      }
      fresh(preparation.observedAt, now);
      const bounds = [preparation.valueWei, preparation.gasLimit, preparation.maxFeePerGas, preparation.recipientBalanceWei, preparation.fleetBalanceWei, preparation.hubBalanceWei, preparation.l1DataFeeBoundWei, preparation.operatorFeeBoundWei];
      if (!bounds.every(value => typeof value === 'bigint' && value >= 0n) || !same(preparation.hub, policy.hub) || preparation.recipientCode !== '0x' || !Number.isSafeInteger(preparation.nonce) || preparation.nonce < 0 || preparation.valueWei <= 0n || preparation.valueWei > policy.maxTransferWei || preparation.valueWei !== request.requiredBalanceWei - preparation.recipientBalanceWei || preparation.gasLimit <= 0n || preparation.gasLimit > policy.gasLimitMax || preparation.maxFeePerGas <= 0n || preparation.maxFeePerGas > policy.maxFeePerGas || preparation.maxPriorityFeePerGas < 0n || preparation.maxPriorityFeePerGas > preparation.maxFeePerGas || preparation.maxPriorityFeePerGas > policy.maxPriorityFeePerGas || typeof preparation.blockNumber !== 'bigint' || preparation.blockNumber < 0n || !HASH.test(preparation.blockHash)) fail('PREPARATION_INVALID');
      const feeBudgetWei = preparation.gasLimit * preparation.maxFeePerGas + preparation.l1DataFeeBoundWei + preparation.operatorFeeBoundWei;
      if (feeBudgetWei > policy.maxTransferFeeWei || preparation.hubBalanceWei > policy.hubMaxBalanceWei || preparation.fleetBalanceWei < preparation.recipientBalanceWei) fail('FUNDING_ENVELOPE_EXCEEDED');
      const time = now.toISOString();
      const watermark = this.db.prepare('SELECT admitted_at FROM native_funding_clock WHERE id=1').get() as { admitted_at: string } | undefined;
      if (watermark && stamp(watermark.admitted_at) - now.getTime() > 5_000) fail('CLOCK_ROLLBACK');
      const rows = (this.db.prepare('SELECT * FROM native_funding WHERE chain_id=?').all(policy.chainId) as Row[]).map(row => this.decode(row));
      if (rows.some(row => pending(row.state) && now.getTime() - stamp(row.createdAt) >= 86_400_000)) fail('STALE_PENDING');
      const counted = rows.filter(row => pending(row.state) || row.state === 'settled' && (!row.settledAt || stamp(row.settledAt) >= now.getTime() - 86_400_000));
      const principal = counted.reduce((sum, row) => sum + (pending(row.state) ? row.preparation.valueWei : row.actualPrincipalWei ?? row.preparation.valueWei), 0n);
      const fee = counted.reduce((sum, row) => sum + (pending(row.state) ? row.feeBudgetWei : row.actualFeeWei ?? row.feeBudgetWei), 0n);
      if (principal + preparation.valueWei > policy.rollingPrincipalCapWei || fee + feeBudgetWei > policy.rollingFeeCapWei) fail('ROLLING_CAP_EXCEEDED');
      const inflight = rows.filter(row => pending(row.state));
      const incoming = inflight.filter(row => same(row.request.recipient, recipient)).reduce((sum, row) => sum + row.preparation.valueWei, 0n);
      const fleetIncoming = inflight.reduce((sum, row) => sum + row.preparation.valueWei, 0n);
      // An exact shortfall cannot be sent twice while the first arrival is unknown.
      if (incoming > 0n) fail('RECIPIENT_FUNDING_PENDING');
      if (preparation.recipientBalanceWei + incoming + preparation.valueWei > policy.recipientMaxBalanceWei || preparation.fleetBalanceWei + fleetIncoming + preparation.valueWei > policy.fleetMaxBalanceWei) fail('BALANCE_CEILING');
      const hubReserved = inflight.filter(row => same(row.preparation.hub, policy.hub)).reduce((sum, row) => sum + row.preparation.valueWei + row.feeBudgetWei, 0n);
      if (preparation.hubBalanceWei < hubReserved + preparation.valueWei + feeBudgetWei + policy.hubReserveWei) fail('HUB_BALANCE_REQUIRED');
      if (this.db.prepare("SELECT 1 FROM native_funding WHERE chain_id=? AND hub=? AND nonce=? AND state<>'released'").get(policy.chainId, policy.hub.toLowerCase(), preparation.nonce)) fail('NONCE_BUSY');
      if (this.db.prepare("SELECT 1 FROM native_funding WHERE parent_hold_id=? AND chain_id=? AND recipient=? AND state<>'released'").get(request.parentHoldId, policy.chainId, recipient.toLowerCase())) fail('PARENT_ALREADY_FUNDED');
      this.db.prepare('INSERT INTO native_funding(id,idempotency_key,request_digest,chain_id,hub,recipient,nonce,parent_hold_id,state,principal_wei,fee_budget_wei,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(request.id, request.idempotencyKey, requestDigest, policy.chainId, policy.hub.toLowerCase(), recipient.toLowerCase(), preparation.nonce, request.parentHoldId, 'reserved', preparation.valueWei.toString(), feeBudgetWei.toString(), json({ request: normalizedRequest, preparation, policy }), time, time);
      this.db.prepare('INSERT INTO native_funding_clock(id,admitted_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET admitted_at=CASE WHEN excluded.admitted_at>admitted_at THEN excluded.admitted_at ELSE admitted_at END').run(time);
      return this.required(request.id);
    });
  }

  public claimForSigning(id: string, now: Date): NativeFundingRecord {
    return this.atomic(() => {
      const row = this.required(id);
      assertNativeFundingPolicy(row.policy, now); this.assertCurrent(row.request, row.policy, row.preparation);
      if (stamp(row.request.expiresAt) <= now.getTime()) fail('REQUEST_EXPIRED');
      fresh(row.preparation.observedAt, now);
      if (row.state !== 'reserved') fail('ALREADY_STARTED');
      this.db.prepare("UPDATE native_funding SET state='signing',updated_at=? WHERE id=? AND state='reserved'").run(now.toISOString(), id);
      return this.required(id);
    });
  }

  public reconfirm(id: string, now: Date): void {
    this.atomic(() => {
      const row = this.required(id);
      assertNativeFundingPolicy(row.policy, now); this.assertCurrent(row.request, row.policy, row.preparation);
      if (!['reserved', 'signing', 'signed', 'unknown'].includes(row.state) || row.state === 'unknown' && !row.transactionHash || stamp(row.request.expiresAt) <= now.getTime()) fail('NOT_SIGNABLE');
      fresh(row.preparation.observedAt, now);
    });
  }

  public markSigned(id: string, hash: string, now: Date): void {
    if (!HASH.test(hash)) fail('HASH_INVALID');
    this.atomic(() => {
      const row = this.required(id);
      if (row.state !== 'signing') fail('STATE_INVALID');
      this.db.prepare("UPDATE native_funding SET state='signed',transaction_hash=?,updated_at=? WHERE id=?").run(hash.toLowerCase(), now.toISOString(), id);
    });
  }

  /** Durable ambiguity marker BEFORE the network call. No provider error can release it. */
  public markBroadcasting(id: string, now: Date): void { this.change(id, ['signed'], 'unknown', now); }
  public markSubmitted(id: string, hash: string, now: Date): void {
    const row = this.required(id);
    if (!row.transactionHash || !same(row.transactionHash, hash)) fail('HASH_MISMATCH');
    this.change(id, ['unknown'], 'submitted', now);
  }
  public retainUnknown(id: string, now: Date): void { this.change(id, ['signing', 'signed', 'submitted', 'unknown'], 'unknown', now); }
  public releaseUnstarted(id: string, now: Date): void { this.change(id, ['reserved'], 'released', now); }

  public settle(id: string, observations: readonly NativeFundingReceiptObservation[], now: Date): NativeFundingRecord {
    return this.atomic(() => {
      const row = this.required(id);
      if (!row.transactionHash || !['signed', 'submitted', 'unknown', 'settled'].includes(row.state) || observations.length !== 2 || observations[0] === observations[1]) fail('FINAL_RECEIPT_REQUIRED');
      const receipt = observations[0]!;
      const host = (value: string) => /^[a-z0-9.-]{1,253}$/i.test(value) && !value.startsWith('.') && value.toLowerCase().replace(/\.$/, '');
      if (!host(receipt.readerHost) || !host(observations[1]!.readerHost) || host(receipt.readerHost) === host(observations[1]!.readerHost)) fail('INDEPENDENT_READERS_REQUIRED');
      const comparable = ({ readerHost: _host, observedAt: _at, finalityEvidenceReference: _ref, ...rest }: NativeFundingReceiptObservation) => json(rest);
      if (comparable(receipt) !== comparable(observations[1]!)) fail('RECEIPT_DISAGREEMENT');
      for (const item of observations) {
        fresh(item.observedAt, now);
        if (!onlyKeys(item, ['readerHost', 'observedAt', 'chainId', 'transactionHash', 'from', 'to', 'valueWei', 'data', 'nonce', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice', 'l1DataFeeWei', 'operatorFeeWei', 'success', 'finalityStage', 'robinhoodFinality', 'finalityEvidenceReference']) || typeof item.finalityEvidenceReference !== 'string' || !REF.test(item.finalityEvidenceReference) || item.finalityStage !== 'ethereum_final' || row.request.chainId === 4663 && item.robinhoodFinality !== 'final') fail('FINAL_RECEIPT_REQUIRED');
      }
      if (receipt.chainId !== row.request.chainId || !same(receipt.transactionHash, row.transactionHash!) || !same(receipt.from, row.preparation.hub) || !same(receipt.to, row.request.recipient) || receipt.nonce !== row.preparation.nonce || receipt.data !== '0x' || receipt.valueWei !== row.preparation.valueWei || typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber < 0n || !HASH.test(receipt.blockHash) || typeof receipt.success !== 'boolean' || ![receipt.gasUsed, receipt.effectiveGasPrice, receipt.l1DataFeeWei, receipt.operatorFeeWei].every(value => typeof value === 'bigint' && value >= 0n) || receipt.gasUsed > row.preparation.gasLimit || receipt.effectiveGasPrice > row.preparation.maxFeePerGas || receipt.l1DataFeeWei > row.preparation.l1DataFeeBoundWei || receipt.operatorFeeWei > row.preparation.operatorFeeBoundWei) fail('RECEIPT_INVALID');
      const principal = receipt.success ? row.preparation.valueWei : 0n;
      const fee = receipt.gasUsed * receipt.effectiveGasPrice + receipt.l1DataFeeWei + receipt.operatorFeeWei;
      if (fee > row.feeBudgetWei) fail('FEE_EXCEEDS_RESERVATION');
      if (row.state === 'settled') {
        if (row.actualPrincipalWei !== principal || row.actualFeeWei !== fee || !row.receipt || comparable(row.receipt) !== comparable(receipt)) fail('SETTLEMENT_CONFLICT');
        return row;
      }
      this.db.prepare("UPDATE native_funding SET state='settled',actual_principal_wei=?,actual_fee_wei=?,settled_at=?,updated_at=?,receipt_json=? WHERE id=?").run(principal.toString(), fee.toString(), now.toISOString(), now.toISOString(), json({ observations }), id);
      return this.required(id);
    });
  }

  /** Two canonical block hashes, not an absent receipt, prove that settled exposure must reopen. */
  public reopenAfterReorg(id: string, observations: readonly NativeFundingCanonicalBlockObservation[], now: Date): NativeFundingRecord {
    return this.atomic(() => {
      const row = this.required(id);
      if (row.state !== 'settled' || !row.receipt || observations.length !== 2 || observations[0] === observations[1]) fail('REORG_PROOF_REQUIRED');
      const [first, second] = observations;
      if (!first || !second || !/^[a-z0-9.-]+$/i.test(first.readerHost) || !/^[a-z0-9.-]+$/i.test(second.readerHost) || same(first.readerHost.replace(/\.$/, ''), second.readerHost.replace(/\.$/, ''))) fail('INDEPENDENT_READERS_REQUIRED');
      for (const item of observations) {
        fresh(item.observedAt, now);
        if (item.chainId !== row.request.chainId || item.blockNumber !== row.receipt!.blockNumber || !HASH.test(item.blockHash) || same(item.blockHash, row.receipt!.blockHash)) fail('REORG_PROOF_REQUIRED');
      }
      if (!same(first!.blockHash, second!.blockHash)) fail('RECEIPT_DISAGREEMENT');
      this.db.prepare("UPDATE native_funding SET state='unknown',actual_principal_wei=NULL,actual_fee_wei=NULL,settled_at=NULL,updated_at=? WHERE id=?").run(now.toISOString(), id);
      const reopened = this.required(id); this.authority.onReorg?.(structuredClone(reopened));
      return reopened;
    });
  }

  private assertCurrent(request: NativeFundingRequest, policy: NativeFundingPolicy, preparation: NativeFundingPreparation): void {
    const control = this.db.prepare("SELECT kill_switch_engaged FROM runtime_control WHERE id='global'").get() as { kill_switch_engaged: number } | undefined;
    if (!control || control.kill_switch_engaged !== 0) fail('KILLED');
    if (!this.authority || typeof this.authority.assertCurrent !== 'function') fail('CANONICAL_AUTHORITY_REQUIRED');
    this.authority.assertCurrent(structuredClone(request), structuredClone(policy), structuredClone(preparation));
  }
  private required(id: string): NativeFundingRecord { return this.get(id) ?? fail('NOT_FOUND'); }
  private decode(row: Row): NativeFundingRecord {
    const proof = row.receipt_json ? parse<{ observations: NativeFundingReceiptObservation[] }>(row.receipt_json) : undefined;
    return { ...parse<Pick<NativeFundingRecord, 'request' | 'preparation' | 'policy'>>(row.payload_json), state: row.state, requestDigest: row.request_digest, feeBudgetWei: BigInt(row.fee_budget_wei), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}), ...(row.actual_principal_wei !== null ? { actualPrincipalWei: BigInt(row.actual_principal_wei) } : {}), ...(row.actual_fee_wei !== null ? { actualFeeWei: BigInt(row.actual_fee_wei) } : {}), ...(row.settled_at ? { settledAt: row.settled_at } : {}), ...(proof ? { receipt: proof.observations[0], finalityObservations: proof.observations } : {}) };
  }
  private change(id: string, from: readonly NativeFundingState[], state: NativeFundingState, now: Date): void {
    this.atomic(() => { if (!from.includes(this.required(id).state)) fail('STATE_INVALID'); this.db.prepare('UPDATE native_funding SET state=?,updated_at=? WHERE id=?').run(state, now.toISOString(), id); });
  }
  private atomic<T>(operation: () => T): T {
    if (this.db.inTransaction) fail('NESTED_TRANSACTION');
    return this.db.transaction(operation).immediate();
  }
}
