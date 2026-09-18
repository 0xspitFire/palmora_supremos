import { createHash } from 'node:crypto';
import type {
  AttemptRecord,
  BackendState,
  Campaign,
  EventRecord,
  ReceiptRecord,
  ReconciliationRecord,
  RunRecord,
  SimulationEvidenceRecord,
} from './types.js';

/** Versioned, read-only projection namespace for Phase 2 consumers. */
export const READ_MODEL_CONTRACT = 'mintbot.read-model' as const;
export const READ_MODEL_VERSION = '1' as const;

export type ReadModelAvailability = 'available' | 'partial' | 'stale' | 'unavailable';
export type FreshnessStatus = 'fresh' | 'stale' | 'unknown';
export type CheckOutcome = 'pass' | 'fail' | 'unknown' | 'stale';
export type SafeAction = 'Inspect' | 'Refresh read model' | 'Resolve eligibility' | 'Fund wallet' | 'Validate again' | 'Wait for reconciliation' | 'No safe action';

export interface Freshness {
  readonly status: FreshnessStatus;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
  readonly ageSeconds: string | null;
  readonly policyVersion: string | null;
}

export type ProvenanceKind = 'backend_store' | 'chain_observation' | 'eligibility_check' | 'simulation' | 'calendar_source' | 'score_calculation' | 'reconciliation' | 'notification_event';

export interface Provenance {
  readonly kind: ProvenanceKind;
  readonly recordId: string;
  readonly observedAt: string;
  readonly sourceBlockNumber?: string;
  readonly sourceBlockHash?: string;
  readonly evidenceId?: string;
  readonly modelVersion?: string;
  readonly policyVersion?: string;
  /** Opaque reference only; URLs and credential-bearing references are forbidden. */
  readonly sourceRef?: string;
}

export interface ReadModelIssue {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'blocking';
  readonly message: string;
  readonly retryable: boolean;
  readonly safeAction: SafeAction;
  readonly provenance?: Provenance;
}

export interface ReadModelEnvelope<T> {
  readonly contract: typeof READ_MODEL_CONTRACT;
  readonly version: typeof READ_MODEL_VERSION;
  readonly requestId: string;
  readonly generatedAt: string;
  readonly snapshot: {
    readonly id: string;
    readonly capturedAt: string;
    readonly consistency: 'snapshot' | 'partial';
  };
  readonly availability: ReadModelAvailability;
  readonly freshness: Freshness;
  readonly data: T | null;
  readonly issues: readonly ReadModelIssue[];
  readonly nextCursor?: string;
}

export interface EthAmount {
  readonly value: string;
  readonly asset: 'ETH';
  readonly unit: 'wei';
  readonly decimals: 18;
}

