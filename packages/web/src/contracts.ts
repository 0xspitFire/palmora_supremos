export const READ_MODEL_CONTRACT = 'mintbot.read-model' as const;
export const READ_MODEL_VERSION = '1' as const;
// The Backend/API handoff is still a proposal on this baseline. Keep the
// frontend package transport-agnostic until the owners accept the wire DTOs.
export const READ_MODEL_CONTRACT_STATUS = 'proposal' as const;

export type Availability = 'available' | 'partial' | 'stale' | 'unavailable';
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';
export type Consistency = 'snapshot' | 'partial';

export interface Freshness {
  status: FreshnessStatus;
  observedAt: string | null;
  expiresAt: string | null;
  ageSeconds: string | null;
  policyVersion: string | null;
}

export type ProvenanceKind =
  | 'backend_store'
  | 'chain_observation'
  | 'eligibility_check'
  | 'simulation'
  | 'calendar_source'
  | 'score_calculation'
  | 'reconciliation'
  | 'notification_event';

export interface Provenance {
  kind: ProvenanceKind;
  recordId: string;
  observedAt: string;
  sourceBlockNumber?: string;
  sourceBlockHash?: string;
  evidenceId?: string;
  modelVersion?: string;
  policyVersion?: string;
  sourceRef?: string;
}

export type SafeAction =
  | 'Inspect'
  | 'Refresh read model'
  | 'Resolve eligibility'
  | 'Fund wallet'
  | 'Validate again'
  | 'Wait for reconciliation'
  | 'No safe action';

export interface ReadModelIssue {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  retryable: boolean;
  safeAction: SafeAction;
  provenance?: Provenance;
}

export interface ReadModelSnapshot {
  id: string;
  capturedAt: string;
  consistency: Consistency;
}

export interface ReadModelEnvelope<T> {
  contract: typeof READ_MODEL_CONTRACT;
  version: typeof READ_MODEL_VERSION;
  requestId: string;
  generatedAt: string;
  snapshot: ReadModelSnapshot;
  availability: Availability;
  freshness: Freshness;
  data: T | null;
  issues: ReadModelIssue[];
  nextCursor?: string;
}

export interface EthAmount {
  value: string;
  asset: 'ETH';
  unit: 'wei';
  decimals: 18;
}

export interface FiatEstimate {
  value: string;
  currency: string;
  kind: 'estimate';
  freshness: Freshness;
}

export type AmountKind = 'estimated' | 'reserved' | 'actual' | 'unknown';

export interface SourcedAmount {
  amount: EthAmount | null;
  kind: AmountKind;
  freshness: Freshness;
  provenance: Provenance[];
}

export interface SourcedQuantity {
  value: string | null;
  unit: 'gas';
  freshness: Freshness;
  provenance: Provenance[];
}

export interface SourcedTime {
  value: string | null;
  freshness: Freshness;
  provenance: Provenance[];
}

export type CheckOutcome = 'pass' | 'fail' | 'unknown' | 'stale';

export interface GateCheck {
  code: string;
  outcome: CheckOutcome;
  required: boolean;
  message: string;
  evaluatedAt: string | null;
  validUntil: string | null;
  provenance?: Provenance;
  freshness: Freshness;
}

export interface GateSummary {
  decision: 'permitted' | 'blocked' | 'unknown';
  checks: GateCheck[];
  blockers: ReadModelIssue[];
  nextAction: SafeAction;
}

export interface RetryPolicy {
  allowed: boolean;
  kind: 'none' | 'refresh_read' | 'reconcile' | 'replace' | 'resubmit' | 'rerun';
  reasonCode: string;
  message: string;
  requiresFreshData: boolean;
  safeAction: SafeAction;
}

export interface ScoreFactor {
  code: string;
  contribution: number;
  explanation: string;
  provenance: Provenance[];
  freshness: Freshness;
}

export interface RiskFlag {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  provenance?: Provenance;
  freshness: Freshness;
}

export interface EvidenceRow {
  id: string;
  label: string;
  summary: string;
  provenance: Provenance[];
  freshness: Freshness;
}

export interface ReadinessSummary {
  total: string;
  ready: string;
  blocked: string;
  unknown: string;
  stale: string;
  ineligible: string;
  executing: string;
  freshness: Freshness;
}

