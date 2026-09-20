import type { SqliteDatabase } from './database.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Phase2Repository } from './phase2.js';
import type { AlertDeliveryRecord, AlertRecord, DomainEventRecord, FinalityObservationRecord, FreshnessObservationRecord, JobRecord, OpportunityEvidenceRecord, OpportunityGateCheckRecord, OpportunityRecord, OpportunityRiskRecord, OpportunityScoreRecord, ProvenanceRecord, ReadinessSnapshotRecord, SpendSummaryRecord, TrackedWalletRecord, WalletBalanceRecord, WalletMetadataRecord } from './phase2.js';
export type { AlertDeliveryRecord, AlertRecord, DomainEventRecord, FinalityObservationRecord, FreshnessObservationRecord, JobRecord, JobState, OpportunityEvidenceRecord, OpportunityGateCheckRecord, OpportunityRecord, OpportunityRiskRecord, OpportunityScoreRecord, ProvenanceRecord, ReadinessCheckRecord, ReadinessSnapshotRecord, SpendSummaryRecord, TrackedWalletRecord, WalletBalanceRecord, WalletMetadataRecord } from './phase2.js';

export class IdempotencyConflictError extends Error {
  public constructor() { super('idempotency key was reused with a different request fingerprint'); }
}

export interface ExecutionRunRecord {
  id: string;
  requestId: string;
  requestFingerprint?: string;
  requestPayload?: unknown;
  campaignId?: string;
  state: 'prepared' | 'active' | 'recovering' | 'completed' | 'failed' | 'aborted' | 'cancelled';
  actor?: string;
  source?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionIntentRecord {
  id: string;
  campaignId: string;
  walletId: string;
  intentClass: string;
  toAddress: string;
  valueWei: bigint;
  calldata: string;
  nonce?: number;
  chainProfileId?: string;
  fromAddress?: string;
  gasLimitWei?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
  idempotencyKey?: string;
  requestId?: string;
  requestFingerprint?: string;
  runId?: string;
  policySnapshot?: unknown;
  createdAt: string;
}

export interface TransactionAttemptRecord {
  id: string;
  transactionIntentId: string;
  endpoint: string;
  responseClass: string;
  latencyMs?: number;
  txHash?: string;
  nonce?: number;
  replacementOfId?: string;
  redactedError?: string;
  executionId?: string;
  attemptedAt: string;
}

export interface SimulationRecord {
  id: string;
  walletId: string;
  campaignId: string;
  transactionIntentId?: string;
  sourceBlockNumber: number;
  sourceBlockHash?: string;
  checkedAt: string;
  freshnessSeconds: number;
  outcome: 'pass' | 'fail' | 'unknown';
  revertTaxonomy?: string;
  toolVersion: string;
  details?: unknown;
}

export interface ExecutionRecord {
  id: string;
  campaignId: string;
  walletId: string;
  transactionIntentId: string;
  state: string;
  runId?: string;
  requestId?: string;
  requestFingerprint?: string;
  reservationId?: string;
  errorCode?: string;
  errorReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptRecord {
  id: string;
  transactionAttemptId: string;
  txHash: string;
  status: 'pending' | 'confirmed' | 'reverted' | 'reorged' | 'dropped';
  blockNumber?: number;
  blockHash?: string;
  confirmations: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  finalityStage?: 'unknown' | 'soft' | 'posted' | 'ethereum_final';
  finalitySource?: string;
  executionId?: string;
  observedAt: string;
}

export interface LifecycleEventRecord {
  id: string;
  entityType: string;
  entityId: string;
  priorState?: string;
  newState: string;
  actor: string;
  source: string;
  reason: string;
  policyVersion?: string;
  evidenceSnapshot?: unknown;
  occurredAt: string;
}

export interface AuditEventRecord {
  id: string;
  entityType: string;
  entityId: string;
  priorState?: string;
  newState?: string;
  actor: string;
  reason: string;
  evidenceSnapshot?: unknown;
  policySnapshot?: unknown;
  occurredAt: string;
}

export interface ChainVerificationRecord {
  id: string;
  chainProfileId: string;
  status: 'unverified' | 'characterization_pending' | 'verified' | 'execution_blocked';
  chainId: number;
  sequencerEndpointReference?: string;
  archiveEndpointReference?: string;
  feedEndpointReference?: string;
  seaDropTestTxHash?: string;
  evidence?: unknown;
  checkedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  executionEnabled?: boolean;
}

export interface ReorgEventRecord {
  id: string;
  chainProfileId: string;
  transactionAttemptId?: string;
  executionId?: string;
  oldBlockHash?: string;
  newBlockHash?: string;
  previousFinalityStage: 'unknown' | 'soft' | 'posted' | 'ethereum_final';
  newFinalityStage: 'unknown' | 'soft' | 'posted' | 'ethereum_final';
  detectedAt: string;
  evidence?: unknown;
}

export interface ReorgResolutionRecord {
  id: string;
  reorgEventId: string;
  state: 'open' | 'resolved';
  replacementExecutionId?: string;
  reason: string;
  resolvedAt: string;
}

export interface ReconciliationRecord {
  id: string;
  chainProfileId: string;
  transactionAttemptId?: string;
  txHash?: string;
  fromAddress?: string;
  nonce?: number;
  state: 'unresolved' | 'matched' | 'ambiguous' | 'reorged' | 'final';
  checkedAt: string;
  source: string;
  policyVersion?: string;
  details?: unknown;
  executionId?: string;
}

export interface FeePolicyRecord {
  id: string;
  chainProfileId: string;
  version: string;
  priorityFeeSemantics: 'ordering' | 'fee_only';
  maxTotalFeeWei: bigint;
  freeMintTotalFeeCapWei: bigint;
  freeMintPriorityFeeComponentWei?: bigint;
  freeMintPriorityFeeMultiplier?: number;
  paidMintsEnabled?: boolean;
  zeroPriorityFeePolicy?: 'requires_po_resolution' | 'blocked' | 'allowed';
  active: boolean;
  createdAt: string;
}

export interface BackupPolicyRecord {
  id: string;
  retentionDays?: number;
  approvalOwner: string;
  approvedAt: string;
}

export interface BackupRestoreEvidenceRecord {
  id: string;
  storeReference: string;
  backupReference: string;
  sha256: string;
  schemaVersion: number;
  operation: 'backup' | 'restore' | 'verification';
  outcome: 'passed' | 'failed';
  killSwitchEngaged: boolean;
  evidence?: unknown;
  encryptionVerified?: boolean;
  integrityCheck?: 'ok' | 'failed' | 'not_recorded';
  verificationSha256?: string;
  recordedAt: string;
}

export interface RetentionEvidenceRecord {
  id: string;
  policyId: string;
  entityType: string;
  cutoffAt: string;
  rowsDeleted: number;
  rowsRetained: number;
  outcome: 'passed' | 'failed';
  evidence?: unknown;
  recordedAt: string;
}

const json = (value: unknown): string | null => {
  if (value === undefined) return null;
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'bigint') return item.toString();
    if (Array.isArray(item)) return item.map((entry) => normalize(entry));
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, normalize(entry)]));
    return item;
  };
  const encoded = JSON.stringify(normalize(value));
  if (encoded !== undefined && /"(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)"\s*:/i.test(encoded)) throw new Error('secret-like values must remain in the approved secret store');
  return encoded;
};

