import type { SqliteDatabase } from './database.js';
import { DurableRepository } from './repositories.js';
import type { AlertDeliveryRecord, AlertRecord, DomainEventRecord, FinalityObservationRecord, FreshnessObservationRecord, JobRecord, OpportunityEvidenceRecord, OpportunityGateCheckRecord, OpportunityRecord, OpportunityRiskRecord, OpportunityScoreRecord, ProvenanceRecord, ReadinessSnapshotRecord, SpendSummaryRecord, TrackedWalletRecord, WalletBalanceRecord, WalletMetadataRecord } from './phase2.js';
import { ReadModels } from './read-models.js';
import type { ActiveExecutionRow, ChainVerificationRow, DuplicateNonceIdentityRow, OrphanReservationRow, PendingReconciliationRow, ReadinessRow, ReorgExposureRow, ReplacementExposureRow, StaleSimulationRow } from './read-models.js';
import type { AlertRow, EventRow, FinalityObservationView, JobRow, OpportunityDetailRow, SpendSummaryRow, WalletMetadataRow } from './phase2.js';
import type { AuditEventRecord, ChainVerificationRecord, ExecutionRecord, ExecutionRunRecord, ReceiptRecord, ReconciliationRecord, ReorgEventRecord, ReorgResolutionRecord, RetentionEvidenceRecord, SimulationRecord, TransactionAttemptRecord, TransactionIntentRecord } from './repositories.js';
import { SpendReservations } from './spend-reservations.js';
import type { ExecutionReservationRequest, ReservationStatus, SettlementComponents } from './spend-reservations.js';

