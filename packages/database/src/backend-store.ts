import type { SqliteDatabase } from './database.js';
import { DurableRepository } from './repositories.js';
import type { AuditEventRecord, ChainVerificationRecord, ExecutionRecord, ExecutionRunRecord, ReceiptRecord, ReconciliationRecord, ReorgEventRecord, ReorgResolutionRecord, RetentionEvidenceRecord, SimulationRecord, TransactionAttemptRecord, TransactionIntentRecord } from './repositories.js';
import { ReadModels } from './read-models.js';
import type { ActiveExecutionRow, ChainVerificationRow, DuplicateNonceIdentityRow, OrphanReservationRow, PendingReconciliationRow, ReadinessRow, ReorgExposureRow, ReplacementExposureRow, StaleSimulationRow } from './read-models.js';
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
}
