export type CampaignState = 'Draft' | 'Validating' | 'Ready' | 'Armed' | 'Active' | 'Paused' | 'Completed' | 'Failed' | 'Aborted' | 'Cancelled';
export type WalletReadiness = 'Unknown' | 'Unfunded' | 'Funded' | 'Eligible' | 'Ready' | 'Executing' | 'Minted' | 'Failed' | 'Skipped';
export type ExecutionState = 'Prepared' | 'Signed' | 'Submitted' | 'Pending' | 'Confirmed' | 'Reorged' | 'Replaced' | 'Failed' | 'Aborted';
export type RobinhoodFinality = 'soft' | 'posted' | 'final';
export type ChainVerificationStatus = 'unverified' | 'characterizing' | 'verified' | 'blocked';
export type StartupState = 'Cold' | 'Reconciling' | 'Ready' | 'Blocked';
export type RobinhoodNegativeCase = 'revert' | 'sold_out' | 'price_drift' | 'insufficient_funds' | 'quantity_limit' | 'stale_phase' | 'fee_recipient' | 'kill' | 'cap';
export type CommandName = 'resolve' | 'validate' | 'prepare' | 'simulate' | 'dry-run' | 'approve' | 'arm' | 'run' | 'execute' | 'summary' | 'fund' | 'reconcile' | 'health' | 'kill';
export type JobKind = 'execute' | 'reconcile' | 'notification' | 'health' | 'phase2';
export type JobState = 'scheduled' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export type CheckOutcome = 'pass' | 'fail' | 'unknown' | 'stale';

export interface Provenance {
  kind: 'backend_store' | 'chain_observation' | 'eligibility_check' | 'simulation' | 'reconciliation' | 'notification_event';
  recordId: string;
  observedAt: string;
  sourceBlockNumber?: string;
  sourceBlockHash?: string;
  evidenceId?: string;
  policyVersion?: string;
}

export interface Freshness {
  status: 'fresh' | 'stale' | 'unknown';
  observedAt: string | null;
  expiresAt: string | null;
  ageSeconds: string | null;
  policyVersion: string | null;
}

