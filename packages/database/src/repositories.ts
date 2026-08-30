import type { SqliteDatabase } from './database.js';

export interface TransactionIntentRecord {
  id: string;
  campaignId: string;
  walletId: string;
  intentClass: string;
  toAddress: string;
  valueWei: bigint;
  calldata: string;
  nonce?: number;
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
  recordedAt: string;
}

const json = (value: unknown): string | null => value === undefined ? null : JSON.stringify(value);

export class DurableRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public saveIntent(record: TransactionIntentRecord): void {
    this.db.prepare('INSERT INTO transaction_intent (id, campaign_id, wallet_id, intent_class, to_address, value_wei, calldata, nonce, policy_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.intentClass, record.toAddress, record.valueWei.toString(), record.calldata, record.nonce ?? null, json(record.policySnapshot), record.createdAt);
  }

  public recordAttempt(record: TransactionAttemptRecord): void {
    this.db.prepare('INSERT INTO transaction_attempt (id, transaction_intent_id, endpoint, response_class, latency_ms, tx_hash, nonce, replacement_of_id, redacted_error, attempted_at, from_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT w.address FROM wallet w JOIN transaction_intent i ON i.wallet_id = w.id WHERE i.id = ?))').run(record.id, record.transactionIntentId, record.endpoint, record.responseClass, record.latencyMs ?? null, record.txHash ?? null, record.nonce ?? null, record.replacementOfId ?? null, record.redactedError ?? null, record.attemptedAt, record.transactionIntentId);
  }