export interface SourcedAmount {
  readonly amount: EthAmount | null;
  readonly kind: 'estimated' | 'reserved' | 'actual' | 'unknown';
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface SourcedQuantity {
  readonly value: string | null;
  readonly unit: 'gas';
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface GateCheck {
  readonly code: string;
  readonly outcome: CheckOutcome;
  readonly required: boolean;
  readonly message: string;
  readonly evaluatedAt: string | null;
  readonly validUntil: string | null;
  readonly provenance?: Provenance;
  readonly freshness: Freshness;
}

export interface GateSummary {
  readonly decision: 'permitted' | 'blocked' | 'unknown';
  readonly checks: readonly GateCheck[];
  readonly blockers: readonly ReadModelIssue[];
  readonly nextAction: SafeAction;
}

export interface RetryPolicy {
  readonly allowed: boolean;
  readonly kind: 'none' | 'refresh_read' | 'reconcile' | 'replace' | 'resubmit' | 'rerun';
  readonly reasonCode: string;
  readonly message: string;
  readonly requiresFreshData: boolean;
  readonly safeAction: SafeAction;
}

export interface ScoreFactor {
  readonly code: string;
  readonly contribution: number;
  readonly explanation: string;
  readonly provenance: readonly Provenance[];
  readonly freshness: Freshness;
}

export interface RiskFlag {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'blocking';
  readonly message: string;
  readonly provenance?: Provenance;
  readonly freshness: Freshness;
}

export interface EvidenceRow {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly provenance: readonly Provenance[];
  readonly freshness: Freshness;
}

export interface ReadinessSummary {
  readonly total: string;
  readonly ready: string;
  readonly blocked: string;
  readonly unknown: string;
  readonly stale: string;
  readonly ineligible: string;
  readonly executing: string;
  readonly freshness: Freshness;
}

export interface CampaignSummary {
  readonly id: string;
  readonly state: Campaign['state'];
  readonly chainId: string;
  readonly contract: string | null;
  readonly quantity: string;
  readonly cost: SourcedAmount;
  readonly gate: GateSummary;
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface OpportunityReadModel {
  readonly id: string;
  readonly project: { readonly name: string | null; readonly contract: string | null };
  readonly chain: { readonly id: string; readonly name: string; readonly verification: GateSummary };
  readonly disposition: 'discovered' | 'evaluating' | 'scored' | 'notified' | 'approved' | 'promoted' | 'rejected' | 'expired';
  readonly openingAt: string | null;
  readonly price: SourcedAmount | null;
  readonly score: {
    readonly value: number | null;
    readonly modelVersion: string | null;
    readonly confidence: { readonly sampleSize: string; readonly denominator: string | null; readonly label: 'low' | 'medium' | 'high' | 'unknown' };
    readonly factors: readonly ScoreFactor[];
    readonly freshness: Freshness;
    readonly provenance: readonly Provenance[];
  };
  readonly risks: readonly RiskFlag[];
  readonly evidence: readonly EvidenceRow[];
  readonly gate: GateSummary;
  readonly readiness: ReadinessSummary | null;
  readonly nextAction: 'Inspect';
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface CalendarEntry {
  readonly id: string;
  readonly project: { readonly name: string | null; readonly contract: string | null };
  readonly chain: { readonly id: string; readonly name: string };
  readonly openingAt: string | null;
  readonly closingAt: string | null;
  readonly phase: string | null;
  readonly price: SourcedAmount;
  readonly supply: SourcedQuantity;
  readonly perWalletLimit: SourcedQuantity;
  readonly method: string | null;
  readonly publicStatus: 'public' | 'fcfs' | 'allowlist' | 'unknown';
  readonly expectedGas: SourcedQuantity;
  readonly sourceAuthority: 'on_chain' | 'operator_record' | 'external_source';
  readonly verification: GateSummary;
  readonly eligibility: ReadinessSummary;
  readonly nextAction: 'Inspect';
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface WalletReadinessRow {
  readonly campaignId: string;
  readonly wallet: { readonly id: string; readonly address: string; readonly label: string | null };
  readonly state: 'Unknown' | 'Unfunded' | 'Funded' | 'Eligible' | 'Ready' | 'Executing' | 'Minted' | 'Failed' | 'Skipped';
  readonly decision: 'ready' | 'blocked' | 'unknown' | 'stale';
  readonly checks: readonly GateCheck[];
  readonly blockers: readonly ReadModelIssue[];
  readonly cost: {
    readonly mintValue: SourcedAmount;
    readonly executionGas: SourcedAmount;
    readonly dataPostingGas: SourcedAmount | null;
    readonly priorityFeeComponent: SourcedAmount | null;
    readonly estimatedTotal: SourcedAmount;
    readonly balance: SourcedAmount | null;
  };
  readonly nextAction: SafeAction;
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface TransactionAttemptReadModel {
  readonly id: string;
  readonly walletId: string;
  readonly hash: string | null;
  readonly nonce: string | null;
  readonly attemptNumber: string;
  readonly replacementOfId: string | null;
  readonly state: string;
  readonly finality: FinalityReadModel | null;
  readonly retry: RetryPolicy;
  readonly reason?: ReadModelIssue;
  readonly provenance: readonly Provenance[];
}

export interface TransactionReceiptReadModel {
  readonly id: string;
  readonly attemptId: string;
  readonly hash: string;
  readonly status: 'pending' | 'confirmed' | 'reverted' | 'reorged' | 'dropped';
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly gasUsed: SourcedQuantity | null;
  readonly effectiveGasPrice: SourcedAmount | null;
  readonly actualSpend: SourcedAmount | null;
  readonly finality: FinalityReadModel;
  readonly provenance: readonly Provenance[];
}

export interface FinalityReadModel {
  readonly stage: 'unknown' | 'confirmed' | 'soft' | 'posted' | 'ethereum_final';
  readonly requiredStage: 'confirmed' | 'ethereum_final';
  readonly settlementReached: boolean;
  readonly observedAt: string | null;
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
  readonly downgradeReason?: string;
}

export interface ReconciliationReadModel {
  readonly id: string;
  readonly state: 'unresolved' | 'matched' | 'ambiguous' | 'reorged' | 'final';
  readonly observedAt: string;
  readonly reason: string | null;
  readonly retry: RetryPolicy;
  readonly provenance: readonly Provenance[];
}

export interface OutcomeReason {
  readonly code: string;
  readonly label: 'Cancelled' | 'Aborted' | 'Failed' | 'Unknown';
  readonly message: string;
  readonly actor: 'operator' | 'safety_control' | 'adaptive_stop' | 'backend' | 'chain' | 'unknown';
  readonly occurredAt: string;
  readonly submittedWork: 'none' | 'some' | 'all' | 'unknown';
  readonly retry: RetryPolicy;
  readonly provenance?: Provenance;
}

export interface WalletExecutionResult {
  readonly walletId: string;
  readonly address: string;
  readonly state: string;
  readonly attemptIds: readonly string[];
  readonly finality: FinalityReadModel | null;
  readonly reason?: OutcomeReason;
  readonly retry: RetryPolicy;
  readonly freshness: Freshness;
}

export interface TimelineEvent {
  readonly id: string;
  readonly type: string;
  readonly state: string | null;
  readonly occurredAt: string;
  readonly message: string;
  readonly provenance?: Provenance;
}

export interface RunReadModelV1 {
  readonly run: {
    readonly id: string;
    readonly campaignId: string;
    readonly mode: 'dry-run' | 'live';
    readonly state: Campaign['state'];
    readonly outcome: 'not_started' | 'dry_run_completed' | 'partial' | 'settled' | 'unknown';
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly retry: RetryPolicy;
  };
  readonly campaign: CampaignSummary;
  readonly walletResults: readonly WalletExecutionResult[];
  readonly attempts: readonly TransactionAttemptReadModel[];
  readonly receipts: readonly TransactionReceiptReadModel[];
  readonly reconciliations: readonly ReconciliationReadModel[];
  readonly events: readonly TimelineEvent[];
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface AlertReadModel {
  readonly id: string;
  readonly sourceEventId: string;
  readonly runId: string | null;
  readonly type: string;
  readonly text: string;
  readonly state: 'pending' | 'delivering' | 'delivered';
  readonly attempts: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly freshness: Freshness;
  readonly provenance: readonly Provenance[];
}

export interface SystemHealthReadModel {
  readonly state: 'Ready' | 'Not ready' | 'Killed' | 'Unknown';
  readonly killSwitch: 'clear' | 'engaged' | 'unknown';
  readonly dependencies: {
    readonly engine: 'ready' | 'not_ready' | 'unknown';
    readonly chain: 'ready' | 'not_ready' | 'unknown';
    readonly backup: 'ready' | 'not_ready' | 'unknown';
    readonly notifications: 'ready' | 'not_ready' | 'unknown';
    readonly reconciliation: 'clear' | 'required' | 'in_progress' | 'unknown';
  };
  readonly blockers: readonly ReadModelIssue[];
  readonly checkedAt: string;
  readonly freshness: Freshness;
}

export interface HomeReadModel {
  readonly attention: readonly ReadModelIssue[];
  readonly readinessSummary: ReadinessSummary;
  readonly opportunities: readonly OpportunityReadModel[];
  readonly calendarHighlights: readonly CalendarEntry[];
  readonly alerts: readonly AlertReadModel[];
  readonly system: SystemHealthReadModel;
}

export interface ProjectionRequest {
  readonly requestId?: string;
  readonly snapshotId?: string;
  readonly capturedAt?: string;
  readonly consistency?: 'snapshot' | 'partial';
  readonly limit?: number;
  readonly cursor?: number;
}

interface ProjectionContext {
  readonly state: BackendState;
  readonly now: Date;
  readonly request: ProjectionRequest;
  readonly generatedAt: string;
  readonly freshnessPolicyVersion: string;
}

const UNKNOWN_FRESHNESS: Freshness = { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion: 'read-model-v1' };
const DENIED_RETRY: RetryPolicy = { allowed: false, kind: 'none', reasonCode: 'NO_SAFE_RETRY', message: 'No safe retry is authorized from this read model.', requiresFreshData: true, safeAction: 'No safe action' };

/**
 * Pure projection service. It consumes an already-captured BackendState and
 * never calls an RPC, signer, broadcaster, or mutation endpoint.
 */
export class Phase2ReadModelService {
  private readonly now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  public home(state: BackendState, request: ProjectionRequest = {}): ReadModelEnvelope<HomeReadModel> {
    const context = this.context(state, request);
    const opportunities = this.projectOpportunities(context, request);
    const calendar = this.projectCalendar(context, request);
    const readiness = this.allReadiness(context);
    const alerts = this.projectAlerts(context, request);
    const system = this.projectHealth(context);
    const issues = [...opportunities.issues, ...calendar.issues, ...readiness.issues, ...alerts.issues, ...system.issues];
    const data: HomeReadModel = {
      attention: [...issues],
      readinessSummary: readiness.summary,
      opportunities: opportunities.data,
      calendarHighlights: calendar.data,
      alerts: alerts.data,
      system: system.data,
    };
    return this.envelope(context, data, issues, aggregateFreshness([opportunities.freshness, calendar.freshness, readiness.summary.freshness, alerts.freshness, system.data.freshness]));
  }

  public opportunities(state: BackendState, request: ProjectionRequest = {}): ReadModelEnvelope<readonly OpportunityReadModel[]> {
    const context = this.context(state, request);
    const result = this.projectOpportunities(context, request);
    return this.envelope(context, result.data, result.issues, result.freshness, result.nextCursor);
  }

  public calendar(state: BackendState, request: ProjectionRequest = {}): ReadModelEnvelope<readonly CalendarEntry[]> {
    const context = this.context(state, request);
    const result = this.projectCalendar(context, request);
    return this.envelope(context, result.data, result.issues, result.freshness, result.nextCursor);
  }

  public readiness(state: BackendState, campaignId: string, request: ProjectionRequest = {}): ReadModelEnvelope<readonly WalletReadinessRow[]> {
    const context = this.context(state, request);
    const campaign = state.campaigns.find(item => item.id === campaignId);
    if (!campaign) return this.envelope<readonly WalletReadinessRow[]>(context, null, [issue('CAMPAIGN_NOT_FOUND', 'Campaign was not found in this snapshot.', 'blocking', 'No safe action')], UNKNOWN_FRESHNESS);
    const rows = this.readinessRows(context, campaign);
    const issues = rows.flatMap(row => [...row.blockers]);
    return this.envelope(context, rows, issues, aggregateFreshness(rows.map(row => row.freshness)));
  }

  public run(state: BackendState, runId: string, request: ProjectionRequest = {}): ReadModelEnvelope<RunReadModelV1> {
    const context = this.context(state, request);
    const run = state.runs.find(item => item.id === runId);
    if (!run) return this.envelope<RunReadModelV1>(context, null, [issue('RUN_NOT_FOUND', 'Run was not found in this snapshot.', 'blocking', 'No safe action')], UNKNOWN_FRESHNESS);
    const campaign = state.campaigns.find(item => item.id === run.campaignId);
    if (!campaign) return this.envelope<RunReadModelV1>(context, null, [issue('CAMPAIGN_NOT_FOUND', 'The run references a campaign missing from this snapshot.', 'blocking', 'No safe action')], UNKNOWN_FRESHNESS);
    const projected = this.projectRun(context, run, campaign);
    return this.envelope(context, projected.data, projected.issues, projected.freshness);
  }

  public alerts(state: BackendState, request: ProjectionRequest = {}): ReadModelEnvelope<readonly AlertReadModel[]> {
    const context = this.context(state, request);
    const result = this.projectAlerts(context, request);
    return this.envelope(context, result.data, result.issues, result.freshness, result.nextCursor);
  }

  public health(state: BackendState, request: ProjectionRequest = {}): ReadModelEnvelope<SystemHealthReadModel> {
    const context = this.context(state, request);
    const result = this.projectHealth(context);
    return this.envelope(context, result.data, result.issues, result.data.freshness);
  }

  private context(state: BackendState, request: ProjectionRequest): ProjectionContext {
    const now = this.now();
    if (Number.isNaN(now.getTime())) throw new Error('INVALID_READ_MODEL_TIME');
    const generatedAt = now.toISOString();
    return { state, now, request, generatedAt, freshnessPolicyVersion: 'read-model-v1' };
  }

  private envelope<T>(context: ProjectionContext, data: T | null, issues: readonly ReadModelIssue[], freshness: Freshness, nextCursor?: string): ReadModelEnvelope<T> {
    const availability: ReadModelAvailability = data === null ? 'unavailable' : issues.some(item => item.severity === 'blocking') && freshness.status === 'unknown' ? 'unavailable' : freshness.status === 'stale' ? 'stale' : issues.length > 0 ? 'partial' : 'available';
    const snapshotId = context.request.snapshotId ?? digestState(context.state);
    const result: ReadModelEnvelope<T> = {
      contract: READ_MODEL_CONTRACT,
      version: READ_MODEL_VERSION,
      requestId: context.request.requestId ?? 'read-model-request',
      generatedAt: context.generatedAt,
      snapshot: { id: snapshotId, capturedAt: context.request.capturedAt ?? context.generatedAt, consistency: context.request.consistency ?? 'snapshot' },
      availability,
      freshness,
      data,
      issues,
    };
    return nextCursor === undefined ? result : { ...result, nextCursor };
  }

  private projectOpportunities(context: ProjectionContext, request: ProjectionRequest): ProjectionResult<readonly OpportunityReadModel[]> {
    const events = context.state.events.filter(event => event.type.startsWith('opportunity_')).sort(eventOrder);
    if (events.length === 0) return { data: [], issues: [issue('OPPORTUNITY_SOURCE_UNAVAILABLE', 'Discovery has not supplied opportunity observations for this snapshot.', 'blocking', 'Refresh read model')], freshness: UNKNOWN_FRESHNESS };
    const latest = new Map<string, EventRecord>();
    for (const event of events) {
      const id = stringValue(event.data.opportunityId) ?? event.id;
      if (!latest.has(id) || event.at >= latest.get(id)!.at) latest.set(id, event);
    }
    const entries = [...latest.values()].map(event => this.opportunityFromEvent(context, event));
    const page = pageItems(entries, request);
    return { data: page.items, issues: [], freshness: aggregateFreshness(entries.map(item => item.freshness)), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }

  private opportunityFromEvent(context: ProjectionContext, event: EventRecord): OpportunityReadModel {
    const chainId = integerValue(event.data.chainId) === 4663 ? 4663 : 1;
    const contract = addressValue(event.data.contract);
    const observedAt = validIso(event.at) ?? context.generatedAt;
    const provenance = [storeProvenance(`event:${event.id}`, observedAt)];
    const chainGate = this.chainGate(context, chainId, stringValue(event.data.evidenceId));
    const scoreValue = numberValue(event.data.score);
    const scoreFreshness = classifyFreshness(observedAt, stringValue(event.data.expiresAt), context.now, context.freshnessPolicyVersion);
    const scoreProvenance = [storeProvenance(`opportunity-score:${event.id}`, observedAt)];
    const disposition = dispositionValue(event.data.disposition) ?? event.type.slice('opportunity_'.length) as OpportunityReadModel['disposition'];
    const freshness = aggregateFreshness([scoreFreshness, chainGate.checks[0]?.freshness ?? UNKNOWN_FRESHNESS]);
    const risks: RiskFlag[] = chainGate.decision === 'blocked' ? [{ code: 'CHAIN_GATE_BLOCKED', severity: 'blocking', message: chainGate.blockers[0]?.message ?? 'The chain gate is blocked.', provenance: chainGate.checks[0]?.provenance, freshness: chainGate.checks[0]?.freshness ?? UNKNOWN_FRESHNESS }] : [];
    return {
      id: stringValue(event.data.opportunityId) ?? event.id,
      project: { name: stringValue(event.data.projectName) ?? null, contract },
      chain: { id: chainId.toString(), name: chainId === 4663 ? 'Robinhood' : 'Ethereum', verification: chainGate },
      disposition,
      openingAt: validIso(stringValue(event.data.openingAt)),
      price: event.data.priceWei === undefined ? null : sourcedAmount(bigintValue(event.data.priceWei), 'estimated', scoreFreshness, provenance),
      score: { value: scoreValue, modelVersion: stringValue(event.data.scoreVersion) ?? null, confidence: { sampleSize: stringValue(event.data.sampleSize) ?? '0', denominator: stringValue(event.data.denominator) ?? null, label: confidenceValue(event.data.confidence) }, factors: [], freshness: scoreFreshness, provenance: scoreProvenance },
      risks,
      evidence: [{ id: event.id, label: 'Discovery observation', summary: 'Observed by the Backend discovery event stream.', provenance, freshness: classifyFreshness(observedAt, stringValue(event.data.expiresAt), context.now, context.freshnessPolicyVersion) }],
      gate: chainGate,
      readiness: null,
      nextAction: 'Inspect',
      freshness,
      provenance,
    };
  }

  private projectCalendar(context: ProjectionContext, request: ProjectionRequest): ProjectionResult<readonly CalendarEntry[]> {
    const campaigns = context.state.campaigns;
    const calendarEvents = context.state.events.filter(event => event.type === 'calendar_entry' || event.type === 'calendar_updated').sort(eventOrder);
    if (campaigns.length === 0 && calendarEvents.length === 0) return { data: [], issues: [issue('CALENDAR_SOURCE_UNAVAILABLE', 'No on-chain or operator calendar records are available in this snapshot.', 'blocking', 'Refresh read model')], freshness: UNKNOWN_FRESHNESS };
    const entries = campaigns.map(campaign => this.calendarFromCampaign(context, campaign));
    for (const event of calendarEvents) {
      if (!entries.some(entry => entry.id === (stringValue(event.data.id) ?? event.id))) entries.push(this.calendarFromEvent(context, event));
    }
    const page = pageItems(entries.sort((left, right) => left.id.localeCompare(right.id)), request);
    const issues = entries.flatMap(entry => entry.openingAt === null ? [issue('CALENDAR_TIME_UNKNOWN', 'Opening time has not been verified from an authoritative source.', 'warning', 'Inspect')] : []);
    return { data: page.items, issues, freshness: aggregateFreshness(entries.map(item => item.freshness)), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }

  private calendarFromCampaign(context: ProjectionContext, campaign: Campaign): CalendarEntry {
    const evidence = this.chainEvidence(context.state, campaign);
    const provenance = [storeProvenance(`campaign:${campaign.id}`, campaign.updatedAt)];
    const freshness = evidence ? evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion) : UNKNOWN_FRESHNESS;
    const verification = this.chainGate(context, campaign.chainId, campaign.chainVerification.evidenceId);
    const price = sourcedAmount(campaign.mintPriceWei, 'estimated', freshness, provenance);
    const unknownQuantity = sourcedQuantity(null, freshness, provenance);
    const eligibility = this.readinessSummary(this.readinessRows(context, campaign));
    return {
      id: campaign.id,
      project: { name: null, contract: campaign.contract },
      chain: { id: campaign.chainId.toString(), name: campaign.chainId === 4663 ? 'Robinhood' : 'Ethereum' },
      openingAt: null,
      closingAt: null,
      phase: null,
      price,
      supply: unknownQuantity,
      perWalletLimit: unknownQuantity,
      method: campaign.strategy,
      publicStatus: campaign.strategy.includes('public') ? 'public' : 'unknown',
      expectedGas: unknownQuantity,
      sourceAuthority: evidence ? 'on_chain' : 'operator_record',
      verification,
      eligibility,
      nextAction: 'Inspect',
      freshness,
      provenance,
    };
  }

  private calendarFromEvent(context: ProjectionContext, event: EventRecord): CalendarEntry {
    const chainId = integerValue(event.data.chainId) === 4663 ? 4663 : 1;
    const observedAt = validIso(event.at) ?? context.generatedAt;
    const provenance = [storeProvenance(`calendar:${event.id}`, observedAt)];
    const freshness = classifyFreshness(observedAt, stringValue(event.data.expiresAt), context.now, context.freshnessPolicyVersion);
    const unknown = sourcedQuantity(null, freshness, provenance);
    return {
      id: stringValue(event.data.id) ?? event.id,
      project: { name: stringValue(event.data.projectName) ?? null, contract: addressValue(event.data.contract) },
      chain: { id: chainId.toString(), name: chainId === 4663 ? 'Robinhood' : 'Ethereum' },
      openingAt: validIso(stringValue(event.data.openingAt)),
      closingAt: validIso(stringValue(event.data.closingAt)),
      phase: stringValue(event.data.phase) ?? null,
      price: sourcedAmount(bigintValue(event.data.priceWei), 'estimated', freshness, provenance),
      supply: unknown,
      perWalletLimit: unknown,
      method: stringValue(event.data.method) ?? null,
      publicStatus: publicStatusValue(event.data.publicStatus),
      expectedGas: unknown,
      sourceAuthority: event.data.sourceAuthority === 'external_source' ? 'external_source' : event.data.sourceAuthority === 'on_chain' ? 'on_chain' : 'operator_record',
      verification: this.chainGate(context, chainId, stringValue(event.data.evidenceId)),
      eligibility: emptyReadinessSummary(freshness),
      nextAction: 'Inspect',
      freshness,
      provenance,
    };
  }

  private allReadiness(context: ProjectionContext): { readonly summary: ReadinessSummary; readonly issues: readonly ReadModelIssue[] } {
    const rows = context.state.campaigns.flatMap(campaign => this.readinessRows(context, campaign));
    return { summary: this.readinessSummary(rows), issues: rows.flatMap(row => row.blockers) };
  }

  private readinessRows(context: ProjectionContext, campaign: Campaign): readonly WalletReadinessRow[] {
    const wallets = new Set<string>();
    for (const intent of context.state.intents.filter(item => item.campaignId === campaign.id)) for (const wallet of intent.wallets) wallets.add(wallet);
    for (const simulation of context.state.simulations.filter(item => item.campaignId === campaign.id)) wallets.add(simulation.wallet);
    for (const attempt of context.state.attempts) {
      const run = context.state.runs.find(item => item.id === attempt.runId);
      if (run?.campaignId === campaign.id) wallets.add(attempt.wallet);
    }
    return [...wallets].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())).map(wallet => this.readinessRow(context, campaign, wallet));
  }

  private readinessRow(context: ProjectionContext, campaign: Campaign, wallet: string): WalletReadinessRow {
    const evidence = this.chainEvidence(context.state, campaign);
    const chainCheck = this.chainCheck(context, campaign, evidence);
    const simulation = latestSimulation(context.state.simulations.filter(item => item.campaignId === campaign.id && item.wallet.toLowerCase() === wallet.toLowerCase()));
    const simulationCheck = this.simulationCheck(context, simulation);
    const unknown = UNKNOWN_FRESHNESS;
    const eligibilityCheck = gateCheck('eligible', 'unknown', true, 'Eligibility has not been supplied by an authoritative check.', null, null, undefined, unknown);
    const fundedCheck = gateCheck('funded', 'unknown', true, 'Wallet balance is not available in this snapshot.', null, null, undefined, unknown);
    const constructibleCheck = gateCheck('constructible', 'unknown', true, 'Strategy construction evidence is not available in this snapshot.', null, null, undefined, unknown);
    const gasPolicyCheck = gateCheck('gas_policy', campaign.feePolicy.totalFeeBudgetWei !== undefined ? 'pass' : 'unknown', true, campaign.feePolicy.totalFeeBudgetWei !== undefined ? 'Fee policy is recorded.' : 'Fee policy is incomplete.', campaign.updatedAt, null, storeProvenance(`campaign:${campaign.id}`, campaign.updatedAt), campaign.feePolicy.totalFeeBudgetWei !== undefined ? classifyFreshness(campaign.updatedAt, null, context.now, context.freshnessPolicyVersion) : unknown);
    const runtimeCheck = gateCheck('runtime_ready', context.state.runtime.startupState === 'Ready' ? 'pass' : 'fail', true, context.state.runtime.startupState === 'Ready' ? 'Runtime is ready.' : 'Runtime is not ready for controlled work.', context.state.runtime.operational?.observedAt ?? null, context.state.runtime.operational?.expiresAt ?? null, context.state.runtime.operational ? storeProvenance('runtime', context.state.runtime.operational.observedAt) : undefined, context.state.runtime.operational ? classifyFreshness(context.state.runtime.operational.observedAt, context.state.runtime.operational.expiresAt, context.now, context.freshnessPolicyVersion) : unknown);
    const reconciliationCheck = gateCheck('reconciliation_clear', context.state.reconciliations.some(item => item.runId && context.state.runs.find(run => run.id === item.runId)?.campaignId === campaign.id && item.result === 'unknown') ? 'fail' : 'unknown', true, 'Reconciliation clearance is not proven for this campaign.', null, null, undefined, unknown);
    const checks = [fundedCheck, eligibilityCheck, constructibleCheck, simulationCheck, gasPolicyCheck, chainCheck, runtimeCheck, reconciliationCheck];
    const blockers = checks.filter(check => check.outcome !== 'pass').map(check => readinessIssue(check, wallet));
    const decision = checks.some(check => check.outcome === 'fail') ? 'blocked' : checks.some(check => check.outcome === 'stale') ? 'stale' : checks.every(check => check.outcome === 'pass') ? 'ready' : 'unknown';
    const latestAttempt = latestAttemptForWallet(context.state, campaign.id, wallet);
    const latestReceipt = latestReceiptForAttempt(context.state, latestAttempt?.id);
    const executionState = latestReceipt?.state === 'Reorged' ? 'Failed' : latestAttempt?.state === 'Pending' || latestAttempt?.state === 'Submitted' ? 'Executing' : latestReceipt?.state === 'Confirmed' && (latestReceipt.robinhoodFinality === 'final' || campaign.chainId === 1) ? 'Minted' : latestAttempt?.state === 'Failed' ? 'Failed' : decision === 'ready' ? 'Ready' : fundedCheck.outcome === 'pass' ? 'Funded' : eligibilityCheck.outcome === 'pass' ? 'Eligible' : 'Unknown';
    const freshness = aggregateFreshness(checks.map(check => check.freshness));
    const provenance = checks.flatMap(check => check.provenance ? [check.provenance] : []);
    return {
      campaignId: campaign.id,
      wallet: { id: wallet, address: wallet, label: null },
      state: executionState,
      decision,
      checks,
      blockers,
      cost: this.readinessCost(context, campaign, provenance),
      nextAction: nextReadinessAction(checks),
      freshness,
      provenance,
    };
  }

  private readinessCost(context: ProjectionContext, campaign: Campaign, provenance: readonly Provenance[]): WalletReadinessRow['cost'] {
    const freshness = classifyFreshness(campaign.updatedAt, null, context.now, context.freshnessPolicyVersion);
    const fee = campaign.feePolicy;
    const mintValue = campaign.mintPriceWei * BigInt(campaign.quantity);
    const executionGas = fee.l2ExecutionGasBudgetWei;
    const dataGas = fee.l1DataGasBudgetWei;
    const priority = fee.configuredPriorityFeeWei;
    const total = executionGas !== undefined && dataGas !== undefined && priority !== undefined ? mintValue + executionGas + dataGas + priority : null;
    return {
      mintValue: sourcedAmount(mintValue, 'estimated', freshness, provenance),
      executionGas: sourcedAmount(executionGas ?? null, 'estimated', freshness, provenance),
      dataPostingGas: sourcedAmountOrNull(dataGas, 'estimated', freshness, provenance),
      priorityFeeComponent: sourcedAmountOrNull(priority, 'estimated', freshness, provenance),
      estimatedTotal: sourcedAmount(total, 'estimated', freshness, provenance),
      balance: null,
    };
  }

  private simulationCheck(context: ProjectionContext, simulation: SimulationEvidenceRecord | undefined): GateCheck {
    if (!simulation) return gateCheck('simulated', 'unknown', true, 'No per-wallet simulation evidence is available.', null, null, undefined, UNKNOWN_FRESHNESS);
    const freshness = classifyFreshness(simulation.checkedAt, simulation.expiresAt, context.now, context.freshnessPolicyVersion);
    const outcome: CheckOutcome = freshness.status === 'stale' ? 'stale' : simulation.success ? 'pass' : 'fail';
    const message = outcome === 'pass' ? 'Per-wallet simulation passed.' : outcome === 'stale' ? 'Per-wallet simulation is stale.' : 'Per-wallet simulation failed.';
    return gateCheck('simulated', outcome, true, message, simulation.checkedAt, simulation.expiresAt, simulationProvenance(simulation), freshness);
  }

  private chainCheck(context: ProjectionContext, campaign: Campaign, evidence: ReturnType<Phase2ReadModelService['chainEvidence']>): GateCheck {
    const verification = campaign.chainVerification;
    const freshness = evidence ? evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion) : UNKNOWN_FRESHNESS;
    const provenance = evidence ? evidenceProvenance(evidence) : undefined;
    if (campaign.chainId === 4663) return gateCheck('chain_verified', 'fail', true, 'Robinhood execution remains blocked; characterization is inspection evidence only.', verification.checkedAt ?? null, evidence?.expiresAt ?? null, provenance, freshness);
    if (verification.status !== 'verified') return gateCheck('chain_verified', 'fail', true, 'Chain verification is not accepted for this campaign.', verification.checkedAt ?? null, evidence?.expiresAt ?? null, provenance, freshness);
    if (freshness.status === 'stale') return gateCheck('chain_verified', 'stale', true, 'Chain verification evidence is stale.', verification.checkedAt ?? null, evidence?.expiresAt ?? null, provenance, freshness);
    if (freshness.status === 'unknown') return gateCheck('chain_verified', 'unknown', true, 'Chain verification freshness is unknown.', verification.checkedAt ?? null, evidence?.expiresAt ?? null, provenance, freshness);
    return gateCheck('chain_verified', 'pass', true, 'Chain verification is current.', verification.checkedAt ?? null, evidence?.expiresAt ?? null, provenance, freshness);
  }

  private chainGate(context: ProjectionContext, chainId: 1 | 4663, evidenceId?: string): GateSummary {
    const evidence = context.state.chainEvidence.find(item => item.id === evidenceId) ?? context.state.chainEvidence.filter(item => item.chainId === chainId).sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0];
    const verification = evidence ? this.chainEvidenceCheck(context, chainId, evidence) : gateCheck('chain_verified', 'unknown', true, 'No chain verification evidence is available.', null, null, undefined, UNKNOWN_FRESHNESS);
    const evidenceCurrent = evidence ? gateCheck('evidence_current', evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion).status === 'fresh' ? 'pass' : evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion).status === 'stale' ? 'stale' : 'unknown', true, evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion).status === 'fresh' ? 'Evidence is within its freshness window.' : 'Evidence freshness is not current.', evidence.checkedAt, evidence.expiresAt, evidenceProvenance(evidence), evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion)) : gateCheck('evidence_current', 'unknown', true, 'No chain evidence freshness is available.', null, null, undefined, UNKNOWN_FRESHNESS);
    const checks = [verification, evidenceCurrent];
    const blockers = checks.filter(check => check.outcome !== 'pass').map(check => issue(`CHAIN_${check.code.toUpperCase()}`, check.message, check.outcome === 'unknown' || check.outcome === 'stale' ? 'warning' : 'blocking', check.outcome === 'stale' || check.outcome === 'unknown' ? 'Refresh read model' : 'No safe action', check.provenance));
    const decision = checks.some(check => check.outcome === 'fail') ? 'blocked' : checks.some(check => check.outcome !== 'pass') ? 'unknown' : 'permitted';
    return { decision, checks, blockers, nextAction: blockers[0]?.safeAction ?? 'Inspect' };
  }