export type CampaignState =
  | 'Draft'
  | 'Validating'
  | 'Ready'
  | 'Armed'
  | 'Active'
  | 'Paused'
  | 'Completed'
  | 'Failed'
  | 'Aborted'
  | 'Cancelled';

export interface CampaignSummary {
  id: string;
  state: CampaignState;
  chainId: string;
  contract: string | null;
  quantity: string;
  cost: SourcedAmount;
  gate: GateSummary;
  freshness: Freshness;
  provenance: Provenance[];
}

export interface OpportunityReadModel {
  id: string;
  project: { name: string | null; contract: string | null };
  chain: { id: string; name: string; verification: GateSummary };
  disposition:
    | 'discovered'
    | 'evaluating'
    | 'scored'
    | 'notified'
    | 'approved'
    | 'promoted'
    | 'rejected'
    | 'expired';
  openingAt: string | null;
  price: SourcedAmount | null;
  score: {
    value: number | null;
    modelVersion: string | null;
    confidence: {
      sampleSize: string;
      denominator: string | null;
      label: 'low' | 'medium' | 'high' | 'unknown';
    };
    factors: ScoreFactor[];
    freshness: Freshness;
    provenance: Provenance[];
  };
  risks: RiskFlag[];
  evidence: EvidenceRow[];
  gate: GateSummary;
  readiness: ReadinessSummary | null;
  nextAction: 'Inspect';
  freshness: Freshness;
  provenance: Provenance[];
}

export type CalendarSourceAuthority = 'on_chain' | 'operator_record' | 'external_source';

export interface CalendarEligibilitySummary {
  eligible: string;
  ineligible: string;
  unknown: string;
  ready: string;
  stale: string;
}

export interface CalendarEntry {
  id: string;
  project: {
    name: string | null;
    collection: string | null;
    contract: string | null;
  };
  chain: { id: string; name: string };
  opening: SourcedTime;
  closing: SourcedTime | null;
  phase: string | null;
  price: SourcedAmount | null;
  supply: string | null;
  perWalletLimit: string | null;
  method: string | null;
  access: 'public' | 'fcfs' | 'allowlist' | 'unknown';
  expectedGas: SourcedAmount | null;
  sourceAuthority: CalendarSourceAuthority;
  verificationStatus: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  eligibility: CalendarEligibilitySummary;
  nextAction: 'Inspect';
  freshness: Freshness;
  provenance: Provenance[];
}

export interface ReadinessRow {
  campaignId: string;
  wallet: { id: string; address: string; label: string | null };
  state: 'Unknown' | 'Unfunded' | 'Funded' | 'Eligible' | 'Ready' | 'Executing' | 'Minted' | 'Failed' | 'Skipped';
  decision: 'ready' | 'blocked' | 'unknown' | 'stale';
  checks: GateCheck[];
  blockers: ReadModelIssue[];
  cost: {
    mintValue: SourcedAmount;
    executionGas: SourcedAmount;
    dataPostingGas: SourcedAmount | null;
    priorityFeeComponent: SourcedAmount | null;
    estimatedTotal: SourcedAmount;
    balance: SourcedAmount | null;
  };
  nextAction: SafeAction;
  freshness: Freshness;
  provenance: Provenance[];
}

export interface AttentionItem {
  id: string;
  severity: 'info' | 'warning' | 'blocking';
  subjectId: string;
  state: string;
  reason: string;
  freshness: Freshness;
  provenance: Provenance[];
  nextAction: SafeAction;
}

export type AlertDeliveryState = 'pending' | 'delivering' | 'delivered' | 'failed' | 'unknown';

export interface AlertReadModel {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'blocking';
  subjectId: string | null;
  message: string;
  state: AlertDeliveryState;
  createdAt: string;
  deliveredAt: string | null;
  canonicalPath: string | null;
  nextAction: 'Inspect';
  freshness: Freshness;
  provenance: Provenance[];
}

