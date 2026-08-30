import type { SqliteDatabase } from './database.js';
import { DurableRepository } from './repositories.js';
import type { AuditEventRecord, ChainVerificationRecord, ExecutionRecord, ReceiptRecord, ReconciliationRecord, SimulationRecord, TransactionAttemptRecord, TransactionIntentRecord } from './repositories.js';
import { ReadModels } from './read-models.js';
import type { ActiveExecutionRow, ChainVerificationRow, PendingReconciliationRow, ReadinessRow } from './read-models.js';
import { SpendReservations } from './spend-reservations.js';
import type { ExecutionReservationRequest, ReservationStatus } from './spend-reservations.js';

export interface BackendStore {
  saveIntent(record: TransactionIntentRecord): void;
  recordAttempt(record: TransactionAttemptRecord): void;
  recordSimulation(record: SimulationRecord): void;
  saveExecution(record: ExecutionRecord): void;
  recordReceipt(record: ReceiptRecord): void;
  recordReconciliation(record: ReconciliationRecord): void;
  recordAuditEvent(record: AuditEventRecord): void;
  recordChainVerification(record: ChainVerificationRecord): void;
  reserveExecution(request: ExecutionReservationRequest): ReservationStatus;
  settleExecution(id: string, mintValueWei: bigint, l2ExecutionGasWei: bigint, l1DataGasWei: bigint): void;
  readiness(campaignId: string, asOf?: Date): ReadinessRow[];
  activeExecutions(): ActiveExecutionRow[];
  pendingReconciliation(): PendingReconciliationRow[];
  chainVerification(chainProfileId: string): ChainVerificationRow | null;
  setKillSwitch(engaged: boolean, changedBy: string, at?: Date): void;
  isKillSwitchEngaged(): boolean;
}

export class SqliteBackendStore implements BackendStore {
  private readonly repository: DurableRepository;
  private readonly reservations: SpendReservations;
  private readonly readModels: ReadModels;

  public constructor(db: SqliteDatabase) {
    this.repository = new DurableRepository(db);
    this.reservations = new SpendReservations(db);
    this.readModels = new ReadModels(db);
  }

  public saveIntent(record: TransactionIntentRecord): void { this.repository.saveIntent(record); }
  public recordAttempt(record: TransactionAttemptRecord): void { this.repository.recordAttempt(record); }
  public recordSimulation(record: SimulationRecord): void { this.repository.recordSimulation(record); }
  public saveExecution(record: ExecutionRecord): void { this.repository.saveExecution(record); }
  public recordReceipt(record: ReceiptRecord): void { this.repository.recordReceipt(record); }
  public recordReconciliation(record: ReconciliationRecord): void { this.repository.recordReconciliation(record); }
  public recordAuditEvent(record: AuditEventRecord): void { this.repository.recordAuditEvent(record); }
  public recordChainVerification(record: ChainVerificationRecord): void { this.repository.recordChainVerification(record); }
  public reserveExecution(request: ExecutionReservationRequest): ReservationStatus { return this.reservations.reserveExecution(request); }
  public settleExecution(id: string, mintValueWei: bigint, l2ExecutionGasWei: bigint, l1DataGasWei: bigint): void { this.reservations.settleExecution(id, mintValueWei, l2ExecutionGasWei, l1DataGasWei); }
  public readiness(campaignId: string, asOf?: Date): ReadinessRow[] { return this.readModels.readiness(campaignId, asOf); }
  public activeExecutions(): ActiveExecutionRow[] { return this.readModels.activeExecutions(); }
  public pendingReconciliation(): PendingReconciliationRow[] { return this.readModels.pendingReconciliation(); }
  public chainVerification(chainProfileId: string): ChainVerificationRow | null { return this.readModels.chainVerification(chainProfileId); }
  public setKillSwitch(engaged: boolean, changedBy: string, at?: Date): void { this.reservations.setKillSwitch(engaged, changedBy, at); }
  public isKillSwitchEngaged(): boolean { return this.reservations.isKillSwitchEngaged(); }
}