  private chainEvidenceCheck(context: ProjectionContext, chainId: 1 | 4663, evidence: BackendState['chainEvidence'][number]): GateCheck {
    const freshness = evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion);
    const provenance = evidenceProvenance(evidence);
    if (chainId === 4663) return gateCheck('chain_verified', 'fail', true, 'Robinhood is characterized but execution remains blocked.', evidence.checkedAt, evidence.expiresAt, provenance, freshness);
    if (evidence.status !== 'accepted' || !evidence.seaDropCompatible) return gateCheck('chain_verified', 'fail', true, 'Chain evidence is not accepted or SeaDrop compatibility is unknown.', evidence.checkedAt, evidence.expiresAt, provenance, freshness);
    if (freshness.status === 'stale') return gateCheck('chain_verified', 'stale', true, 'Chain evidence is stale.', evidence.checkedAt, evidence.expiresAt, provenance, freshness);
    if (freshness.status === 'unknown') return gateCheck('chain_verified', 'unknown', true, 'Chain evidence freshness is unknown.', evidence.checkedAt, evidence.expiresAt, provenance, freshness);
    return gateCheck('chain_verified', 'pass', true, 'Chain evidence is accepted and current.', evidence.checkedAt, evidence.expiresAt, provenance, freshness);
  }

  private chainEvidence(state: BackendState, campaign: Campaign): BackendState['chainEvidence'][number] | undefined {
    return state.chainEvidence.find(item => item.id === campaign.chainVerification.evidenceId) ?? state.chainEvidence.filter(item => item.chainId === campaign.chainId).sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0];
  }

  private readinessSummary(rows: readonly WalletReadinessRow[]): ReadinessSummary {
    const count = (predicate: (row: WalletReadinessRow) => boolean) => rows.filter(predicate).length.toString();
    return {
      total: rows.length.toString(),
      ready: count(row => row.decision === 'ready'),
      blocked: count(row => row.decision === 'blocked'),
      unknown: count(row => row.decision === 'unknown'),
      stale: count(row => row.decision === 'stale'),
      ineligible: count(row => row.checks.some(check => check.code === 'eligible' && check.outcome === 'fail')),
      executing: count(row => row.state === 'Executing'),
      freshness: aggregateFreshness(rows.map(row => row.freshness)),
    };
  }

  private projectRun(context: ProjectionContext, run: RunRecord, campaign: Campaign): ProjectionResult<RunReadModelV1> {
    const attempts = context.state.attempts.filter(attempt => attempt.runId === run.id).sort(attemptOrder);
    const receipts = context.state.receipts.filter(receipt => receipt.runId === run.id).sort(receiptOrder);
    const reconciliations = context.state.reconciliations.filter(item => item.runId === run.id).sort(reconciliationOrder);
    const events = context.state.events.filter(event => event.runId === run.id).sort(eventOrder).map(event => this.timelineEvent(event));
    const projectedAttempts = attempts.map((attempt, index) => this.attemptReadModel(context, attempt, index + 1));
    const projectedReceipts = receipts.map(receipt => this.receiptReadModel(context, receipt, attempts));
    const projectedReconciliations = reconciliations.map(item => this.reconciliationReadModel(item));
    const walletResults = this.walletExecutionResults(context, attempts, receipts, reconciliations);
    const outcome = run.mode === 'dry-run' && ['Completed', 'Failed'].includes(run.state) ? 'dry_run_completed' : run.state === 'Completed' && receipts.every(receipt => receipt.state === 'Confirmed' && (campaign.chainId !== 4663 || receipt.robinhoodFinality === 'final')) ? 'settled' : attempts.length > 0 || receipts.length > 0 ? 'partial' : run.state === 'Armed' ? 'not_started' : 'unknown';
    const freshness = aggregateFreshness([campaignFreshness(context, campaign), ...receipts.map(receipt => classifyFreshness(receipt.observedAt, null, context.now, context.freshnessPolicyVersion)), ...reconciliations.map(item => classifyFreshness(item.observedAt, null, context.now, context.freshnessPolicyVersion))]);
    const issues = [...reconciliations.filter(item => item.result === 'unknown' || item.result === 'reorged').map(item => issue(item.result === 'reorged' ? 'REORG_RECONCILIATION_REQUIRED' : 'RECONCILIATION_UNRESOLVED', item.result === 'reorged' ? 'A reorg observation requires reconciliation before any retry or accounting conclusion.' : 'The authoritative transaction outcome is unresolved.', 'blocking', 'Wait for reconciliation', reconciliationProvenance(item)))];
    const data: RunReadModelV1 = {
      run: { id: run.id, campaignId: run.campaignId, mode: run.mode, state: run.state, outcome, createdAt: run.createdAt, updatedAt: run.updatedAt, retry: outcome === 'unknown' ? DENIED_RETRY : DENIED_RETRY },
      campaign: this.campaignSummary(context, campaign),
      walletResults,
      attempts: projectedAttempts,
      receipts: projectedReceipts,
      reconciliations: projectedReconciliations,
      events,
      freshness,
      provenance: [storeProvenance(`run:${run.id}`, run.updatedAt)],
    };
    return { data, issues, freshness };
  }

  private campaignSummary(context: ProjectionContext, campaign: Campaign): CampaignSummary {
    const evidence = this.chainEvidence(context.state, campaign);
    const freshness = evidence ? evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion) : UNKNOWN_FRESHNESS;
    const provenance = evidence ? [evidenceProvenance(evidence)] : [storeProvenance(`campaign:${campaign.id}`, campaign.updatedAt)];
    return { id: campaign.id, state: campaign.state, chainId: campaign.chainId.toString(), contract: addressValue(campaign.contract), quantity: campaign.quantity.toString(), cost: sourcedAmount(campaign.mintPriceWei * BigInt(campaign.quantity), 'estimated', freshness, provenance), gate: this.chainGate(context, campaign.chainId, campaign.chainVerification.evidenceId), freshness, provenance };
  }

  private attemptReadModel(context: ProjectionContext, attempt: AttemptRecord, attemptNumber: number): TransactionAttemptReadModel {
    const provenance = [storeProvenance(`attempt:${attempt.id}`, attempt.createdAt)];
    const finality = attempt.robinhoodFinality === undefined ? null : finalityModel(context, attempt.robinhoodFinality === 'final' ? 'ethereum_final' : attempt.robinhoodFinality, attempt.robinhoodFinality === 'final', attempt.updatedAt, provenance);
    const reason = attempt.state === 'Failed' ? issue('ATTEMPT_FAILED', 'The transaction attempt failed; inspect its typed backend reason.', 'warning', 'Inspect', provenance[0]) : undefined;
    return { id: attempt.id, walletId: attempt.wallet, hash: attempt.hash ?? null, nonce: attempt.nonce === undefined ? null : attempt.nonce.toString(), attemptNumber: attemptNumber.toString(), replacementOfId: attempt.replacementOfId ?? null, state: attempt.state, finality, retry: DENIED_RETRY, ...(reason === undefined ? {} : { reason }), provenance };
  }

  private receiptReadModel(context: ProjectionContext, receipt: ReceiptRecord, attempts: readonly AttemptRecord[]): TransactionReceiptReadModel {
    const attempt = attempts.find(item => item.id === receipt.transactionAttemptId);
    const provenance = [storeProvenance(`receipt:${receipt.id}`, receipt.observedAt)];
    const stage = receipt.robinhoodFinality === 'soft' ? 'soft' : receipt.robinhoodFinality === 'posted' ? 'posted' : receipt.robinhoodFinality === 'final' ? 'ethereum_final' : receipt.state === 'Confirmed' ? 'confirmed' : 'unknown';
    const finality = finalityModel(context, stage, receipt.state === 'Confirmed' && (receipt.robinhoodFinality === 'final' || receipt.robinhoodFinality === undefined), receipt.observedAt, provenance, receipt.state === 'Reorged' ? 'Receipt was downgraded after a canonicality change.' : undefined);
    const freshness = classifyFreshness(receipt.observedAt, null, context.now, context.freshnessPolicyVersion);
    const amount = receipt.actualSpendWei === undefined ? null : sourcedAmount(receipt.actualSpendWei, 'actual', freshness, provenance);
    return { id: receipt.id, attemptId: receipt.transactionAttemptId ?? attempt?.id ?? '', hash: attempt?.hash ?? '', status: receipt.state === 'Confirmed' ? 'confirmed' : receipt.state === 'Reorged' ? 'reorged' : receipt.state === 'Failed' ? 'reverted' : 'pending', blockNumber: receipt.blockNumber === undefined ? null : receipt.blockNumber.toString(), blockHash: receipt.blockHash ?? null, gasUsed: null, effectiveGasPrice: null, actualSpend: amount, finality, provenance };
  }

  private reconciliationReadModel(record: ReconciliationRecord): ReconciliationReadModel {
    const provenance = [reconciliationProvenance(record)];
    const state: ReconciliationReadModel['state'] = record.result === 'confirmed' || record.result === 'soft' || record.result === 'posted' ? 'matched' : record.result === 'failed' ? 'ambiguous' : record.result === 'final' ? 'final' : record.result === 'unknown' ? 'unresolved' : record.result;
    return { id: record.id, state, observedAt: record.observedAt, reason: record.reason ?? null, retry: DENIED_RETRY, provenance };
  }

  private walletExecutionResults(context: ProjectionContext, attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[], reconciliations: readonly ReconciliationRecord[]): readonly WalletExecutionResult[] {
    const wallets = new Set(attempts.map(item => item.wallet));
    const results: WalletExecutionResult[] = [];
    for (const wallet of wallets) {
      const walletAttempts = attempts.filter(item => item.wallet.toLowerCase() === wallet.toLowerCase());
      const walletAttemptIds = new Set(walletAttempts.map(item => item.id));
      const walletReceipts = receipts.filter(item => item.transactionAttemptId !== undefined && walletAttemptIds.has(item.transactionAttemptId));
      const latestReceipt = walletReceipts.at(-1);
      const latestAttempt = walletAttempts.at(-1);
      const latestReconciliation = reconciliations.filter(item => item.attemptId !== undefined && walletAttemptIds.has(item.attemptId)).at(-1);
      const finality = latestReceipt ? this.receiptReadModel(context, latestReceipt, attempts).finality : latestAttempt?.robinhoodFinality ? finalityModel(context, latestAttempt.robinhoodFinality === 'final' ? 'ethereum_final' : latestAttempt.robinhoodFinality, latestAttempt.robinhoodFinality === 'final', latestAttempt.updatedAt, [storeProvenance(`attempt:${latestAttempt.id}`, latestAttempt.updatedAt)]) : null;
      const state = latestReconciliation?.result === 'reorged' ? 'Reorged' : latestReceipt?.state ?? latestAttempt?.state ?? 'Unknown';
      const reason = latestReconciliation?.result === 'reorged' ? { code: 'REORGED', label: 'Unknown' as const, message: 'Receipt history was downgraded after a reorg observation.', actor: 'chain' as const, occurredAt: latestReconciliation.observedAt, submittedWork: 'some' as const, retry: DENIED_RETRY, provenance: reconciliationProvenance(latestReconciliation) } : undefined;
      results.push({ walletId: wallet, address: wallet, state, attemptIds: walletAttempts.map(item => item.id), finality, ...(reason === undefined ? {} : { reason }), retry: DENIED_RETRY, freshness: latestReceipt ? classifyFreshness(latestReceipt.observedAt, null, context.now, 'read-model-v1') : latestAttempt ? classifyFreshness(latestAttempt.updatedAt, null, context.now, 'read-model-v1') : UNKNOWN_FRESHNESS });
    }
    return results;
  }

  private timelineEvent(event: EventRecord): TimelineEvent {
    const observedAt = validIso(event.at) ?? new Date(0).toISOString();
    return { id: event.id, type: event.type, state: stringValue(event.data.state) ?? null, occurredAt: observedAt, message: event.type.replaceAll('_', ' '), provenance: storeProvenance(`event:${event.id}`, observedAt) };
  }

  private projectAlerts(context: ProjectionContext, request: ProjectionRequest): ProjectionResult<readonly AlertReadModel[]> {
    const records = context.state.notificationOutbox.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const alerts = records.map(record => {
      const freshness = classifyFreshness(record.createdAt, record.deliveredAt ?? null, context.now, context.freshnessPolicyVersion);
      const provenance = [storeProvenance(`notification:${record.id}`, record.createdAt)];
      return { id: record.id, sourceEventId: record.sourceEventId, runId: record.runId ?? null, type: record.type, text: redactText(record.text), state: record.state, attempts: record.attempts.toString(), createdAt: record.createdAt, deliveredAt: record.deliveredAt ?? null, freshness, provenance } satisfies AlertReadModel;
    });
    const page = pageItems(alerts, request);
    return { data: page.items, issues: [], freshness: alerts.length === 0 ? UNKNOWN_FRESHNESS : aggregateFreshness(alerts.map(item => item.freshness)), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  }

  private projectHealth(context: ProjectionContext): ProjectionResult<SystemHealthReadModel> {
    const runtime = context.state.runtime;
    const operational = runtime.operational;
    const freshness = operational ? classifyFreshness(operational.observedAt, operational.expiresAt, context.now, context.freshnessPolicyVersion) : UNKNOWN_FRESHNESS;
    const blockers = [...new Set(runtime.blockingReasons)].map(reason => issue(reason, safeHealthMessage(reason), 'blocking', 'No safe action'));
    const reconciliation: SystemHealthReadModel['dependencies']['reconciliation'] = runtime.blockingReasons.some(reason => /RECONCILIATION|UNRESOLVED/i.test(reason)) ? 'required' : runtime.startupState === 'Reconciling' ? 'in_progress' : operational ? 'clear' : 'unknown';
    const data: SystemHealthReadModel = { state: context.state.killed ? 'Killed' : runtime.startupState === 'Ready' && blockers.length === 0 ? 'Ready' : operational ? 'Not ready' : 'Unknown', killSwitch: context.state.killed || operational?.killSwitchEngaged ? 'engaged' : operational ? 'clear' : 'unknown', dependencies: { engine: runtime.dependencies.engine ? 'ready' : 'not_ready', chain: runtime.dependencies.chain ? 'ready' : 'not_ready', backup: runtime.dependencies.backup ? 'ready' : 'not_ready', notifications: runtime.dependencies.notifications ? 'ready' : 'not_ready', reconciliation }, blockers, checkedAt: operational?.observedAt ?? context.generatedAt, freshness };
    return { data, issues: blockers, freshness };
  }
}