export interface BackendStore {
  saveRun(record: ExecutionRunRecord): void;
  saveIntent(record: TransactionIntentRecord): void;
  recordAttempt(record: TransactionAttemptRecord): void;
  recordSimulation(record: SimulationRecord): void;
  saveExecution(record: ExecutionRecord): void;
  transitionExecution(id: string, newState: string, lifecycle: Omit<import('./repositories.js').LifecycleEventRecord, 'entityId' | 'priorState' | 'newState'>, audit?: Omit<import('./repositories.js').AuditEventRecord, 'entityId' | 'priorState' | 'newState'>): void;
  recordReceipt(record: ReceiptRecord): void;
  recordReconciliation(record: ReconciliationRecord): void;
  recordReorgEvent(record: ReorgEventRecord): void;
  recordReorgResolution(record: ReorgResolutionRecord): void;
  recordAuditEvent(record: AuditEventRecord): void;
  recordChainVerification(record: ChainVerificationRecord): void;
  recordRetentionEvidence(record: RetentionEvidenceRecord): void;
  reserveExecution(request: ExecutionReservationRequest): ReservationStatus;
  reserveExecutionBundle(intent: TransactionIntentRecord, execution: ExecutionRecord, request: ExecutionReservationRequest): ReservationStatus;
  settleExecution(id: string, mintValueWei: bigint, l2ExecutionGasWei: bigint, l1DataGasWei: bigint): void;
  settleExecutionComponents(id: string, components: SettlementComponents, at?: Date): void;
  readiness(campaignId: string, asOf?: Date): ReadinessRow[];
  activeExecutions(): ActiveExecutionRow[];
  pendingReconciliation(): PendingReconciliationRow[];
  orphanReservations(): OrphanReservationRow[];
  duplicateNonceIdentities(): DuplicateNonceIdentityRow[];
  staleSimulations(asOf?: Date): StaleSimulationRow[];
  reorgExposure(): ReorgExposureRow[];
  replacementExposure(): ReplacementExposureRow[];
  chainVerification(chainProfileId: string): ChainVerificationRow | null;
  setKillSwitch(engaged: boolean, changedBy: string, at?: Date): void;
  isKillSwitchEngaged(): boolean;
  saveWalletMetadata(record: WalletMetadataRecord): void;
  recordWalletBalance(record: WalletBalanceRecord): void;
  setTrackedWallet(record: TrackedWalletRecord): void;
  recordProvenance(record: ProvenanceRecord): void;
  recordFreshness(record: FreshnessObservationRecord): void;
  saveJob(record: JobRecord): void;
  recoverExpiredJobs(at?: Date): number;
  claimJob(id: string, leaseOwner: string, leaseExpiresAt: string, at?: Date): JobRecord | null;
  completeJob(id: string, leaseOwner?: string, at?: Date): void;
  failJob(id: string, error: string, leaseOwner?: string, at?: Date): void;
  retryJob(id: string, scheduledAt: string, at?: Date): void;
  appendEvent(record: DomainEventRecord): string;
  recordReadiness(record: ReadinessSnapshotRecord): void;
  saveOpportunity(record: OpportunityRecord): void;
  recordOpportunityEvidence(record: OpportunityEvidenceRecord): void;
  recordOpportunityScore(record: OpportunityScoreRecord): void;
  recordOpportunityRisk(record: OpportunityRiskRecord): void;
  recordOpportunityGateCheck(record: OpportunityGateCheckRecord): void;
  enqueueAlert(record: AlertRecord): AlertDeliveryRecord;
  claimAlertDelivery(id: string, at?: Date): AlertDeliveryRecord | null;
  completeAlertDelivery(id: string, at?: Date): void;
  failAlertDelivery(id: string, error: string, nextAttemptAt?: string, at?: Date): void;
  retryAlertDelivery(id: string, nextAttemptAt: string, at?: Date): void;
  deadLetterAlertDelivery(id: string, at?: Date): void;
  recordFinalityObservation(record: FinalityObservationRecord): void;
  refreshSpendSummary(scopeType: SpendSummaryRecord['scopeType'], scopeId: string, options?: { usageDate?: string; walletId?: string; campaignId?: string; sourceVersion?: string; asOf?: string; provenanceId?: string }): SpendSummaryRecord;
  wallets(asOf?: Date): WalletMetadataRow[];
  wallet(walletId: string, asOf?: Date): WalletMetadataRow | null;
  jobs(state?: JobRow['state']): JobRow[];
  dueJobs(asOf?: Date): JobRow[];
  events(entityType?: string, entityId?: string): EventRow[];
  alerts(state?: AlertRow['deliveryState']): AlertRow[];
  finalityHistory(executionId: string): FinalityObservationView[];
  readinessSnapshots(campaignId: string, walletId?: string): ReturnType<ReadModels['readinessSnapshots']>;
  spendSummaries(scopeType?: SpendSummaryRow['scopeType'], scopeId?: string, asOf?: Date): SpendSummaryRow[];
  opportunityDetails(opportunityId: string, asOf?: Date): OpportunityDetailRow | null;
}

export class SqliteBackendStore implements BackendStore {
  private readonly repository: DurableRepository;
  private readonly reservations: SpendReservations;
  private readonly readModels: ReadModels;

  public constructor(private readonly db: SqliteDatabase) {
    this.repository = new DurableRepository(db);
    this.reservations = new SpendReservations(db);
    this.readModels = new ReadModels(db);
  }