export interface SystemHealth {
  state: 'Ready' | 'Not ready' | 'Killed' | 'Unknown';
  killSwitch: 'clear' | 'engaged' | 'unknown';
  dependencies: {
    engine: 'ready' | 'not_ready' | 'unknown';
    chain: 'ready' | 'not_ready' | 'unknown';
    backup: 'ready' | 'not_ready' | 'unknown';
    notifications: 'ready' | 'not_ready' | 'unknown';
    reconciliation: 'clear' | 'required' | 'in_progress' | 'unknown';
  };
  blockers: ReadModelIssue[];
  checkedAt: string;
  freshness: Freshness;
}

export interface HomeReadModel {
  attention: AttentionItem[];
  readinessSummary: ReadinessSummary;
  opportunities: OpportunityReadModel[];
  calendarHighlights: CalendarEntry[];
  alerts: AlertReadModel[];
  system: SystemHealth;
}

export interface ReadinessReadModel {
  campaign: CampaignSummary | null;
  summary: ReadinessSummary;
  rows: ReadinessRow[];
}

export interface CalendarReadModel {
  entries: CalendarEntry[];
}

export interface AlertsReadModel {
  alerts: AlertReadModel[];
}

export interface Finality {
  stage: 'unknown' | 'confirmed' | 'soft' | 'posted' | 'ethereum_final';
  requiredStage: 'confirmed' | 'ethereum_final';
  settlementReached: boolean;
  observedAt: string | null;
  freshness: Freshness;
  provenance: Provenance[];
  downgradeReason?: string;
}

export interface OutcomeReason {
  code: string;
  label: 'Cancelled' | 'Aborted' | 'Failed' | 'Unknown';
  message: string;
  actor: 'operator' | 'safety_control' | 'adaptive_stop' | 'backend' | 'chain' | 'unknown';
  occurredAt: string;
  submittedWork: 'none' | 'some' | 'all' | 'unknown';
  retry: RetryPolicy;
  provenance?: Provenance;
}

export interface WalletExecutionResult {
  walletId: string;
  address: string;
  state: string;
  attemptIds: string[];
  finality: Finality | null;
  reason?: OutcomeReason;
  retry: RetryPolicy;
  freshness: Freshness;
}

export interface TransactionAttempt {
  id: string;
  walletId: string;
  hash: string | null;
  nonce: string | null;
  attemptNumber: string;
  replacementOfId: string | null;
  state: string;
  finality: Finality | null;
  retry: RetryPolicy;
  reason?: ReadModelIssue;
  provenance: Provenance[];
}

export interface TransactionReceipt {
  id: string;
  attemptId: string;
  hash: string;
  status: 'pending' | 'confirmed' | 'reverted' | 'reorged' | 'dropped';
  blockNumber: string | null;
  blockHash: string | null;
  gasUsed: SourcedQuantity | null;
  effectiveGasPrice: SourcedAmount | null;
  actualSpend: SourcedAmount | null;
  finality: Finality;
  provenance: Provenance[];
}

export interface ReconciliationObservation {
  id: string;
  state: 'unresolved' | 'matched' | 'ambiguous' | 'reorged' | 'final';
  observedAt: string;
  reason: string | null;
  retry: RetryPolicy;
  provenance: Provenance[];
}

export interface TimelineEvent {
  id: string;
  type: string;
  state: string | null;
  occurredAt: string;
  message: string;
  provenance?: Provenance;
}

export interface RunReadModel {
  run: {
    id: string;
    campaignId: string;
    mode: 'dry-run' | 'live';
    state: CampaignState;
    outcome: 'not_started' | 'dry_run_completed' | 'partial' | 'settled' | 'unknown';
    createdAt: string;
    updatedAt: string;
    retry: RetryPolicy;
    reason?: OutcomeReason | null;
  };
  campaign: CampaignSummary;
  walletResults: WalletExecutionResult[];
  attempts: TransactionAttempt[];
  receipts: TransactionReceipt[];
  reconciliations: ReconciliationObservation[];
  events: TimelineEvent[];
  freshness: Freshness;
  provenance: Provenance[];
}

export interface ReadOnlySnapshot {
  home?: ReadModelEnvelope<HomeReadModel>;
  readiness?: ReadModelEnvelope<ReadinessReadModel>;
  calendar?: ReadModelEnvelope<CalendarReadModel>;
  alerts?: ReadModelEnvelope<AlertsReadModel>;
  health?: ReadModelEnvelope<SystemHealth>;
  run?: ReadModelEnvelope<RunReadModel>;
}