export class ReadModelV1Service extends Phase2ReadModelService {}

interface ProjectionResult<T> {
  readonly data: T;
  readonly issues: readonly ReadModelIssue[];
  readonly freshness: Freshness;
  readonly nextCursor?: string;
}

function issue(code: string, message: string, severity: ReadModelIssue['severity'], safeAction: SafeAction, provenance?: Provenance): ReadModelIssue {
  return { code, severity, message, retryable: safeAction === 'Refresh read model', safeAction, ...(provenance === undefined ? {} : { provenance }) };
}

function gateCheck(code: string, outcome: CheckOutcome, required: boolean, message: string, evaluatedAt: string | null, validUntil: string | null, provenance: Provenance | undefined, freshness: Freshness): GateCheck {
  return { code, outcome, required, message, evaluatedAt, validUntil, ...(provenance === undefined ? {} : { provenance }), freshness };
}

function readinessIssue(check: GateCheck, wallet: string): ReadModelIssue {
  const action: SafeAction = check.code === 'eligible' && check.outcome === 'unknown' ? 'Resolve eligibility' : check.code === 'simulated' && check.outcome !== 'pass' ? 'Validate again' : check.code === 'funded' && check.outcome === 'unknown' ? 'Fund wallet' : check.outcome === 'stale' ? 'Refresh read model' : check.code === 'reconciliation_clear' ? 'Wait for reconciliation' : 'Inspect';
  const severity = check.outcome === 'fail' ? 'blocking' : 'warning';
  return issue(`${check.code.toUpperCase()}_${check.outcome.toUpperCase()}`, `${check.message} Wallet ${wallet}.`, severity, action, check.provenance);
}