  public recordSimulation(record: SimulationRecord): void {
    this.db.prepare('INSERT INTO simulation (id, wallet_id, campaign_id, transaction_intent_id, source_block_number, source_block_hash, checked_at, freshness_seconds, outcome, revert_taxonomy, tool_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.walletId, record.campaignId, record.transactionIntentId ?? null, record.sourceBlockNumber, record.sourceBlockHash ?? null, record.checkedAt, record.freshnessSeconds, record.outcome, record.revertTaxonomy ?? null, record.toolVersion, JSON.stringify(record.details ?? {}));
  }

  public saveExecution(record: ExecutionRecord): void {
    this.db.prepare('INSERT INTO execution (id, campaign_id, wallet_id, transaction_intent_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.id, record.campaignId, record.walletId, record.transactionIntentId, record.state, record.createdAt, record.updatedAt);
  }

  public recordReceipt(record: ReceiptRecord): void {
    this.db.prepare('INSERT INTO transaction_receipt (id, transaction_attempt_id, tx_hash, status, block_number, block_hash, confirmations, gas_used, effective_gas_price, finality_stage, finality_source, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.transactionAttemptId, record.txHash, record.status, record.blockNumber ?? null, record.blockHash ?? null, record.confirmations, record.gasUsed?.toString() ?? null, record.effectiveGasPrice?.toString() ?? null, record.finalityStage ?? 'unknown', record.finalitySource ?? null, record.observedAt);
  }

  public recordLifecycleEvent(record: LifecycleEventRecord): void {
    this.db.prepare('INSERT INTO state_transition (id, entity_type, entity_id, prior_state, new_state, actor, source, reason, policy_version, evidence_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState, record.actor, record.source, record.reason, record.policyVersion ?? null, json(record.evidenceSnapshot), record.occurredAt);
  }

  public recordAuditEvent(record: AuditEventRecord): void {
    this.db.prepare('INSERT INTO audit_event (id, entity_type, entity_id, prior_state, new_state, actor, reason, evidence_snapshot_json, policy_snapshot_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.entityType, record.entityId, record.priorState ?? null, record.newState ?? null, record.actor, record.reason, json(record.evidenceSnapshot), json(record.policySnapshot), record.occurredAt);
  }

  public recordChainVerification(record: ChainVerificationRecord): void {
    const profile = this.db.prepare('SELECT chain_id FROM chain_profile WHERE id = ?').get(record.chainProfileId) as { chain_id: number } | undefined;
    if (!profile || profile.chain_id !== record.chainId) throw new Error('chain verification identity mismatch');
    if (record.chainId === 4663 && record.sequencerEndpointReference !== 'https://sequencer.mainnet.chain.robinhood.com') throw new Error('Robinhood sequencer reference is not the approved endpoint');
    if (record.chainId === 4663 && !record.archiveEndpointReference?.startsWith('Rets/MINT_BOT_SECRETS.env')) throw new Error('Robinhood archive endpoint must remain a Rets/MINT_BOT_SECRETS.env reference');
    this.db.prepare('INSERT INTO chain_verification (id, chain_profile_id, status, chain_id, sequencer_endpoint_reference, archive_endpoint_reference, feed_endpoint_reference, sea_drop_test_tx_hash, evidence_json, checked_at, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.status, record.chainId, record.sequencerEndpointReference ?? null, record.archiveEndpointReference ?? null, record.feedEndpointReference ?? null, record.seaDropTestTxHash ?? null, JSON.stringify(record.evidence ?? {}), record.checkedAt, record.approvedBy ?? null, record.approvedAt ?? null);
  }

  public recordReconciliation(record: ReconciliationRecord): void {
    this.db.prepare('INSERT INTO reconciliation_record (id, chain_profile_id, transaction_attempt_id, tx_hash, from_address, nonce, state, checked_at, source, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.transactionAttemptId ?? null, record.txHash ?? null, record.fromAddress ?? null, record.nonce ?? null, record.state, record.checkedAt, record.source, JSON.stringify(record.details ?? {}));
  }

  public saveFeePolicy(record: FeePolicyRecord): void {
    if (record.maxTotalFeeWei < 0n || record.freeMintTotalFeeCapWei < 0n) throw new Error('fee caps must be non-negative');
    const multiplier = record.freeMintPriorityFeeMultiplier ?? 2;
    if (!Number.isInteger(multiplier) || multiplier < 0 || multiplier > 2) throw new Error('free-mint priority fee multiplier must be between 0 and 2');
    this.db.prepare('INSERT INTO fee_policy (id, chain_profile_id, version, priority_fee_semantics, max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled, active, created_at, zero_priority_fee_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.chainProfileId, record.version, record.priorityFeeSemantics, record.maxTotalFeeWei.toString(), record.freeMintTotalFeeCapWei.toString(), (record.freeMintPriorityFeeComponentWei ?? 0n).toString(), multiplier, record.paidMintsEnabled ? 1 : 0, record.active ? 1 : 0, record.createdAt, record.zeroPriorityFeePolicy ?? 'requires_po_resolution');
  }

  public canExecuteChain(chainProfileId: string): boolean {
    const row = this.db.prepare("SELECT execution_enabled FROM chain_profile WHERE id = ? AND verification_status = 'verified'").get(chainProfileId) as { execution_enabled: number } | undefined;
    return row?.execution_enabled === 1;
  }

  public assertTotalFeeWithinPolicy(chainProfileId: string, totalFeeWei: bigint, freeMint = false, priorityFeeComponentWei = 0n): void {
    const row = this.db.prepare('SELECT max_total_fee_wei, free_mint_total_fee_cap_wei, free_mint_priority_fee_component_wei, free_mint_priority_fee_multiplier, paid_mints_enabled FROM fee_policy WHERE chain_profile_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1').get(chainProfileId) as { max_total_fee_wei: string; free_mint_total_fee_cap_wei: string; free_mint_priority_fee_component_wei: string; free_mint_priority_fee_multiplier: number; paid_mints_enabled: number } | undefined;
    if (!row) throw new Error('active total-fee policy not found');
    if (!freeMint && row.paid_mints_enabled !== 1) throw new Error('paid-mint policy is not approved');
    const cap = BigInt(freeMint ? row.free_mint_total_fee_cap_wei : row.max_total_fee_wei);
    if (totalFeeWei < 0n || totalFeeWei > cap) throw new Error('total fee exceeds policy');
    if (freeMint && priorityFeeComponentWei > BigInt(row.free_mint_priority_fee_component_wei) * BigInt(row.free_mint_priority_fee_multiplier)) throw new Error('priority fee component exceeds free-mint policy');
  }

  public recordDocumentationFixture(id: string, chainProfileId: string, txHash: string, fixtureType: 'external_wallet_failed' | 'positive_reference', notes: string, recordedAt: string): void {
    this.db.prepare('INSERT INTO documentation_fixture (id, chain_profile_id, tx_hash, fixture_type, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, chainProfileId, txHash, fixtureType, notes, recordedAt);
  }

  public saveBackupPolicy(record: BackupPolicyRecord): void {
    const retentionDays = record.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new Error('backup retention must be positive');
    this.db.prepare('INSERT INTO backup_policy (id, retention_days, encryption_required, approval_owner, approved_at, active) VALUES (?, ?, 1, ?, ?, 1)').run(record.id, retentionDays, record.approvalOwner, record.approvedAt);
  }

  public recordBackupRestoreEvidence(record: BackupRestoreEvidenceRecord): void {
    this.db.prepare('INSERT INTO backup_restore_evidence (id, store_reference, backup_reference, sha256, schema_version, operation, outcome, kill_switch_engaged, evidence_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.storeReference, record.backupReference, record.sha256, record.schemaVersion, record.operation, record.outcome, record.killSwitchEngaged ? 1 : 0, JSON.stringify(record.evidence ?? {}), record.recordedAt);
  }

  public isFinalSuccess(chainProfileId: string, receiptId: string): boolean {
    const row = this.db.prepare("SELECT r.finality_stage AS stage, c.success_finality_stage AS required FROM transaction_receipt r JOIN transaction_attempt a ON a.id = r.transaction_attempt_id JOIN transaction_intent i ON i.id = a.transaction_intent_id JOIN wallet w ON w.id = i.wallet_id JOIN chain_profile c ON c.id = w.chain_profile_id WHERE r.id = ? AND c.id = ?").get(receiptId, chainProfileId) as { stage: string; required: string } | undefined;
    return row !== undefined && row.stage === row.required;
  }

  public saveExecutionBundle(execution: ExecutionRecord, intent: TransactionIntentRecord, lifecycle: LifecycleEventRecord, audit: AuditEventRecord): void {
    const save = this.db.transaction(() => {
      this.saveIntent(intent);
      this.saveExecution(execution);
      this.recordLifecycleEvent(lifecycle);
      this.recordAuditEvent(audit);
    });
    save();
  }
}