function backupReferenceExists(reference: string): boolean {
  return existsSync(reference) || /^(s3|gs|b2|https?):\/\//i.test(reference);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(json(value) ?? '').digest('hex');
}

function safeText(value: string | undefined, label: string): string | undefined {
  if (value !== undefined && /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]/i.test(value)) throw new Error(`${label} contains secret-like material`);
  return value;
}

export function computeRequestFingerprint(value: unknown): string {
  return fingerprint(value);
}

function intentFingerprint(record: TransactionIntentRecord): string {
  const computed = fingerprint({
    campaignId: record.campaignId,
    walletId: record.walletId,
    intentClass: record.intentClass,
    toAddress: record.toAddress.toLowerCase(),
    valueWei: record.valueWei.toString(),
    calldata: record.calldata,
    nonce: record.nonce ?? null,
    chainProfileId: record.chainProfileId ?? null,
    fromAddress: record.fromAddress?.toLowerCase() ?? null,
    gasLimitWei: (record.gasLimitWei ?? 0n).toString(),
    maxFeePerGasWei: (record.maxFeePerGasWei ?? 0n).toString(),
    maxPriorityFeePerGasWei: (record.maxPriorityFeePerGasWei ?? 0n).toString(),
    runId: record.runId ?? null,
    policySnapshot: record.policySnapshot ?? null,
  });
  if (record.requestFingerprint !== undefined && record.requestFingerprint !== computed) throw new IdempotencyConflictError();
  return computed;
}

function runFingerprint(record: ExecutionRunRecord): string {
  const computed = fingerprint({ requestId: record.requestId, requestPayload: record.requestPayload ?? null, campaignId: record.campaignId ?? null, state: record.state, actor: record.actor ?? 'system', source: record.source ?? 'database', reason: record.reason ?? null });
  if (record.requestFingerprint !== undefined && record.requestFingerprint !== computed) throw new IdempotencyConflictError();
  return computed;
}

export class DurableRepository {
  private readonly phase2: Phase2Repository;
  public constructor(private readonly db: SqliteDatabase) { this.phase2 = new Phase2Repository(db); }

  private immediate<T>(operation: () => T): T {
    if (this.db.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  public saveRun(record: ExecutionRunRecord): void {
    this.immediate(() => {
      const requestFingerprint = runFingerprint(record);
      const existing = this.db.prepare('SELECT id, request_fingerprint FROM execution_run WHERE request_id = ?').get(record.requestId) as { id: string; request_fingerprint: string } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) throw new IdempotencyConflictError();
        return;
      }
      this.db.prepare('INSERT INTO execution_run (id, request_id, request_fingerprint, campaign_id, state, actor, source, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.requestId, requestFingerprint, record.campaignId ?? null, record.state, safeText(record.actor, 'run actor') ?? 'system', safeText(record.source, 'run source') ?? 'database', safeText(record.reason, 'run reason') ?? null, record.createdAt, record.updatedAt);
    });
  }

  public saveIntent(record: TransactionIntentRecord): void {
    this.immediate(() => {
      const requestKey = record.idempotencyKey ?? record.requestId;
      const requestFingerprint = intentFingerprint(record);
      if (requestKey?.length === 0) throw new Error('idempotency/request ID must not be empty');
      const identityQueries = [[record.idempotencyKey, 'idempotency_key'], [record.requestId, 'request_id']] as const;
      for (const [identity, column] of identityQueries) {
        if (!identity) continue;
        const existing = this.db.prepare(column === 'request_id' ? `SELECT id, request_fingerprint FROM transaction_intent WHERE request_id = ? AND wallet_id = ?` : `SELECT id, request_fingerprint FROM transaction_intent WHERE idempotency_key = ?`).get(...(column === 'request_id' ? [identity, record.walletId] : [identity])) as { id: string; request_fingerprint: string | null } | undefined;
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) throw new IdempotencyConflictError();
          return;
        }
      }
      const existingId = this.db.prepare('SELECT request_fingerprint FROM transaction_intent WHERE id = ?').get(record.id) as { request_fingerprint: string | null } | undefined;
      if (existingId) {
        if (existingId.request_fingerprint !== requestFingerprint) throw new IdempotencyConflictError();
        return;
      }
      for (const amount of [record.valueWei, record.gasLimitWei ?? 0n, record.maxFeePerGasWei ?? 0n, record.maxPriorityFeePerGasWei ?? 0n]) {
        if (amount < 0n) throw new Error('transaction intent amounts must be non-negative');
      }
      const wallet = this.db.prepare('SELECT chain_profile_id, address FROM wallet WHERE id = ?').get(record.walletId) as { chain_profile_id: string; address: string } | undefined;
      if (!wallet) throw new Error('wallet not found for transaction intent');
       const campaign = this.db.prepare('SELECT ct.chain_profile_id FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id WHERE c.id = ?').get(record.campaignId) as { chain_profile_id: string } | undefined;
      if (!campaign) throw new Error('campaign not found for transaction intent');
      const chainProfileId = record.chainProfileId ?? wallet.chain_profile_id;
      if (chainProfileId !== wallet.chain_profile_id || chainProfileId !== campaign.chain_profile_id) throw new Error('transaction intent chain does not match wallet and campaign');
      const membership = this.db.prepare('SELECT enabled FROM campaign_wallet WHERE campaign_id = ? AND wallet_id = ?').get(record.campaignId, record.walletId) as { enabled: number } | undefined;
      if (!membership || membership.enabled !== 1) throw new Error('transaction intent requires enabled campaign wallet membership');
       this.db.prepare('INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, policy_snapshot_json, created_at, chain_profile_id, from_address, gas_limit_wei, max_fee_per_gas_wei, max_priority_fee_per_gas_wei, idempotency_key, request_id, request_fingerprint, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.intentClass, record.toAddress, record.valueWei.toString(), record.calldata, record.nonce ?? null, json(record.policySnapshot), record.createdAt, chainProfileId, record.fromAddress ?? wallet.address, (record.gasLimitWei ?? 0n).toString(), (record.maxFeePerGasWei ?? 0n).toString(), (record.maxPriorityFeePerGasWei ?? 0n).toString(), record.idempotencyKey ?? null, record.requestId ?? null, requestFingerprint, record.runId ?? null);
    });
  }