function nextReadinessAction(checks: readonly GateCheck[]): SafeAction {
  const failed = checks.find(check => check.outcome !== 'pass');
  if (!failed) return 'No safe action';
  if (failed.code === 'eligible' && failed.outcome === 'unknown') return 'Resolve eligibility';
  if (failed.code === 'funded' && failed.outcome === 'unknown') return 'Fund wallet';
  if (failed.outcome === 'stale') return 'Refresh read model';
  if (failed.code === 'simulated') return 'Validate again';
  if (failed.code === 'reconciliation_clear') return 'Wait for reconciliation';
  return 'Inspect';
}

function classifyFreshness(observedAt: string | null | undefined, expiresAt: string | null | undefined, asOf: Date, policyVersion: string): Freshness {
  const observed = dateMs(observedAt);
  const expires = dateMs(expiresAt);
  const now = asOf.getTime();
  if (observed === null || expires === null || !Number.isFinite(now) || expires < observed || now < observed) return { status: 'unknown', observedAt: validIso(observedAt), expiresAt: validIso(expiresAt), ageSeconds: null, policyVersion };
  return { status: now >= expires ? 'stale' : 'fresh', observedAt: new Date(observed).toISOString(), expiresAt: new Date(expires).toISOString(), ageSeconds: Math.floor((now - observed) / 1000).toString(), policyVersion };
}