  public saveRun(record: ExecutionRunRecord): void { this.repository.saveRun(record); }
  public saveIntent(record: TransactionIntentRecord): void { this.repository.saveIntent(record); }
  public recordAttempt(record: TransactionAttemptRecord): void { this.repository.recordAttempt(record); }
  public recordSimulation(record: SimulationRecord): void { this.repository.recordSimulation(record); }
  public saveExecution(record: ExecutionRecord): void { this.repository.saveExecution(record); }
  public transitionExecution(id: string, newState: string, lifecycle: Omit<import('./repositories.js').LifecycleEventRecord, 'entityId' | 'priorState' | 'newState'>, audit?: Omit<import('./repositories.js').AuditEventRecord, 'entityId' | 'priorState' | 'newState'>): void { this.repository.transitionExecution(id, newState, lifecycle, audit); }
  public recordReceipt(record: ReceiptRecord): void { this.repository.recordReceipt(record); }
  public recordReconciliation(record: ReconciliationRecord): void { this.repository.recordReconciliation(record); }
  public recordReorgEvent(record: ReorgEventRecord): void { this.repository.recordReorgEvent(record); }
  public recordReorgResolution(record: ReorgResolutionRecord): void { this.repository.recordReorgResolution(record); }
  public recordAuditEvent(record: AuditEventRecord): void { this.repository.recordAuditEvent(record); }
  public recordChainVerification(record: ChainVerificationRecord): void { this.repository.recordChainVerification(record); }
  public recordRetentionEvidence(record: RetentionEvidenceRecord): void { this.repository.recordRetentionEvidence(record); }
  public reserveExecution(request: ExecutionReservationRequest): ReservationStatus { return this.reservations.reserveExecution(request); }
  public reserveExecutionBundle(intent: TransactionIntentRecord, execution: ExecutionRecord, request: ExecutionReservationRequest): ReservationStatus {
    if (execution.transactionIntentId !== intent.id || request.transactionIntentId !== intent.id || request.executionId !== execution.id) throw new Error('execution reservation bundle identity mismatch');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.repository.saveIntent(intent);
      this.repository.saveExecution(execution);
      const result = this.reservations.reserveExecution(request);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  public settleExecution(id: string, mintValueWei: bigint, l2ExecutionGasWei: bigint, l1DataGasWei: bigint): void { this.reservations.settleExecution(id, mintValueWei, l2ExecutionGasWei, l1DataGasWei); }
  public settleExecutionComponents(id: string, components: SettlementComponents, at?: Date): void { this.reservations.settleExecutionComponents(id, components, at); }
  public readiness(campaignId: string, asOf?: Date): ReadinessRow[] { return this.readModels.readiness(campaignId, asOf); }
  public activeExecutions(): ActiveExecutionRow[] { return this.readModels.activeExecutions(); }
  public pendingReconciliation(): PendingReconciliationRow[] { return this.readModels.pendingReconciliation(); }
  public orphanReservations(): OrphanReservationRow[] { return this.readModels.orphanReservations(); }
  public duplicateNonceIdentities(): DuplicateNonceIdentityRow[] { return this.readModels.duplicateNonceIdentities(); }
  public staleSimulations(asOf?: Date): StaleSimulationRow[] { return this.readModels.staleSimulations(asOf); }
  public reorgExposure(): ReorgExposureRow[] { return this.readModels.reorgExposure(); }
  public replacementExposure(): ReplacementExposureRow[] { return this.readModels.replacementExposure(); }
  public chainVerification(chainProfileId: string): ChainVerificationRow | null { return this.readModels.chainVerification(chainProfileId); }
  public setKillSwitch(engaged: boolean, changedBy: string, at?: Date): void { this.reservations.setKillSwitch(engaged, changedBy, at); }
  public isKillSwitchEngaged(): boolean { return this.reservations.isKillSwitchEngaged(); }
  public saveWalletMetadata(record: WalletMetadataRecord): void { this.repository.saveWalletMetadata(record); }
  public recordWalletBalance(record: WalletBalanceRecord): void { this.repository.recordWalletBalance(record); }
  public setTrackedWallet(record: TrackedWalletRecord): void { this.repository.setTrackedWallet(record); }
  public recordProvenance(record: ProvenanceRecord): void { this.repository.recordProvenance(record); }
  public recordFreshness(record: FreshnessObservationRecord): void { this.repository.recordFreshness(record); }
  public saveJob(record: JobRecord): void { this.repository.saveJob(record); }
  public recoverExpiredJobs(at?: Date): number { return this.repository.recoverExpiredJobs(at); }
  public claimJob(id: string, leaseOwner: string, leaseExpiresAt: string, at?: Date): JobRecord | null { return this.repository.claimJob(id, leaseOwner, leaseExpiresAt, at); }
  public completeJob(id: string, leaseOwner?: string, at?: Date): void { this.repository.completeJob(id, leaseOwner, at); }
  public failJob(id: string, error: string, leaseOwner?: string, at?: Date): void { this.repository.failJob(id, error, leaseOwner, at); }
  public retryJob(id: string, scheduledAt: string, at?: Date): void { this.repository.retryJob(id, scheduledAt, at); }
  public appendEvent(record: DomainEventRecord): string { return this.repository.appendEvent(record); }
  public recordReadiness(record: ReadinessSnapshotRecord): void { this.repository.recordReadiness(record); }
  public saveOpportunity(record: OpportunityRecord): void { this.repository.saveOpportunity(record); }
  public recordOpportunityEvidence(record: OpportunityEvidenceRecord): void { this.repository.recordOpportunityEvidence(record); }
  public recordOpportunityScore(record: OpportunityScoreRecord): void { this.repository.recordOpportunityScore(record); }
  public recordOpportunityRisk(record: OpportunityRiskRecord): void { this.repository.recordOpportunityRisk(record); }
  public recordOpportunityGateCheck(record: OpportunityGateCheckRecord): void { this.repository.recordOpportunityGateCheck(record); }
  public enqueueAlert(record: AlertRecord): AlertDeliveryRecord { return this.repository.enqueueAlert(record); }
  public claimAlertDelivery(id: string, at?: Date): AlertDeliveryRecord | null { return this.repository.claimAlertDelivery(id, at); }
  public completeAlertDelivery(id: string, at?: Date): void { this.repository.completeAlertDelivery(id, at); }
  public failAlertDelivery(id: string, error: string, nextAttemptAt?: string, at?: Date): void { this.repository.failAlertDelivery(id, error, nextAttemptAt, at); }
  public retryAlertDelivery(id: string, nextAttemptAt: string, at?: Date): void { this.repository.retryAlertDelivery(id, nextAttemptAt, at); }
  public deadLetterAlertDelivery(id: string, at?: Date): void { this.repository.deadLetterAlertDelivery(id, at); }
  public recordFinalityObservation(record: FinalityObservationRecord): void { this.repository.recordFinalityObservation(record); }
  public refreshSpendSummary(scopeType: SpendSummaryRecord['scopeType'], scopeId: string, options?: { usageDate?: string; walletId?: string; campaignId?: string; sourceVersion?: string; asOf?: string; provenanceId?: string }): SpendSummaryRecord { return this.repository.refreshSpendSummary(scopeType, scopeId, options); }
  public wallets(asOf?: Date): WalletMetadataRow[] { return this.readModels.wallets(asOf); }
  public wallet(walletId: string, asOf?: Date): WalletMetadataRow | null { return this.readModels.wallet(walletId, asOf); }
  public jobs(state?: JobRow['state']): JobRow[] { return this.readModels.jobs(state); }
  public dueJobs(asOf?: Date): JobRow[] { return this.readModels.dueJobs(asOf); }
  public events(entityType?: string, entityId?: string): EventRow[] { return this.readModels.events(entityType, entityId); }
  public alerts(state?: AlertRow['deliveryState']): AlertRow[] { return this.readModels.alerts(state); }
  public finalityHistory(executionId: string): FinalityObservationView[] { return this.readModels.finalityHistory(executionId); }
  public readinessSnapshots(campaignId: string, walletId?: string): ReturnType<ReadModels['readinessSnapshots']> { return this.readModels.readinessSnapshots(campaignId, walletId); }
  public spendSummaries(scopeType?: SpendSummaryRow['scopeType'], scopeId?: string, asOf?: Date): SpendSummaryRow[] { return this.readModels.spendSummaries(scopeType, scopeId, asOf); }
  public opportunityDetails(opportunityId: string, asOf?: Date): OpportunityDetailRow | null { return this.readModels.opportunityDetails(opportunityId, asOf); }
}
