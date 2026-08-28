export type CampaignState = 'Draft' | 'Validating' | 'Ready' | 'Armed' | 'Active' | 'Paused' | 'Completed' | 'Failed' | 'Aborted' | 'Cancelled';
export type WalletReadiness = 'Unknown' | 'Unfunded' | 'Funded' | 'Eligible' | 'Ready' | 'Executing' | 'Minted' | 'Failed' | 'Skipped';
export type ExecutionState = 'Prepared' | 'Signed' | 'Submitted' | 'Pending' | 'Confirmed' | 'Reorged' | 'Replaced' | 'Failed';
export type RobinhoodFinality = 'soft' | 'posted' | 'final';
export type ChainVerificationStatus = 'unverified' | 'characterizing' | 'verified' | 'blocked';
export type CommandName = 'resolve' | 'validate' | 'prepare' | 'simulate' | 'arm' | 'execute' | 'reconcile' | 'health' | 'kill';

export interface Campaign {
  id: string; state: CampaignState; chainId: 1 | 4663; contract: string; strategy: string;
  quantity: number; dryRun: boolean; spendPolicy: SpendPolicy; createdAt: string; updatedAt: string;
  broadcastMode?: 'flashbots' | 'public' | 'sequencer';
  chainVerification: ChainVerification;
  mintPriceWei: bigint;
  feePolicy: FeePolicy;
}
export interface SpendPolicy { maxRunWei: bigint; dailyCapWei: bigint; gasCeilingWei: bigint; }
export interface FeePolicy { kind: 'free' | 'paid'; configuredPriorityFeeWei: bigint; freePriorityFeeCapWei?: bigint; l2ExecutionGasBudgetWei?: bigint; l1DataGasBudgetWei?: bigint; totalFeeBudgetWei?: bigint; }
export interface ChainVerification { chainId: 1 | 4663; status: ChainVerificationStatus; seaDropCompatible: boolean; evidenceId?: string; checkedAt?: string; sourceBlock?: bigint; endpointReference: string; }
export interface EventRecord { id: string; runId?: string; type: string; at: string; data: Record<string, unknown>; }
export interface RunRecord { id: string; intentId: string; campaignId: string; state: CampaignState; idempotencyKey?: string; createdAt: string; updatedAt: string; }
export interface IntentRecord { id: string; runId: string; campaignId: string; policy: SpendPolicy; feePolicy: FeePolicy; chainVerification: ChainVerification; simulationId: string; evidenceAt: string; createdAt: string; }
export interface AttemptRecord { id: string; executionId: string; runId: string; wallet: string; nonce: number; hash?: string; state: ExecutionState; robinhoodFinality?: RobinhoodFinality; createdAt: string; updatedAt: string; }
export interface ReconciliationRecord { id: string; runId: string; attemptId?: string; result: ReconciliationResult; observedAt: string; reason?: string; }
export interface ReceiptRecord { id: string; executionId: string; runId: string; state: ExecutionState; robinhoodFinality?: RobinhoodFinality; blockNumber?: bigint; observedAt: string; }
export interface Reservation { id: string; runId: string; campaignId: string; chainId?: 1 | 4663; wallet: string; amountWei: bigint; status: 'reserved' | 'settled' | 'released'; createdAt: string; }
export interface ReadinessCheck { wallet: string; state: WalletReadiness; freshUntil: string; sourceBlock?: bigint; blockingReasons: string[]; checks: Record<string, boolean>; }
export interface BackendState { campaigns: Campaign[]; runs: RunRecord[]; intents: IntentRecord[]; attempts: AttemptRecord[]; receipts: ReceiptRecord[]; reconciliations: ReconciliationRecord[]; reservations: Reservation[]; events: EventRecord[]; killed: boolean; killReason?: string; }
export interface ValidatedCampaign { campaign: Campaign; simulationId: string; evidenceAt: string; }
export interface EngineAdapter { execute(intent: { runId: string; intentId: string; campaign: Campaign; reservationIds: string[] }): Promise<ExecutionResult>; reconcile(run: RunRecord): Promise<ReconciliationResult>; }
export interface ExecutionResult { executionIds: string[]; attempts: AttemptRecord[]; state: ExecutionState; }
export type ReconciliationResult = 'confirmed' | 'failed' | 'unknown' | 'reorged' | 'soft' | 'posted' | 'final';