function aggregateFreshness(values: readonly Freshness[]): Freshness {
  if (values.length === 0 || values.some(value => value.status === 'unknown')) return UNKNOWN_FRESHNESS;
  const stale = values.some(value => value.status === 'stale');
  const observed = values.map(value => value.observedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  const expires = values.map(value => value.expiresAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  const age = values.map(value => value.ageSeconds).filter((value): value is string => value !== null).sort((left, right) => Number(right) - Number(left))[0] ?? null;
  return { status: stale ? 'stale' : 'fresh', observedAt: observed, expiresAt: expires, ageSeconds: age, policyVersion: 'read-model-v1' };
}

function evidenceFreshness(evidence: BackendState['chainEvidence'][number], now: Date, version: string): Freshness { return classifyFreshness(evidence.checkedAt, evidence.expiresAt, now, version); }
function campaignFreshness(context: ProjectionContext, campaign: Campaign): Freshness { const evidence = context.state.chainEvidence.find(item => item.id === campaign.chainVerification.evidenceId); return evidence ? evidenceFreshness(evidence, context.now, context.freshnessPolicyVersion) : UNKNOWN_FRESHNESS; }

function evidenceProvenance(evidence: BackendState['chainEvidence'][number]): Provenance {
  return { kind: 'chain_observation', recordId: evidence.id, observedAt: evidence.checkedAt, sourceBlockNumber: evidence.sourceBlock.toString(), sourceBlockHash: evidence.sourceBlockHash, evidenceId: evidence.id, policyVersion: 'read-model-v1' };
}
function simulationProvenance(simulation: SimulationEvidenceRecord): Provenance { return { kind: 'simulation', recordId: simulation.id, observedAt: simulation.checkedAt, sourceBlockNumber: simulation.sourceBlock.toString(), sourceBlockHash: simulation.sourceBlockHash, policyVersion: 'read-model-v1' }; }
function reconciliationProvenance(record: ReconciliationRecord): Provenance { return { kind: 'reconciliation', recordId: record.id, observedAt: record.observedAt, policyVersion: 'read-model-v1' }; }
function storeProvenance(recordId: string, observedAt: string): Provenance { return { kind: 'backend_store', recordId, observedAt: validIso(observedAt) ?? new Date(0).toISOString(), policyVersion: 'read-model-v1' }; }

function sourcedAmount(value: bigint | null, kind: SourcedAmount['kind'], freshness: Freshness, provenance: readonly Provenance[]): SourcedAmount {
  if (value === null || value < 0n) return { amount: null, kind: 'unknown', freshness, provenance };
  return { amount: { value: value.toString(), asset: 'ETH', unit: 'wei', decimals: 18 }, kind, freshness, provenance };
}
function sourcedAmountOrNull(value: bigint | undefined, kind: SourcedAmount['kind'], freshness: Freshness, provenance: readonly Provenance[]): SourcedAmount | null { return value === undefined ? null : sourcedAmount(value, kind, freshness, provenance); }
function sourcedQuantity(value: bigint | null, freshness: Freshness, provenance: readonly Provenance[]): SourcedQuantity { return { value: value === null ? null : value.toString(), unit: 'gas', freshness, provenance }; }
function emptyReadinessSummary(freshness: Freshness): ReadinessSummary { return { total: '0', ready: '0', blocked: '0', unknown: '0', stale: '0', ineligible: '0', executing: '0', freshness }; }

function finalityModel(context: ProjectionContext, stage: FinalityReadModel['stage'], settlementReached: boolean, observedAt: string, provenance: readonly Provenance[], downgradeReason?: string): FinalityReadModel {
  const freshness = classifyFreshness(observedAt, null, context.now, context.freshnessPolicyVersion);
  return { stage, requiredStage: context.state.campaigns.some(campaign => campaign.chainId === 4663) ? 'ethereum_final' : 'confirmed', settlementReached, observedAt, freshness, provenance, ...(downgradeReason === undefined ? {} : { downgradeReason }) };
}

function latestSimulation(values: readonly SimulationEvidenceRecord[]): SimulationEvidenceRecord | undefined { return values.slice().sort((left, right) => left.checkedAt.localeCompare(right.checkedAt) || left.id.localeCompare(right.id)).at(-1); }
function latestAttemptForWallet(state: BackendState, campaignId: string, wallet: string): AttemptRecord | undefined { return state.attempts.filter(attempt => attempt.wallet.toLowerCase() === wallet.toLowerCase() && state.runs.find(run => run.id === attempt.runId)?.campaignId === campaignId).sort(attemptOrder).at(-1); }
function latestReceiptForAttempt(state: BackendState, attemptId: string | undefined): ReceiptRecord | undefined { return attemptId === undefined ? undefined : state.receipts.filter(receipt => receipt.transactionAttemptId === attemptId).sort(receiptOrder).at(-1); }

function pageItems<T>(values: readonly T[], request: ProjectionRequest): { readonly items: readonly T[]; readonly nextCursor?: string } {
  const limit = request.limit === undefined || !Number.isSafeInteger(request.limit) || request.limit <= 0 ? values.length : request.limit;
  const cursor = request.cursor === undefined || !Number.isSafeInteger(request.cursor) || request.cursor < 0 ? 0 : request.cursor;
  const items = values.slice(cursor, cursor + limit);
  return cursor + limit < values.length ? { items, nextCursor: (cursor + limit).toString() } : { items };
}

function sortKey(value: string): string { return validIso(value) ?? value; }
function eventOrder(left: EventRecord, right: EventRecord): number { return sortKey(left.at).localeCompare(sortKey(right.at)) || left.id.localeCompare(right.id); }
function attemptOrder(left: AttemptRecord, right: AttemptRecord): number { return sortKey(left.createdAt).localeCompare(sortKey(right.createdAt)) || left.id.localeCompare(right.id); }
function receiptOrder(left: ReceiptRecord, right: ReceiptRecord): number { return sortKey(left.observedAt).localeCompare(sortKey(right.observedAt)) || left.id.localeCompare(right.id); }
function reconciliationOrder(left: ReconciliationRecord, right: ReconciliationRecord): number { return sortKey(left.observedAt).localeCompare(sortKey(right.observedAt)) || left.id.localeCompare(right.id); }

function digestState(state: BackendState): string {
  const encoded = JSON.stringify(state, (_, value) => typeof value === 'bigint' ? `${value}n` : value) ?? '';
  return `snapshot_${createHash('sha256').update(encoded).digest('hex').slice(0, 24)}`;
}

function dateMs(value: string | null | undefined): number | null { if (!value) return null; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
function validIso(value: string | null | undefined): string | null { const parsed = dateMs(value); return parsed === null ? null : new Date(parsed).toISOString(); }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function addressValue(value: unknown): string | null { const candidate = stringValue(value); return candidate && /^0x[0-9a-fA-F]{40}$/.test(candidate) ? candidate : null; }
function integerValue(value: unknown): number | null { if (typeof value === 'number' && Number.isSafeInteger(value)) return value; if (typeof value === 'string' && /^\d+$/.test(value)) { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; } return null; }
function numberValue(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function bigintValue(value: unknown): bigint | null { try { if (typeof value === 'bigint' && value >= 0n) return value; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value); if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value); } catch { /* malformed facts remain unknown */ } return null; }
function dispositionValue(value: unknown): OpportunityReadModel['disposition'] | undefined { return value === 'discovered' || value === 'evaluating' || value === 'scored' || value === 'notified' || value === 'approved' || value === 'promoted' || value === 'rejected' || value === 'expired' ? value : undefined; }
function confidenceValue(value: unknown): OpportunityReadModel['score']['confidence']['label'] { return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown'; }
function publicStatusValue(value: unknown): CalendarEntry['publicStatus'] { return value === 'public' || value === 'fcfs' || value === 'allowlist' ? value : 'unknown'; }
function redactText(value: string): string { return value.replace(/(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]').replace(/0x[0-9a-f]{128,}/gi, '[REDACTED]'); }
function safeHealthMessage(code: string): string { const messages: Record<string, string> = { RECONCILIATION_REQUIRED: 'Reconcile in-flight chain observations before admitting new work.', DURABLE_STORE_REQUIRED: 'A durable store is required.', ATOMIC_STORE_REQUIRED: 'Cross-process atomic storage is required.', CHAIN_NOT_READY: 'Chain observation is not ready.', ENGINE_NOT_READY: 'Engine dependency is not ready.', BACKUP_NOT_READY: 'Backup verification is not ready.', NOTIFICATIONS_NOT_READY: 'Notification dependency is not ready.', KILLED: 'The kill switch is engaged.', UNRESOLVED_EXECUTIONS: 'One or more execution outcomes remain unresolved.' }; return messages[code] ?? 'A runtime dependency is not ready.'; }
