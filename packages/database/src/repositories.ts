import type { SqliteDatabase } from './database.js';
import { createHash } from 'node:crypto';

export class IdempotencyConflictError extends Error {
  public constructor() { super('idempotency key was reused with a different request fingerprint'); }
}

export interface ExecutionRunRecord {
  id: string;
  requestId: string;
  requestFingerprint: string;
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
  const encoded = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
  if (encoded !== undefined && /"(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)"\s*:/i.test(encoded)) throw new Error('secret-like values must remain in the approved secret store');
  return encoded;
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(json(value) ?? '').digest('hex');
}

function intentFingerprint(record: TransactionIntentRecord): string {
  return record.requestFingerprint ?? fingerprint({
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
  });
}

export class DurableRepository {
  public constructor(private readonly db: SqliteDatabase) {}

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
      const existing = this.db.prepare('SELECT id, request_fingerprint FROM execution_run WHERE request_id = ?').get(record.requestId) as { id: string; request_fingerprint: string } | undefined;
      if (existing) {
        if (existing.request_fingerprint !== record.requestFingerprint) throw new IdempotencyConflictError();
        return;
      }
      this.db.prepare('INSERT INTO execution_run (id, request_id, request_fingerprint, campaign_id, state, actor, source, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.requestId, record.requestFingerprint, record.campaignId ?? null, record.state, record.actor ?? 'system', record.source ?? 'database', record.reason ?? null, record.createdAt, record.updatedAt);
    });
  }

  public saveIntent(record: TransactionIntentRecord): void {
    this.immediate(() => {
      const requestKey = record.idempotencyKey ?? record.requestId;
      const requestFingerprint = intentFingerprint(record);
      if (requestKey) {
        const existing = this.db.prepare('SELECT id, request_fingerprint FROM transaction_intent WHERE COALESCE(idempotency_key, request_id) = ?').get(requestKey) as { id: string; request_fingerprint: string | null } | undefined;
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
      this.db.prepare('INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, policy_snapshot_json, created_at, chain_profile_id, from_address, gas_limit_wei, max_fee_per_gas_wei, max_priority_fee_per_gas_wei, idempotency_key, request_id, request_fingerprint, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.intentClass, record.toAddress, record.valueWei.toString(), record.calldata, record.nonce ?? null, json(record.policySnapshot), record.createdAt, record.chainProfileId ?? wallet.chain_profile_id, record.fromAddress ?? wallet.address, (record.gasLimitWei ?? 0n).toString(), (record.maxFeePerGasWei ?? 0n).toString(), (record.maxPriorityFeePerGasWei ?? 0n).toString(), record.idempotencyKey ?? null, record.requestId ?? null, requestFingerprint, record.runId ?? null);
    });
  }

  public recordAttempt(record: TransactionAttemptRecord): void {
    this.immediate(() => {
      const intent = this.db.prepare('SELECT i.nonce, w.address, e.id AS execution_id FROM transaction_intent i JOIN wallet w ON w.id = i.wallet_id LEFT JOIN execution e ON e.transaction_intent_id = i.id WHERE i.id = ? ORDER BY e.created_at DESC LIMIT 1').get(record.transactionIntentId) as { nonce: number | null; address: string; execution_id: string | null } | undefined;
      if (!intent) throw new Error('transaction intent not found for attempt');
      const replacement = record.replacementOfId ? this.db.prepare('SELECT transaction_intent_id FROM transaction_attempt WHERE id = ?').get(record.replacementOfId) as { transaction_intent_id: string } | undefined : undefined;
      if (record.replacementOfId && replacement?.transaction_intent_id !== record.transactionIntentId) throw new Error('replacement attempt must use the same transaction intent');
      this.db.prepare('INSERT INTO transaction_attempt (id, transaction_intent_id, endpoint, response_class, latency_ms, tx_hash, nonce, replacement_of_id, redacted_error, attempted_at, from_address, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.transactionIntentId, record.endpoint, record.responseClass, record.latencyMs ?? null, record.txHash ?? null, record.nonce ?? intent.nonce, record.replacementOfId ?? null, record.redactedError ?? null, record.attemptedAt, intent.address, record.executionId ?? intent.execution_id);
    });
  }

  public recordSimulation(record: SimulationRecord): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO simulation (id, wallet_id, campaign_id, transaction_intent_id, source_block_number, source_block_hash, checked_at, freshness_seconds, outcome, revert_taxonomy, tool_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.walletId, record.campaignId, record.transactionIntentId ?? null, record.sourceBlockNumber, record.sourceBlockHash ?? null, record.checkedAt, record.freshnessSeconds, record.outcome, record.revertTaxonomy ?? null, record.toolVersion, json(record.details ?? {}) ?? '{}');
    });
  }

  public saveExecution(record: ExecutionRecord): void {
    this.immediate(() => {
      const intent = this.db.prepare('SELECT campaign_id, wallet_id, request_id, request_fingerprint, run_id FROM transaction_intent WHERE id = ?').get(record.transactionIntentId) as { campaign_id: string; wallet_id: string; request_id: string | null; request_fingerprint: string | null; run_id: string | null } | undefined;
      if (!intent) throw new Error('transaction intent not found for execution');
      if (intent.campaign_id !== record.campaignId || intent.wallet_id !== record.walletId) throw new Error('execution does not match transaction intent');
      this.db.prepare('INSERT INTO execution (id, campaign_id, wallet_id, transaction_intent_id, state, created_at, updated_at, run_id, request_id, request_fingerprint, reservation_id, error_code, error_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.transactionIntentId, record.state, record.createdAt, record.updatedAt, record.runId ?? intent.run_id, record.requestId ?? intent.request_id, record.requestFingerprint ?? intent.request_fingerprint, record.reservationId ?? null, record.errorCode ?? null, record.errorReason ?? null);
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
      const attempt = this.db.prepare('SELECT tx_hash, execution_id FROM transaction_attempt WHERE id = ?').get(record.transactionAttemptId) as { tx_hash: string | null; execution_id: string | null } | undefined;
      if (!attempt) throw new Error('transaction attempt not found for receipt');
      if (attempt.tx_hash !== null && attempt.tx_hash.toLowerCase() !== record.txHash.toLowerCase()) throw new Error('receipt hash does not match transaction attempt');
      this.db.prepare('INSERT INTO transaction_receipt (id, transaction_attempt_id, tx_hash, status, block_number, block_hash, confirmations, gas_used, effective_gas_price, finality_stage, finality_source, observed_at, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.transactionAttemptId, record.txHash, record.status, record.blockNumber ?? null, record.blockHash ?? null, record.confirmations, record.gasUsed?.toString() ?? null, record.effectiveGasPrice?.toString() ?? null, record.finalityStage ?? 'unknown', record.finalitySource ?? null, record.observedAt, record.executionId ?? attempt.execution_id);
    });
  }

  public recordLifecycleEvent(record: LifecycleEventRecord): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO state_transition (id, entity_type, entity_id, prior_state, new_state, actor, source, reason, policy_version, evidence_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState, record.actor, record.source, record.reason, record.policyVersion ?? null, json(record.evidenceSnapshot), record.occurredAt);
    });
  }

  public recordAuditEvent(record: AuditEventRecord): void {
    this.immediate(() => {
      this.db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, prior_state, new_state, actor, reason, evidence_snapshot_json, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState ?? null, record.actor, record.reason, json(record.evidenceSnapshot), json(record.policySnapshot), record.occurredAt);
    });
  }

  public recordChainVerification(record: ChainVerificationRecord): void {
    const profile = this.db.prepare('SELECT chain_id FROM chain_profile WHERE id = ?').get(record.chainProfileId) as { chain_id: number } | undefined;
    if (!profile || profile.chain_id !== record.chainId) throw new Error('chain verification identity mismatch');
    if (record.chainId === 4663 && record.sequencerEndpointReference !== 'https://sequencer.mainnet.chain.robinhood.com') throw new Error('Robinhood sequencer reference is not the approved endpoint');
    if (record.chainId === 4663 && !record.archiveEndpointReference?.startsWith('Rets/MINT_BOT_SECRETS.env')) throw new Error('Robinhood archive endpoint must remain a Rets/MINT_BOT_SECRETS.env reference');
    this.immediate(() => {
      this.db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, sea_drop_test_tx_hash, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.status, record.chainId, record.sequencerEndpointReference ?? null, record.archiveEndpointReference ?? null, record.feedEndpointReference ?? null, record.seaDropTestTxHash ?? null, json(record.evidence ?? {}) ?? '{}', record.checkedAt, record.approvedBy ?? null, record.approvedAt ?? null);
    });
  }

  public recordReconciliation(record: ReconciliationRecord): void {
    this.immediate(() => {
      const execution = record.transactionAttemptId === undefined ? undefined : this.db.prepare('SELECT execution_id FROM transaction_attempt WHERE id = ?').get(record.transactionAttemptId) as { execution_id: string | null } | undefined;
      this.db.prepare('INSERT INTO reconciliation_record (id, chain_profile_id, transaction_attempt_id, tx_hash, from_address, nonce, state, checked_at, source, details_json, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.transactionAttemptId ?? null, record.txHash ?? null, record.fromAddress ?? null, record.nonce ?? null, record.state, record.checkedAt, record.source, json(record.details ?? {}) ?? '{}', record.executionId ?? execution?.execution_id ?? null);
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
      this.db.prepare('INSERT INTO documentation_fixture (id, chain_profile_id, tx_hash, fixture_type, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chainProfileId, txHash, fixtureType, notes, recordedAt);
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
    this.immediate(() => {
      this.db.prepare('INSERT INTO backup_restore_evidence (id, store_reference, backup_reference, sha256, schema_version, operation, outcome, kill_switch_engaged, evidence_json, recorded_at, encryption_verified, integrity_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.storeReference, record.backupReference, record.sha256, record.schemaVersion, record.operation, record.outcome, record.killSwitchEngaged ? 1 : 0, json(record.evidence ?? {}) ?? '{}', record.recordedAt, record.encryptionVerified ? 1 : 0, record.integrityCheck ?? 'not_recorded');
    });
  }

  public recordRetentionEvidence(record: RetentionEvidenceRecord): void {
    if (!Number.isInteger(record.rowsDeleted) || record.rowsDeleted < 0 || !Number.isInteger(record.rowsRetained) || record.rowsRetained < 0) throw new Error('retention row counts must be non-negative integers');
    this.immediate(() => {
      this.db.prepare('INSERT INTO retention_evidence (id, policy_id, entity_type, cutoff_at, rows_deleted, rows_retained, outcome, evidence_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.policyId, record.entityType, record.cutoffAt, record.rowsDeleted, record.rowsRetained, record.outcome, json(record.evidence ?? {}) ?? '{}', record.recordedAt);
    });
  }

  public isFinalSuccess(chainProfileId: string, receiptId: string): boolean {
    const row = this.db.prepare("SELECT r.finality_stage AS stage, c.success_finality_stage AS required FROM transaction_receipt r JOIN transaction_attempt a ON a.id = r.transaction_attempt_id JOIN transaction_intent i ON i.id = a.transaction_intent_id JOIN wallet w ON w.id = i.wallet_id JOIN chain_profile c ON c.id = w.chain_profile_id WHERE r.id = ? AND c.id = ?").get(receiptId, chainProfileId) as { stage: string; required: string } | undefined;
    return row !== undefined && row.stage === row.required;
  }

  public saveExecutionBundle(execution: ExecutionRecord, intent: TransactionIntentRecord, lifecycle: LifecycleEventRecord, audit: AuditEventRecord): void {
    this.immediate(() => {
      this.saveIntent(intent);
      this.saveExecution(execution);
      this.recordLifecycleEvent(lifecycle);
      this.recordAuditEvent(audit);
    });
  }
}