/** A durable scheduler row. Payloads are allow-listed command inputs, never secrets. */
export interface ScheduledJobRecord {
  id: string;
  kind: JobKind;
  runId?: string;
  campaignId?: string;
  state: JobState;
  scheduledAt: string;
  targetAt?: string;
  tMinusMs: number;
  chainTimeOffsetMs: number;
  idempotencyKey: string;
  requestDigest: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string; state: CampaignState; chainId: 1 | 4663; contract: string; strategy: string;
  quantity: number; dryRun: boolean; spendPolicy: SpendPolicy; createdAt: string; updatedAt: string;
  broadcastMode?: 'flashbots' | 'public' | 'sequencer';
  chainVerification: ChainVerification;
  mintPriceWei: bigint;
  feePolicy: FeePolicy;
  /** Optional schedule metadata. The chain observation remains authoritative. */
  openingAt?: string;
  tMinusMs?: number;
}
export interface SpendPolicy { maxRunWei: bigint; dailyCapWei: bigint; gasCeilingWei: bigint; }
export interface FeePolicy { kind: 'free' | 'paid'; configuredPriorityFeeWei: bigint; freeTotalSpendCapWei?: bigint; l2ExecutionGasBudgetWei?: bigint; l1DataGasBudgetWei?: bigint; totalFeeBudgetWei?: bigint; }
export interface ChainVerification { chainId: 1 | 4663; status: ChainVerificationStatus; seaDropCompatible: boolean; evidenceId?: string; checkedAt?: string; sourceBlock?: bigint; endpointReference: string; }
export interface ChainEvidenceRecord { id: string; chainId: 1 | 4663; status: 'pending' | 'accepted' | 'rejected'; executionEnabled: boolean; seaDropCompatible: boolean; positiveLivePath: boolean; archiveForkPassed: boolean; negativeCases: Record<RobinhoodNegativeCase, boolean>; reconciliationPassed: boolean; finalityPassed: boolean; endpointIdentity: string; archiveEndpointIdentity?: string; strategyVersion: string; checkedAt: string; expiresAt: string; sourceBlock: bigint; sourceBlockHash: string; acceptedAt?: string; acceptedBy?: string; approvalProof?: string; }
export interface SimulationEvidenceRecord { id: string; campaignId: string; wallet: string; inputDigest: string; success: boolean; sourceBlock: bigint; sourceBlockHash: string; checkedAt: string; expiresAt: string; gasEstimate?: bigint; worstCaseFeeWei: bigint; }
export interface EventRecord { id: string; runId?: string; type: string; at: string; data: Record<string, unknown>; }
export interface NotificationOutboxRecord { id: string; sourceEventId: string; runId?: string; type: string; text: string; state: 'pending' | 'delivering' | 'delivered' | 'failed'; attempts: number; createdAt: string; deliveredAt?: string; lastError?: string; nextAttemptAt?: string; canonicalLink?: string; }
export interface RunRecord { id: string; intentId: string; campaignId: string; mode: 'dry-run' | 'live'; requestDigest: string; state: CampaignState; idempotencyKey?: string; createdAt: string; updatedAt: string; }
export interface IntentRecord { id: string; runId: string; campaignId: string; campaignSnapshot: Campaign; wallets: readonly string[]; policy: SpendPolicy; feePolicy: FeePolicy; chainVerification: ChainVerification; simulationIds: readonly string[]; evidenceAt: string; createdAt: string; }
export interface AttemptRecord { id: string; executionId: string; runId: string; wallet: string; nonce?: number; hash?: string; endpoint?: string; redactedError?: string; replacementOfId?: string; state: ExecutionState; robinhoodFinality?: RobinhoodFinality; createdAt: string; updatedAt: string; }
export interface ReconciliationRecord { id: string; runId: string; attemptId?: string; result: ReconciliationResult; observedAt: string; reason?: string; }
export interface ReceiptRecord { id: string; executionId: string; runId: string; transactionAttemptId?: string; state: ExecutionState; finalityStage?: 'soft' | 'posted' | 'ethereum_final'; robinhoodFinality?: RobinhoodFinality; blockNumber?: bigint; blockHash?: string; gasUsed?: bigint; effectiveGasPrice?: bigint; actualSpendWei?: bigint; observedAt: string; }
export interface Reservation { id: string; runId: string; campaignId: string; chainId?: 1 | 4663; wallet: string; amountWei: bigint; actualAmountWei?: bigint; accountingDate: string; status: 'reserved' | 'settled' | 'released' | 'reorged'; createdAt: string; updatedAt: string; }
export interface ReadinessCheck {
  wallet: string;
  campaignId?: string;
  state: WalletReadiness;
  freshUntil: string;
  sourceBlock?: bigint;
  sourceBlockHash?: string;
  observedAt?: string;
  blockingReasons: string[];
  checks: Record<string, boolean>;
  checkStates?: Record<string, CheckOutcome>;
  provenance?: Provenance[];
}
export interface DependencyReadiness { engine: boolean; chain: boolean; backup: boolean; notifications: boolean; }
export interface CustodyReadiness { provider: 'turnkey' | 'kms' | 'local' | 'custom'; providerIdentity: string; policyReference: string; policyDigest: string; policyStatus: 'approved' | 'rejected' | 'unknown'; healthStatus: 'healthy' | 'unhealthy' | 'unknown'; attestationStatus: 'verified' | 'failed' | 'unknown'; evidenceId: string; observedAt: string; expiresAt: string; }
export interface OperationalReadiness { secretStoreReference?: string; storePath?: string; signerReady?: boolean; custody?: CustodyReadiness; killSwitchEngaged: boolean; notificationReady: boolean; chainVerification: ChainVerificationStatus; lastReconciliationAt: string; observedAt: string; expiresAt: string; }
export interface RuntimeStatus { startupState: StartupState; reconciliationCompletedAt?: string; blockingReasons: string[]; dependencies: DependencyReadiness; operational?: OperationalReadiness; chainTimeOffsetMs?: number; chainTimeObservedAt?: string; }
export interface BackendState { schemaVersion: 1; campaigns: Campaign[]; runs: RunRecord[]; intents: IntentRecord[]; attempts: AttemptRecord[]; receipts: ReceiptRecord[]; reconciliations: ReconciliationRecord[]; reservations: Reservation[]; events: EventRecord[]; notificationOutbox: NotificationOutboxRecord[]; chainEvidence: ChainEvidenceRecord[]; simulations: SimulationEvidenceRecord[]; readiness: ReadinessCheck[]; jobs: ScheduledJobRecord[]; runtime: RuntimeStatus; killed: boolean; killReason?: string; }
export interface ValidatedCampaign { campaign: Campaign; simulationIds?: readonly string[]; wallets?: readonly string[]; evidenceAt: string; }
export interface StoreCapabilities { durable: boolean; atomicAcrossProcesses: boolean; }
export interface EngineAdapter { prepare(intent: { runId: string; intentId: string; campaign: Campaign; wallets: readonly string[] }): Promise<ExecutionResult>; execute(intent: { runId: string; intentId: string; campaign: Campaign; wallets: readonly string[]; reservationIds: string[] }): Promise<ExecutionResult>; reconcile(run: RunRecord): Promise<ReconciliationUpdate>; }
export interface ExecutionResult { executionIds: string[]; attempts: AttemptRecord[]; receipts: ReceiptRecord[]; state: ExecutionState; }
export interface ReconciliationUpdate { result: ReconciliationResult; attempts: AttemptRecord[]; receipts: ReceiptRecord[]; reason?: string; }
export type ReconciliationResult = 'confirmed' | 'failed' | 'unknown' | 'reorged' | 'soft' | 'posted' | 'final';