  public recordAttempt(record: TransactionAttemptRecord): void {
    this.immediate(() => {
      const intent = this.db.prepare('SELECT i.nonce, i.chain_profile_id, w.address, e.id AS execution_id FROM transaction_intent i JOIN wallet w ON w.id = i.wallet_id LEFT JOIN execution e ON e.transaction_intent_id = i.id WHERE i.id = ? ORDER BY e.created_at DESC LIMIT 1').get(record.transactionIntentId) as { nonce: number | null; chain_profile_id: string | null; address: string; execution_id: string | null } | undefined;
      if (!intent) throw new Error('transaction intent not found for attempt');
      const replacement = record.replacementOfId ? this.db.prepare('SELECT transaction_intent_id, from_address, nonce FROM transaction_attempt WHERE id = ?').get(record.replacementOfId) as { transaction_intent_id: string; from_address: string | null; nonce: number | null } | undefined : undefined;
      if (record.replacementOfId && replacement?.transaction_intent_id !== record.transactionIntentId) throw new Error('replacement attempt must use the same transaction intent');
      const nonce = record.nonce ?? intent.nonce;
      if (intent.nonce !== null && nonce !== intent.nonce) throw new Error('attempt nonce does not match intent');
      if (replacement && (replacement.nonce !== nonce || replacement.from_address?.toLowerCase() !== intent.address.toLowerCase())) throw new Error('replacement attempt identity mismatch');
      const execution = record.executionId ? this.db.prepare('SELECT id, transaction_intent_id FROM execution WHERE id = ?').get(record.executionId) as { id: string; transaction_intent_id: string } | undefined : undefined;
      if (record.executionId && (!execution || execution.transaction_intent_id !== record.transactionIntentId)) throw new Error('transaction attempt does not match execution');
      this.db.prepare('INSERT INTO transaction_attempt (id, transaction_intent_id, endpoint, response_class, latency_ms, tx_hash, nonce, replacement_of_id, redacted_error, attempted_at, from_address, execution_id, chain_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.transactionIntentId, safeText(record.endpoint, 'attempt endpoint'), safeText(record.responseClass, 'attempt response class'), record.latencyMs ?? null, record.txHash ?? null, nonce, record.replacementOfId ?? null, safeText(record.redactedError, 'attempt error'), record.attemptedAt, intent.address, record.executionId ?? intent.execution_id, intent.chain_profile_id);
    });
  }

  public recordSimulation(record: SimulationRecord): void {
    if (!Number.isInteger(record.sourceBlockNumber) || record.sourceBlockNumber < 0) throw new Error('simulation source block must be a non-negative integer');
    if (!Number.isInteger(record.freshnessSeconds) || record.freshnessSeconds < 0) throw new Error('simulation freshness must be a non-negative integer');
    const checkedAt = Date.parse(record.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > Date.now()) throw new Error('simulation checked time is invalid or in the future');
    this.immediate(() => {
      if (!Number.isInteger(record.freshnessSeconds) || record.freshnessSeconds < 300 || record.freshnessSeconds > 86_400) throw new Error('simulation freshness must be between five minutes and 24 hours');
      const checkedAt = Date.parse(record.checkedAt);
      if (!Number.isFinite(checkedAt) || checkedAt > Date.now()) throw new Error('simulation checked_at cannot be future or invalid');
      const membership = this.db.prepare('SELECT enabled FROM campaign_wallet WHERE campaign_id = ? AND wallet_id = ?').get(record.campaignId, record.walletId) as { enabled: number } | undefined;
      if (!membership || membership.enabled !== 1) throw new Error('simulation requires enabled campaign wallet membership');
      if (record.transactionIntentId !== undefined) {
        const intent = this.db.prepare('SELECT campaign_id, wallet_id FROM transaction_intent WHERE id = ?').get(record.transactionIntentId) as { campaign_id: string; wallet_id: string } | undefined;
        if (!intent || intent.campaign_id !== record.campaignId || intent.wallet_id !== record.walletId) throw new Error('simulation does not match transaction intent');
      }
       const campaign = this.db.prepare('SELECT ct.chain_profile_id FROM campaign c JOIN "drop" d ON d.id = c.drop_id JOIN collection col ON col.id = d.collection_id JOIN contract ct ON ct.id = col.contract_id WHERE c.id = ?').get(record.campaignId) as { chain_profile_id: string } | undefined;
       const wallet = this.db.prepare('SELECT chain_profile_id FROM wallet WHERE id = ?').get(record.walletId) as { chain_profile_id: string } | undefined;
       const campaignWallet = this.db.prepare('SELECT enabled FROM campaign_wallet WHERE campaign_id = ? AND wallet_id = ?').get(record.campaignId, record.walletId) as { enabled: number } | undefined;
       if (!campaign || !wallet || campaign.chain_profile_id !== wallet.chain_profile_id || campaignWallet?.enabled !== 1) throw new Error('simulation wallet and campaign identity mismatch');
       if (record.transactionIntentId !== undefined) {
         const intent = this.db.prepare('SELECT wallet_id, campaign_id, chain_profile_id FROM transaction_intent WHERE id = ?').get(record.transactionIntentId) as { wallet_id: string; campaign_id: string; chain_profile_id: string | null } | undefined;
         if (!intent || intent.wallet_id !== record.walletId || intent.campaign_id !== record.campaignId || (intent.chain_profile_id !== null && intent.chain_profile_id !== campaign.chain_profile_id)) throw new Error('simulation transaction intent identity mismatch');
       }
       this.db.prepare('INSERT INTO simulation (id, wallet_id, campaign_id, transaction_intent_id, source_block_number, source_block_hash, checked_at, freshness_seconds, outcome, revert_taxonomy, tool_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.walletId, record.campaignId, record.transactionIntentId ?? null, record.sourceBlockNumber, record.sourceBlockHash ?? null, record.checkedAt, record.freshnessSeconds, record.outcome, safeText(record.revertTaxonomy, 'simulation revert taxonomy') ?? null, safeText(record.toolVersion, 'simulation tool version'), json(record.details ?? {}) ?? '{}');
    });
  }

  public saveExecution(record: ExecutionRecord): void {
    this.immediate(() => {
      const intent = this.db.prepare('SELECT campaign_id, wallet_id, request_id, request_fingerprint, run_id FROM transaction_intent WHERE id = ?').get(record.transactionIntentId) as { campaign_id: string; wallet_id: string; request_id: string | null; request_fingerprint: string | null; run_id: string | null } | undefined;
      if (!intent) throw new Error('transaction intent not found for execution');
      if (intent.campaign_id !== record.campaignId || intent.wallet_id !== record.walletId) throw new Error('execution does not match transaction intent');
      if (record.requestId !== undefined && record.requestId !== intent.request_id || record.requestFingerprint !== undefined && record.requestFingerprint !== intent.request_fingerprint) throw new IdempotencyConflictError();
      this.db.prepare('INSERT INTO execution (id, campaign_id, wallet_id, transaction_intent_id, state, created_at, updated_at, run_id, request_id, request_fingerprint, reservation_id, error_code, error_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.transactionIntentId, 'prepared', record.createdAt, record.updatedAt, record.runId ?? intent.run_id, record.requestId ?? intent.request_id, record.requestFingerprint ?? intent.request_fingerprint, record.reservationId ?? null, record.errorCode ?? null, record.errorReason ?? null);
      if (record.state !== 'prepared') this.db.prepare('UPDATE execution SET state = ? WHERE id = ?').run(record.state, record.id);
    });
  }

  public transitionExecution(id: string, newState: string, lifecycle: Omit<LifecycleEventRecord, 'entityId' | 'priorState' | 'newState'>, audit?: Omit<AuditEventRecord, 'entityId' | 'priorState' | 'newState'>): void {
    this.immediate(() => {
      const current = this.db.prepare('SELECT state FROM execution WHERE id = ?').get(id) as { state: string } | undefined;
      if (!current) throw new Error('execution not found');
      this.db.prepare('UPDATE execution SET state = ?, updated_at = ? WHERE id = ?').run(newState, lifecycle.occurredAt, id);
      this.recordLifecycleEvent({ ...lifecycle, entityId: id, priorState: current.state, newState });
      if (audit) this.recordAuditEvent({ ...audit, entityId: id, priorState: current.state, newState });
    });
  }

  public recordReceipt(record: ReceiptRecord): void {
    this.immediate(() => {
      for (const amount of [record.gasUsed, record.effectiveGasPrice]) if (amount !== undefined && amount < 0n) throw new Error('receipt amounts must be non-negative');
      const attempt = this.db.prepare('SELECT tx_hash, execution_id, chain_profile_id FROM transaction_attempt WHERE id = ?').get(record.transactionAttemptId) as { tx_hash: string | null; execution_id: string | null; chain_profile_id: string | null } | undefined;
      if (!attempt) throw new Error('transaction attempt not found for receipt');
      if (attempt.tx_hash === null || attempt.tx_hash.toLowerCase() !== record.txHash.toLowerCase()) throw new Error('receipt hash does not match transaction attempt');
      if (record.executionId !== undefined && record.executionId !== attempt.execution_id) throw new Error('receipt does not match execution');
      this.db.prepare('INSERT INTO transaction_receipt (id, transaction_attempt_id, tx_hash, status, block_number, block_hash, confirmations, gas_used, effective_gas_price, finality_stage, finality_source, observed_at, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.transactionAttemptId, record.txHash, record.status, record.blockNumber ?? null, record.blockHash ?? null, record.confirmations, record.gasUsed?.toString() ?? null, record.effectiveGasPrice?.toString() ?? null, record.finalityStage ?? 'unknown', safeText(record.finalitySource, 'receipt finality source') ?? null, record.observedAt, attempt.execution_id);
    });
  }

  public recordLifecycleEvent(record: LifecycleEventRecord): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO state_transition (id, entity_type, entity_id, prior_state, new_state, actor, source, reason, policy_version, evidence_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState, safeText(record.actor, 'lifecycle actor'), safeText(record.source, 'lifecycle source'), safeText(record.reason, 'lifecycle reason'), safeText(record.policyVersion, 'lifecycle policy version') ?? null, json(record.evidenceSnapshot), record.occurredAt);
    });
  }

  public recordAuditEvent(record: AuditEventRecord): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, prior_state, new_state, actor, reason, evidence_snapshot_json, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState ?? null, safeText(record.actor, 'audit actor'), safeText(record.reason, 'audit reason'), json(record.evidenceSnapshot), json(record.policySnapshot), record.occurredAt);
    });
  }

  public recordChainVerification(record: ChainVerificationRecord): void {
    const profile = this.db.prepare('SELECT chain_id, verification_status, execution_enabled FROM chain_profile WHERE id = ?').get(record.chainProfileId) as { chain_id: number; verification_status: string; execution_enabled: number } | undefined;
    if (!profile || profile.chain_id !== record.chainId) throw new Error('chain verification identity mismatch');
    if (record.chainId === 4663 && record.sequencerEndpointReference !== 'https://sequencer.mainnet.chain.robinhood.com') throw new Error('Robinhood sequencer reference is not the approved endpoint');
    if (record.chainId === 4663 && !record.archiveEndpointReference?.startsWith('Rets/MINT_BOT_SECRETS.env')) throw new Error('Robinhood archive endpoint must remain a Rets/MINT_BOT_SECRETS.env reference');
    if (record.status === 'verified') {
      const evidence = record.evidence && typeof record.evidence === 'object' ? record.evidence as Record<string, unknown> : undefined;
      if (!record.approvedBy || !record.approvedAt || !evidence || Object.keys(evidence).length === 0 || evidence.finalityPassed !== true) throw new Error('verified chain requires approved finality evidence');
    }
    this.immediate(() => {
      const executionEnabled = record.executionEnabled ?? (record.status === 'execution_blocked' ? false : profile.execution_enabled === 1);
      if (record.status !== 'verified' && executionEnabled) throw new Error('execution can only remain enabled for a verified chain');
      const evidence = json(record.evidence ?? {}) ?? '{}';
      const approver = safeText(record.approvedBy, 'verification approver');
      const approvedAt = record.approvedAt ?? null;
      if (record.status === 'verified' || executionEnabled) {
        if (!approver || !approvedAt || !Number.isFinite(Date.parse(approvedAt)) || evidence === '{}') throw new Error('verified chain requires approver, approval time, and substantive evidence');
      }
      this.db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, sea_drop_test_tx_hash, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.status, record.chainId, safeText(record.sequencerEndpointReference, 'sequencer endpoint') ?? null, safeText(record.archiveEndpointReference, 'archive endpoint') ?? null, safeText(record.feedEndpointReference, 'feed endpoint') ?? null, record.seaDropTestTxHash ?? null, evidence, record.checkedAt, approver ?? null, approvedAt);
      this.db.prepare('UPDATE chain_profile SET verification_status = ?, verification_evidence_json = ?, verification_approved_by = ?, verification_approved_at = ?, execution_enabled = ? WHERE id = ?').run(record.status, evidence, approver ?? null, approvedAt, executionEnabled ? 1 : 0, record.chainProfileId);
      this.db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, prior_state, new_state, actor, reason, evidence_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`${record.id}:audit`, 'chain_profile', record.chainProfileId, profile.verification_status, record.status, safeText(record.approvedBy, 'verification approver') ?? 'database', 'chain verification evidence recorded', evidence, record.checkedAt);
    });
  }

  public recordReconciliation(record: ReconciliationRecord): void {
    this.immediate(() => {
      if (!record.txHash || !record.fromAddress || record.nonce === undefined) throw new Error('reconciliation requires tx hash, from address, and nonce');
      if (!record.policyVersion || !record.details || typeof record.details !== 'object' || Array.isArray(record.details) || Object.keys(record.details as Record<string, unknown>).length === 0) throw new Error('reconciliation requires policy version and source evidence');
      const attempt = record.transactionAttemptId === undefined ? undefined : this.db.prepare('SELECT execution_id, chain_profile_id, tx_hash, from_address, nonce FROM transaction_attempt WHERE id = ?').get(record.transactionAttemptId) as { execution_id: string | null; chain_profile_id: string | null; tx_hash: string | null; from_address: string | null; nonce: number | null } | undefined;
      if (record.transactionAttemptId !== undefined && !attempt) throw new Error('transaction attempt not found for reconciliation');
      if (record.transactionAttemptId === undefined && record.executionId === undefined) throw new Error('reconciliation requires attempt or execution linkage');
      if (attempt && attempt.chain_profile_id !== null && attempt.chain_profile_id !== record.chainProfileId) throw new Error('reconciliation chain does not match attempt');
      if (attempt && (record.txHash.toLowerCase() !== attempt.tx_hash?.toLowerCase() || record.fromAddress.toLowerCase() !== attempt.from_address?.toLowerCase() || record.nonce !== attempt.nonce)) throw new Error('reconciliation identity does not match attempt');
      const execution = record.executionId === undefined ? undefined : this.db.prepare('SELECT id, wallet_id FROM execution WHERE id = ?').get(record.executionId) as { id: string; wallet_id: string } | undefined;
      if (record.executionId !== undefined && !execution) throw new Error('reconciliation execution not found');
      if (execution && attempt?.execution_id !== null && attempt?.execution_id !== undefined && attempt.execution_id !== execution.id) throw new Error('reconciliation execution does not match attempt');
       this.db.prepare('INSERT INTO reconciliation_record (id, chain_profile_id, transaction_attempt_id, tx_hash, from_address, nonce, state, checked_at, source, details_json, execution_id, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.transactionAttemptId ?? null, record.txHash, record.fromAddress, record.nonce, record.state, record.checkedAt, safeText(record.source, 'reconciliation source'), json(record.details) ?? '{}', record.executionId ?? attempt?.execution_id ?? null, safeText(record.policyVersion, 'reconciliation policy version'));
    });
  }

  public recordReorgEvent(record: ReorgEventRecord): void {
    this.immediate(() => {
      const profile = this.db.prepare('SELECT chain_id FROM chain_profile WHERE id = ?').get(record.chainProfileId) as { chain_id: number } | undefined;
      if (!profile) throw new Error('chain profile not found for reorg event');
      const attempt = record.transactionAttemptId === undefined ? undefined : this.db.prepare('SELECT execution_id, chain_profile_id, tx_hash, from_address, nonce FROM transaction_attempt WHERE id = ?').get(record.transactionAttemptId) as { execution_id: string | null; chain_profile_id: string | null; tx_hash: string | null; from_address: string | null; nonce: number | null } | undefined;
      if (record.transactionAttemptId !== undefined && !attempt) throw new Error('transaction attempt not found for reorg event');
      if (record.executionId !== undefined && record.transactionAttemptId === undefined) throw new Error('reorg event requires transaction attempt identity');
      if (attempt?.chain_profile_id !== null && attempt?.chain_profile_id !== undefined && attempt.chain_profile_id !== record.chainProfileId) throw new Error('reorg event chain does not match attempt');
      if (record.executionId !== undefined && attempt?.execution_id !== record.executionId) throw new Error('reorg event execution does not match attempt');
      if (record.transactionAttemptId !== undefined && (!attempt?.tx_hash || !attempt.from_address || attempt.nonce === null)) throw new Error('reorg event requires transaction identity facts');
      const evidence = json(record.evidence ?? {}) ?? '{}';
      this.db.prepare('INSERT INTO reorg_event (id, chain_profile_id, transaction_attempt_id, old_block_hash, new_block_hash, previous_finality_stage, new_finality_stage, detected_at, evidence_json, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.transactionAttemptId ?? null, record.oldBlockHash ?? null, record.newBlockHash ?? null, record.previousFinalityStage, record.newFinalityStage, record.detectedAt, evidence, record.executionId ?? attempt?.execution_id ?? null);
      if (record.transactionAttemptId !== undefined) {
         this.db.prepare("INSERT INTO reconciliation_record (id, chain_profile_id, transaction_attempt_id, tx_hash, from_address, nonce, state, checked_at, source, details_json, execution_id, policy_version) VALUES (?, ?, ?, ?, ?, ?, 'reorged', ?, 'reorg-event', ?, ?, 'phase2-reconciliation-v1')").run(`${record.id}:reconciliation`, record.chainProfileId, record.transactionAttemptId, attempt?.tx_hash, attempt?.from_address, attempt?.nonce, record.detectedAt, json({ sourceEvidence: record.evidence ?? {}, reorgEventId: record.id }) ?? '{}', record.executionId ?? attempt?.execution_id ?? null);
      }
    });
  }

  public recordReorgResolution(record: ReorgResolutionRecord): void {
    this.immediate(() => {
      const event = this.db.prepare('SELECT chain_profile_id FROM reorg_event WHERE id = ?').get(record.reorgEventId) as { chain_profile_id: string } | undefined;
      if (!event) throw new Error('reorg event not found');
      if (record.replacementExecutionId) {
        const execution = this.db.prepare('SELECT i.chain_profile_id FROM execution e JOIN transaction_intent i ON i.id = e.transaction_intent_id WHERE e.id = ?').get(record.replacementExecutionId) as { chain_profile_id: string } | undefined;
        if (!execution) throw new Error('replacement execution not found');
        if (execution.chain_profile_id !== event.chain_profile_id) throw new Error('replacement execution chain does not match reorg event');
      }
      this.db.prepare('INSERT INTO reorg_resolution (id, reorg_event_id, state, replacement_execution_id, reason, resolved_at) VALUES (?, ?, ?, ?, ?, ?)').run(record.id, record.reorgEventId, record.state, record.replacementExecutionId ?? null, safeText(record.reason, 'reorg resolution reason'), record.resolvedAt);
    });
  }

  public saveFeePolicy(record: FeePolicyRecord): void {
    if (record.maxTotalFeeWei < 0n || record.freeMintTotalFeeCapWei < 0n) throw new Error('fee caps must be non-negative');
    const multiplier = record.freeMintPriorityFeeMultiplier ?? 2;
    if (!Number.isInteger(multiplier) || multiplier < 0 || multiplier > 2) throw new Error('free-mint priority fee multiplier must be between 0 and 2');
    this.immediate(() => {
      this.db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.version, record.priorityFeeSemantics, record.maxTotalFeeWei.toString(), record.freeMintTotalFeeCapWei.toString(), (record.freeMintPriorityFeeComponentWei ?? 0n).toString(), multiplier, record.paidMintsEnabled ? 1 : 0, record.active ? 1 : 0, record.createdAt, record.zeroPriorityFeePolicy ?? 'requires_po_resolution');
    });
  }

  public canExecuteChain(chainProfileId: string): boolean {
    const row = this.db.prepare("SELECT execution_enabled FROM chain_profile WHERE id = ? AND verification_status = 'verified'").get(chainProfileId) as { execution_enabled: number } | undefined;
    return row?.execution_enabled === 1;
  }

  public assertTotalFeeWithinPolicy(chainProfileId: string, totalFeeWei: bigint, freeMint = false, priorityFeeComponentWei = 0n): void {
    const chain = this.db.prepare('SELECT chain_id FROM chain_profile WHERE id = ?').get(chainProfileId) as { chain_id: number } | undefined;
    if (!chain) throw new Error('chain profile not found');
    if (chain.chain_id === 4663 && !freeMint) throw new Error('paid Robinhood mints are blocked');
    const row = this.db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, zero_priority_fee_policy FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(chainProfileId) as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; free_mint_priority_fee_component_wei: string; free_mint_priority_fee_multiplier: number; paid_mints_enabled: number; zero_priority_fee_policy: 'requires_po_resolution' | 'blocked' | 'allowed' } | undefined;
    if (!row) throw new Error('active total-fee policy not found');
    if (!freeMint && row.paid_mints_enabled !== 1) throw new Error('paid-mint policy is not approved');
    if (totalFeeWei < 0n || priorityFeeComponentWei < 0n) throw new Error('fee amounts must be non-negative');
    const cap = BigInt(freeMint ? row.free_mint_total_fee_cap_wei : row.max_total_fee_wei);
    if (totalFeeWei > cap) throw new Error('total fee exceeds policy');
    if (priorityFeeComponentWei === 0n && row.zero_priority_fee_policy === 'blocked') throw new Error('zero-priority-fee policy is blocked');
    if (priorityFeeComponentWei === 0n && row.zero_priority_fee_policy !== 'allowed') throw new Error('zero-priority-fee policy does not allow zero');
    if (freeMint && priorityFeeComponentWei > BigInt(row.free_mint_priority_fee_component_wei) * BigInt(row.free_mint_priority_fee_multiplier)) throw new Error('priority fee component exceeds free-mint policy');
  }

  public recordDocumentationFixture(id: string, chainProfileId: string, txHash: string, fixtureType: 'external_wallet_failed' | 'positive_reference', notes: string, recordedAt: string): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO documentation_fixture (id, chain_profile_id, tx_hash, fixture_type, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chainProfileId, txHash, fixtureType, safeText(notes, 'documentation notes'), recordedAt);
    });
  }

  public saveBackupPolicy(record: BackupPolicyRecord): void {
    const retentionDays = record.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new Error('backup retention must be positive');
    this.immediate(() => {
      this.db.prepare('INSERT INTO backup_policy (id, retention_days, encryption_required, approval_owner, approved_at, active) VALUES (?, ?, 1, ?, ?, 1)').run(record.id, retentionDays, record.approvalOwner, record.approvedAt);
    });
  }

  public recordBackupRestoreEvidence(record: BackupRestoreEvidenceRecord): void {
    if (record.outcome === 'passed' && (record.encryptionVerified !== true || record.integrityCheck !== 'ok' || !record.killSwitchEngaged || !backupReferenceExists(record.storeReference) || !backupReferenceExists(record.backupReference))) throw new Error('passed backup evidence requires encrypted, verified, kill-switched references');
    if (!/^[a-f0-9]{64}$/i.test(record.sha256)) throw new Error('backup evidence hash must be SHA-256');
    if (record.verificationSha256 !== undefined && record.verificationSha256.toLowerCase() !== record.sha256.toLowerCase()) throw new Error('backup verification hash mismatch');
    if (existsSync(record.backupReference)) {
      const actualHash = createHash('sha256').update(readFileSync(record.backupReference)).digest('hex');
      if (actualHash !== record.sha256.toLowerCase()) throw new Error('backup evidence hash does not match backup');
    }
    this.immediate(() => {
      const currentSchema = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
      if (record.outcome === 'passed' && currentSchema.version !== record.schemaVersion) throw new Error('backup evidence schema version is not current');
      if (record.outcome === 'passed') {
        const evidence = record.evidence && typeof record.evidence === 'object' ? record.evidence as Record<string, unknown> : {};
        const restoreReference = typeof evidence.restoreReference === 'string' ? evidence.restoreReference : undefined;
        const offsiteReference = typeof evidence.offsiteReference === 'string' ? evidence.offsiteReference : undefined;
        const retentionPolicyId = typeof evidence.retentionPolicyId === 'string' ? evidence.retentionPolicyId : undefined;
         const retention = retentionPolicyId === undefined ? undefined : this.db.prepare("SELECT id FROM retention_policy WHERE id = ? AND active = 1 UNION SELECT id FROM backup_policy WHERE id = ? AND active = 1").get(retentionPolicyId, retentionPolicyId) as { id: string } | undefined;
        const referenceEvidence = restoreReference && offsiteReference && backupReferenceExists(restoreReference) && backupReferenceExists(offsiteReference);
        const flagEvidence = evidence.offHost === true && evidence.restoreVerified === true && evidence.postRestoreReconciliation === true && typeof evidence.retentionDays === 'number' && evidence.retentionDays > 0;
        if (!referenceEvidence && !flagEvidence) throw new Error('passed backup evidence requires restore, off-host, and retention evidence');
        if (retentionPolicyId !== undefined && !retention && !flagEvidence) throw new Error('passed backup evidence requires an active retention policy');
       }
      if (record.outcome === 'passed' && (!record.verificationSha256 || record.verificationSha256.toLowerCase() !== record.sha256.toLowerCase())) throw new Error('passed backup evidence requires verification hash');
      this.db.prepare('INSERT INTO backup_restore_evidence (id, store_reference, backup_reference, sha256, schema_version, operation, outcome, kill_switch_engaged, evidence_json, recorded_at, encryption_verified, integrity_check, verification_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, safeText(record.storeReference, 'backup store reference'), safeText(record.backupReference, 'backup reference'), record.sha256.toLowerCase(), record.schemaVersion, record.operation, record.outcome, record.killSwitchEngaged ? 1 : 0, json(record.evidence ?? {}) ?? '{}', record.recordedAt, record.encryptionVerified ? 1 : 0, record.integrityCheck ?? 'not_recorded', record.verificationSha256?.toLowerCase() ?? null);
    });
  }

  public recordRetentionEvidence(record: RetentionEvidenceRecord): void {
    if (!Number.isInteger(record.rowsDeleted) || record.rowsDeleted < 0 || !Number.isInteger(record.rowsRetained) || record.rowsRetained < 0) throw new Error('retention row counts must be non-negative integers');
    this.immediate(() => {
      const policy = this.db.prepare('SELECT entity_type, active, retain_indefinitely FROM retention_policy WHERE id = ?').get(record.policyId) as { entity_type: string; active: number; retain_indefinitely: number } | undefined;
      if (!policy || policy.active !== 1 || policy.entity_type !== record.entityType) throw new Error('retention evidence does not match an active policy');
      if (policy.retain_indefinitely === 1 && record.rowsDeleted !== 0) throw new Error('indefinite-retention evidence cannot delete rows');
      this.db.prepare('INSERT INTO retention_evidence (id, policy_id, entity_type, cutoff_at, rows_deleted, rows_retained, outcome, evidence_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.policyId, record.entityType, record.cutoffAt, record.rowsDeleted, record.rowsRetained, record.outcome, json(record.evidence ?? {}) ?? '{}', record.recordedAt);
    });
  }

  public isFinalSuccess(chainProfileId: string, receiptId: string): boolean {
    const row = this.db.prepare("SELECT r.status, r.finality_stage AS stage, c.success_finality_stage AS required, c.execution_enabled, (SELECT rr.state FROM reconciliation_record rr WHERE rr.transaction_attempt_id = r.transaction_attempt_id ORDER BY rr.checked_at DESC, rr.id DESC LIMIT 1) AS reconciliation_state FROM transaction_receipt r JOIN transaction_attempt a ON a.id = r.transaction_attempt_id JOIN transaction_intent i ON i.id = a.transaction_intent_id JOIN wallet w ON w.id = i.wallet_id JOIN chain_profile c ON c.id = w.chain_profile_id WHERE r.id = ? AND c.id = ? AND NOT EXISTS (SELECT 1 FROM transaction_receipt newer WHERE newer.transaction_attempt_id = r.transaction_attempt_id AND (newer.observed_at > r.observed_at OR (newer.observed_at = r.observed_at AND newer.id > r.id)))").get(receiptId, chainProfileId) as { status: string; stage: string; required: string; execution_enabled: number; reconciliation_state: string | null } | undefined;
    return row !== undefined && row.status === 'confirmed' && row.stage === row.required && row.execution_enabled === 1 && (row.reconciliation_state === null || row.reconciliation_state === 'final');
  }

  public saveExecutionBundle(execution: ExecutionRecord, intent: TransactionIntentRecord, lifecycle: LifecycleEventRecord, audit: AuditEventRecord): void {
    this.immediate(() => {
      this.saveIntent(intent);
      this.saveExecution(execution);
      this.recordLifecycleEvent(lifecycle);
      this.recordAuditEvent(audit);
    });
  }

  public saveWalletMetadata(record: WalletMetadataRecord): void { this.phase2.saveWalletMetadata(record); }
  public recordWalletBalance(record: WalletBalanceRecord): void { this.phase2.recordWalletBalance(record); }
  public setTrackedWallet(record: TrackedWalletRecord): void { this.phase2.setTrackedWallet(record); }
  public recordProvenance(record: ProvenanceRecord): void { this.phase2.recordProvenance(record); }
  public recordFreshness(record: FreshnessObservationRecord): void { this.phase2.recordFreshness(record); }
  public saveJob(record: JobRecord): void { this.phase2.saveJob(record); }
  public recoverExpiredJobs(at?: Date): number { return this.phase2.recoverExpiredJobs(at); }
  public claimJob(id: string, leaseOwner: string, leaseExpiresAt: string, at?: Date): JobRecord | null { return this.phase2.claimJob(id, leaseOwner, leaseExpiresAt, at); }
  public completeJob(id: string, leaseOwner?: string, at?: Date): void { this.phase2.completeJob(id, leaseOwner, at); }
  public failJob(id: string, error: string, leaseOwner?: string, at?: Date): void { this.phase2.failJob(id, error, leaseOwner, at); }
  public retryJob(id: string, scheduledAt: string, at?: Date): void { this.phase2.retryJob(id, scheduledAt, at); }
  public appendEvent(record: DomainEventRecord): string { return this.phase2.appendEvent(record); }
  public recordReadiness(record: ReadinessSnapshotRecord): void { this.phase2.recordReadiness(record); }
  public saveOpportunity(record: OpportunityRecord): void { this.phase2.saveOpportunity(record); }
  public recordOpportunityEvidence(record: OpportunityEvidenceRecord): void { this.phase2.recordOpportunityEvidence(record); }
  public recordOpportunityScore(record: OpportunityScoreRecord): void { this.phase2.recordOpportunityScore(record); }
  public recordOpportunityRisk(record: OpportunityRiskRecord): void { this.phase2.recordOpportunityRisk(record); }
  public recordOpportunityGateCheck(record: OpportunityGateCheckRecord): void { this.phase2.recordOpportunityGateCheck(record); }
  public enqueueAlert(record: AlertRecord): AlertDeliveryRecord { return this.phase2.enqueueAlert(record); }
  public claimAlertDelivery(id: string, at?: Date): AlertDeliveryRecord | null { return this.phase2.claimAlertDelivery(id, at); }
  public completeAlertDelivery(id: string, at?: Date): void { this.phase2.completeAlertDelivery(id, at); }
  public failAlertDelivery(id: string, error: string, nextAttemptAt?: string, at?: Date): void { this.phase2.failAlertDelivery(id, error, nextAttemptAt, at); }
  public retryAlertDelivery(id: string, nextAttemptAt: string, at?: Date): void { this.phase2.retryAlertDelivery(id, nextAttemptAt, at); }
  public deadLetterAlertDelivery(id: string, at?: Date): void { this.phase2.deadLetterAlertDelivery(id, at); }
  public recordFinalityObservation(record: FinalityObservationRecord): void { this.phase2.recordFinalityObservation(record); }
  public refreshSpendSummary(scopeType: SpendSummaryRecord['scopeType'], scopeId: string, options?: { usageDate?: string; walletId?: string; campaignId?: string; sourceVersion?: string; asOf?: string }): SpendSummaryRecord { return this.phase2.refreshSpendSummary(scopeType, scopeId, options); }
}
