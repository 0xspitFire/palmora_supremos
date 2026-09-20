import { createHash, randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { AttemptRecord, BackendState, Campaign, EventRecord, Freshness, ReadinessCheck, RunRecord } from './types.js';
import { PHASE2_DEFAULTS } from './phase2-defaults.js';
import { assertLiveOperationalReadiness } from './custody.js';

export interface RunReadModel { run: Readonly<RunRecord>; campaign: Readonly<Campaign>; events: readonly Readonly<EventRecord>[]; attempts: readonly Readonly<BackendState['attempts'][number]>[]; receipts: readonly Readonly<BackendState['receipts'][number]>[]; reconciliations: readonly Readonly<BackendState['reconciliations'][number]>[]; readiness: readonly Readonly<ReadinessCheck>[]; }

export type ReadModelAvailability = 'available' | 'partial' | 'stale' | 'unavailable';
export type ReadModelSeverity = 'info' | 'warning' | 'blocking';
export type ReadModelAction = 'Inspect' | 'Refresh read model' | 'Resolve eligibility' | 'Fund wallet' | 'Validate again' | 'Wait for reconciliation' | 'No safe action';

export interface ReadModelIssue {
  code: string;
  severity: ReadModelSeverity;
  message: string;
  retryable: boolean;
  safeAction: ReadModelAction;
}

export interface ReadModelEnvelope<T> {
  contract: 'mintbot.read-model';
  version: '1';
  requestId: string;
  generatedAt: string;
  snapshot: { id: string; capturedAt: string; consistency: 'snapshot' | 'partial' };
  availability: ReadModelAvailability;
  freshness: Freshness;
  data: T | null;
  issues: ReadModelIssue[];
  nextCursor?: string;
}

export interface EthAmount { value: string; asset: 'ETH'; unit: 'wei'; decimals: 18; }
export interface SourcedAmount { amount: EthAmount | null; kind: 'estimated' | 'reserved' | 'actual' | 'unknown'; freshness: Freshness; provenance: Array<{ kind: string; recordId: string; observedAt: string }>; }
export interface GateCheck { code: string; outcome: 'pass' | 'fail' | 'unknown' | 'stale'; required: boolean; message: string; evaluatedAt: string | null; validUntil: string | null; freshness: Freshness; }
export interface GateSummary { decision: 'permitted' | 'blocked' | 'unknown'; checks: GateCheck[]; blockers: ReadModelIssue[]; nextAction: ReadModelAction; }
export interface RetryPolicy { allowed: boolean; kind: 'none' | 'refresh_read' | 'reconcile' | 'replace' | 'resubmit' | 'rerun'; reasonCode: string; message: string; requiresFreshData: boolean; safeAction: ReadModelAction; }
export interface FinalityProjection { stage: 'unknown' | 'confirmed' | 'soft' | 'posted' | 'ethereum_final'; requiredStage: 'confirmed' | 'ethereum_final'; settlementReached: boolean; observedAt: string | null; freshness: Freshness; provenance: Array<{ kind: string; recordId: string; observedAt: string }>; downgradeReason?: string; }

export interface WalletReadinessProjection {
  campaignId: string;
  wallet: { id: string; address: string; label: string | null };
  state: string;
  decision: 'ready' | 'blocked' | 'unknown' | 'stale';
  checks: GateCheck[];
  blockers: ReadModelIssue[];
  cost: { mintValue: SourcedAmount; executionGas: SourcedAmount; dataPostingGas: SourcedAmount | null; priorityFeeComponent: SourcedAmount | null; estimatedTotal: SourcedAmount; balance: SourcedAmount | null };
  nextAction: ReadModelAction;
  freshness: Freshness;
  provenance: Array<{ kind: string; recordId: string; observedAt: string }>;
}

export interface ReadinessSummary { total: string; ready: string; blocked: string; unknown: string; stale: string; ineligible: string; executing: string; freshness: Freshness; }

export interface SystemHealthProjection {
  state: 'Ready' | 'Not ready' | 'Killed' | 'Unknown';
  killSwitch: 'clear' | 'engaged' | 'unknown';
  dependencies: { engine: 'ready' | 'not_ready' | 'unknown'; chain: 'ready' | 'not_ready' | 'unknown'; backup: 'ready' | 'not_ready' | 'unknown'; notifications: 'ready' | 'not_ready' | 'unknown'; reconciliation: 'clear' | 'required' | 'in_progress' | 'unknown' };
  blockers: ReadModelIssue[];
  checkedAt: string;
  freshness: Freshness;
}

export interface RunProjection {
  run: { id: string; campaignId: string; mode: 'dry-run' | 'live'; state: string; outcome: 'not_started' | 'dry_run_completed' | 'partial' | 'settled' | 'unknown'; createdAt: string; updatedAt: string; retry: RetryPolicy };
  campaign: { id: string; state: string; chainId: string; contract: string | null; quantity: string; cost: SourcedAmount; gate: GateSummary; freshness: Freshness; provenance: Array<{ kind: string; recordId: string; observedAt: string }> };
  walletResults: Array<{ walletId: string; address: string; state: string; attemptIds: string[]; finality: FinalityProjection | null; retry: RetryPolicy; freshness: Freshness }>;
  attempts: Array<{ id: string; walletId: string; hash: string | null; nonce: string | null; attemptNumber: string; replacementOfId: string | null; state: string; finality: FinalityProjection | null; retry: RetryPolicy; reason?: ReadModelIssue }>;
  receipts: Array<{ id: string; attemptId: string; hash: string; status: string; blockNumber: string | null; blockHash: string | null; gasUsed: { value: string; unit: 'gas'; freshness: Freshness; provenance: Array<{ kind: string; recordId: string; observedAt: string }> } | null; effectiveGasPrice: SourcedAmount | null; actualSpend: SourcedAmount | null; finality: FinalityProjection; }>;
  reconciliations: Array<{ id: string; state: string; observedAt: string; reason: string | null; retry: RetryPolicy }>;
  events: Array<{ id: string; type: string; state: string | null; occurredAt: string; message: string }>;
  freshness: Freshness;
  provenance: Array<{ kind: string; recordId: string; observedAt: string }>;
}

export interface ReadinessProjection { campaignId: string; rows: WalletReadinessProjection[]; summary: ReadinessSummary; }
export interface AlertProjection { id: string; type: string; state: string; text: string; runId: string | null; canonicalLink: string | null; createdAt: string; deliveredAt: string | null; }
export interface CalendarProjection { campaigns: Array<{ id: string; state: string; chainId: string; contract: string | null; openingAt: string | null; quantity: string; cost: SourcedAmount; freshness: Freshness; provenance: Array<{ kind: string; recordId: string; observedAt: string }>; nextAction: 'Inspect' }>; }
export interface HomeProjection { attention: ReadModelIssue[]; readinessSummary: ReadinessSummary; opportunities: readonly unknown[]; calendarHighlights: CalendarProjection['campaigns']; alerts: AlertProjection[]; system: SystemHealthProjection; }

const SAFE_ERROR = /(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|authorization|calldata|raw(?:[_-]?transaction)?|provider[_-]?payload)\s*[:=]\s*[^,\s]+/gi;

function safeMessage(value: string): string {
  return value.replace(SAFE_ERROR, (match) => `${match.slice(0, match.search(/[:=]/))}=[REDACTED]`).replace(/https?:\/\/[^\s]+/gi, '[endpoint]').slice(0, 500);
}

function amount(value: bigint | undefined, kind: SourcedAmount['kind'], freshness: Freshness, recordId: string, observedAt: string): SourcedAmount {
  return { amount: value === undefined ? null : { value: value.toString(), asset: 'ETH', unit: 'wei', decimals: 18 }, kind: value === undefined ? 'unknown' : kind, freshness, provenance: [{ kind: 'backend_store', recordId, observedAt }] };
}

function unknownFreshness(policyVersion = 'phase2-v1'): Freshness {
  return { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion };
}

function calculateFreshness(observedAt: string | null | undefined, expiresAt: string | null | undefined, now: Date, policyVersion = 'phase2-v1'): Freshness {
  if (!observedAt || !expiresAt || !Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(expiresAt))) return unknownFreshness(policyVersion);
  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(observedAt)) / 1_000));
  return { status: Date.parse(expiresAt) <= now.getTime() ? 'stale' : 'fresh', observedAt, expiresAt, ageSeconds: String(age), policyVersion };
}

function issue(code: string, severity: ReadModelSeverity, message: string, retryable = false, safeAction: ReadModelAction = 'Inspect'): ReadModelIssue {
  return { code, severity, message: safeMessage(message), retryable, safeAction };
}

function retryNone(reasonCode: string, message: string, safeAction: ReadModelAction = 'No safe action'): RetryPolicy {
  return { allowed: false, kind: 'none', reasonCode, message: safeMessage(message), requiresFreshData: false, safeAction };
}

function snapshotId(state: BackendState): string {
  const identity = { campaigns: state.campaigns.map((item) => [item.id, item.updatedAt]), runs: state.runs.map((item) => [item.id, item.updatedAt, item.state]), attempts: state.attempts.map((item) => [item.id, item.updatedAt]), receipts: state.receipts.map((item) => [item.id, item.observedAt]), jobs: state.jobs.map((item) => [item.id, item.updatedAt, item.state]) };
  return `snapshot_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)}`;
}

function wireFinality(chainId: 1 | 4663, attempt: AttemptRecord | undefined, receipt: BackendState['receipts'][number] | undefined, observedAt: string | null, now: Date, downgradeReason?: string): FinalityProjection {
  const stage: FinalityProjection['stage'] = chainId === 4663
    ? attempt?.state === 'Reorged' || receipt?.state === 'Reorged'
      ? 'unknown'
      : receipt?.finalityStage === 'ethereum_final' || attempt?.robinhoodFinality === 'final'
        ? 'ethereum_final'
        : receipt?.finalityStage === 'posted' || attempt?.robinhoodFinality === 'posted'
          ? 'posted'
          : receipt?.finalityStage === 'soft' || attempt?.robinhoodFinality === 'soft'
            ? 'soft'
            : 'unknown'
    : attempt?.state === 'Confirmed' && receipt?.state === 'Confirmed' && receipt.finalityStage === 'ethereum_final' ? 'confirmed' : 'unknown';
  const requiredStage = chainId === 4663 ? 'ethereum_final' : 'confirmed';
  const freshness = observedAt ? calculateFreshness(observedAt, new Date(Date.parse(observedAt) + PHASE2_DEFAULTS.readinessFreshnessMs).toISOString(), now) : unknownFreshness();
  const settlementReached = stage === requiredStage && attempt?.state === 'Confirmed' && receipt?.state === 'Confirmed';
  return { stage, requiredStage, settlementReached, observedAt, freshness, provenance: attempt && observedAt ? [{ kind: 'reconciliation', recordId: attempt.id, observedAt }] : [], ...(downgradeReason ? { downgradeReason: safeMessage(downgradeReason) } : {}) };
}

function chainGate(campaign: Campaign, now: Date): GateSummary {
  const checkFreshness = calculateFreshness(campaign.chainVerification.checkedAt, campaign.chainVerification.checkedAt ? new Date(Date.parse(campaign.chainVerification.checkedAt) + PHASE2_DEFAULTS.discoveryFreshnessMs).toISOString() : null, now);
  const verified = campaign.chainVerification.status === 'verified' && campaign.chainVerification.seaDropCompatible;
  const outcome = checkFreshness.status === 'unknown' ? 'unknown' : checkFreshness.status === 'stale' ? 'stale' : verified ? 'pass' : 'fail';
  const check: GateCheck = { code: 'chain_verified', outcome, required: true, message: verified ? 'Chain verification is recorded' : 'Chain verification is not currently available', evaluatedAt: campaign.chainVerification.checkedAt ?? null, validUntil: checkFreshness.expiresAt, freshness: checkFreshness };
  const blockers = verified && checkFreshness.status === 'fresh' ? [] : [issue(checkFreshness.status === 'unknown' ? 'CHAIN_VERIFICATION_UNKNOWN' : 'CHAIN_VERIFICATION_REQUIRED', 'blocking', checkFreshness.status === 'unknown' ? 'Chain verification freshness is unknown' : 'Chain verification must be current before live execution', false, 'Refresh read model')];
  return { decision: blockers.length === 0 ? 'permitted' : checkFreshness.status === 'unknown' ? 'unknown' : 'blocked', checks: [check], blockers, nextAction: blockers.length ? blockers[0]!.safeAction : 'Inspect' };
}

export class ReadModelService {
  constructor(private readonly store: BackendStore, private readonly now: () => Date = () => new Date()) {}

  /** Existing internal projection retained for CLI/backend compatibility. */
  getRun(runId: string, readiness: ReadinessCheck[] = []): RunReadModel {
    const state = this.store.snapshot();
    const run = state.runs.find(item => item.id === runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const campaign = state.campaigns.find(item => item.id === run.campaignId);
    if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    return { run, campaign, events: state.events.filter(event => event.runId === runId), attempts: state.attempts.filter(attempt => attempt.runId === runId), receipts: state.receipts.filter(receipt => receipt.runId === runId), reconciliations: state.reconciliations.filter(item => item.runId === runId), readiness };
  }

  public getRunEnvelope(runId: string, requestId: string = randomUUID()): ReadModelEnvelope<RunProjection> {
    const state = this.store.snapshot();
    const run = state.runs.find((item) => item.id === runId);
    const campaign = run ? state.campaigns.find((item) => item.id === run.campaignId) : undefined;
    if (!run || !campaign) return this.unavailable(requestId, run ? 'CAMPAIGN_NOT_FOUND' : 'RUN_NOT_FOUND', run ? 'Campaign data is unavailable' : 'Run data is unavailable');
    const data = this.projectRun(state, run, campaign);
    const unresolved = state.reconciliations.some((item) => item.runId === run.id && item.result === 'unknown') || (['Armed', 'Active'].includes(run.state) && state.attempts.some((attempt) => attempt.runId === run.id && attempt.hash) && !state.reconciliations.some((item) => item.runId === run.id));
    const freshness = calculateFreshness(run.updatedAt, isTerminalRun(run) ? new Date(Date.parse(run.updatedAt) + PHASE2_DEFAULTS.readModelRetentionMs).toISOString() : null, this.now());
    const issues = unresolved ? [issue('UNRESOLVED_EXECUTIONS', 'blocking', 'Transaction outcome is unresolved; wait for reconciliation', false, 'Wait for reconciliation')] : [];
    return this.envelope(requestId, data, freshness, issues);
  }

  public getReadinessEnvelope(campaignId: string, requestId: string = randomUUID(), asOf = this.now()): ReadModelEnvelope<ReadinessProjection> {
    const state = this.store.snapshot();
    const campaign = state.campaigns.find((item) => item.id === campaignId);
    if (!campaign) return this.unavailable(requestId, 'CAMPAIGN_NOT_FOUND', 'Campaign readiness is unavailable');
    const source = state.readiness.filter((item) => item.campaignId === campaignId);
    const intents = state.intents.filter((item) => item.campaignId === campaignId);
    const rows = source.length > 0 ? source.map((item) => this.projectReadiness(item, campaign, asOf)) : intents.flatMap((intent) => intent.wallets.map((wallet) => this.unknownReadiness(campaign, wallet)));
    const summary = this.readinessSummary(rows, asOf);
    const freshness = rows.length === 0 ? unknownFreshness() : this.aggregateFreshness(rows.map((row) => row.freshness), asOf);
    const issues = rows.flatMap((row) => row.blockers).filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code) === index);
    return this.envelope(requestId, { campaignId, rows, summary }, freshness, issues);
  }

  public getHealthEnvelope(requestId: string = randomUUID()): ReadModelEnvelope<SystemHealthProjection> {
    const state = this.store.snapshot();
    const checkedAt = this.now().toISOString();
    const data = this.projectHealth(state, checkedAt);
    const freshness = calculateFreshness(checkedAt, new Date(this.now().getTime() + 30_000).toISOString(), this.now(), 'phase2-health-v1');
    return this.envelope(requestId, data, freshness, data.blockers);
  }

  public getAlertsEnvelope(requestId: string = randomUUID(), cursor?: string): ReadModelEnvelope<{ alerts: AlertProjection[] }> {
    const state = this.store.snapshot();
    const cutoff = this.now().getTime() - PHASE2_DEFAULTS.alertRetentionMs;
    const start = decodeCursor(cursor);
    const source = state.notificationOutbox.filter((item) => Date.parse(item.createdAt) >= cutoff).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const alerts = source.slice(start, start + 100).map((item) => ({ id: item.id, type: item.type, state: item.state, text: safeMessage(item.text), runId: item.runId ?? null, canonicalLink: item.runId ? `/api/v1/read-model/runs/${encodeURIComponent(item.runId)}` : null, createdAt: item.createdAt, deliveredAt: item.deliveredAt ?? null }));
    const nextCursor = start + alerts.length < source.length ? encodeCursor(start + alerts.length) : undefined;
    return this.envelope(requestId, { alerts }, unknownFreshness('phase2-alert-v1'), [], nextCursor);
  }

  public getCalendarEnvelope(requestId: string = randomUUID(), cursor?: string): ReadModelEnvelope<CalendarProjection> {
    const state = this.store.snapshot();
    const start = decodeCursor(cursor);
    const campaigns = state.campaigns.sort((left, right) => (left.openingAt ?? left.createdAt).localeCompare(right.openingAt ?? right.createdAt)).slice(start, start + 100).map((campaign) => this.projectCalendar(campaign));
    const nextCursor = start + campaigns.length < state.campaigns.length ? encodeCursor(start + campaigns.length) : undefined;
    const freshness = campaigns.length ? this.aggregateFreshness(campaigns.map((item) => item.freshness), this.now()) : unknownFreshness('phase2-calendar-v1');
    const issues = campaigns.filter((item) => item.freshness.status !== 'fresh').map(() => issue('STALE_CALENDAR', 'warning', 'Calendar data may be out of date', false, 'Refresh read model'));
    return this.envelope(requestId, { campaigns }, freshness, issues, nextCursor);
  }

  public getHomeEnvelope(requestId: string = randomUUID()): ReadModelEnvelope<HomeProjection> {
    const health = this.getHealthEnvelope(`${requestId}:health`);
    const state = this.store.snapshot();
    const rows = state.readiness.map((item) => item.campaignId ? this.projectReadiness(item, state.campaigns.find((campaign) => campaign.id === item.campaignId) ?? this.syntheticCampaign(item), this.now()) : undefined).filter((item): item is WalletReadinessProjection => item !== undefined);
    const summary = this.readinessSummary(rows, this.now());
    const alerts = state.notificationOutbox.filter((item) => Date.parse(item.createdAt) >= this.now().getTime() - PHASE2_DEFAULTS.alertRetentionMs).map((item) => ({ id: item.id, type: item.type, state: item.state, text: safeMessage(item.text), runId: item.runId ?? null, canonicalLink: item.runId ? `/api/v1/read-model/runs/${encodeURIComponent(item.runId)}` : null, createdAt: item.createdAt, deliveredAt: item.deliveredAt ?? null }));
    const attention = [...health.data?.blockers ?? [], ...rows.flatMap((row) => row.blockers)].filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code) === index);
    const calendarHighlights = state.campaigns.slice(0, 10).map((item) => this.projectCalendar(item));
    const data: HomeProjection = { attention, readinessSummary: summary, opportunities: [], calendarHighlights, alerts, system: health.data ?? this.projectHealth(state, this.now().toISOString()) };
    return this.envelope(requestId, data, health.freshness, attention);
  }

  private projectRun(state: BackendState, run: RunRecord, campaign: Campaign): RunProjection {
    const attempts = state.attempts.filter((item) => item.runId === run.id);
    const receipts = state.receipts.filter((item) => item.runId === run.id);
    const reconciliations = state.reconciliations.filter((item) => item.runId === run.id);
    const freshness = calculateFreshness(run.updatedAt, isTerminalRun(run) ? new Date(Date.parse(run.updatedAt) + PHASE2_DEFAULTS.readModelRetentionMs).toISOString() : null, this.now());
    const attemptNumber = new Map<string, number>();
    const executionAttemptCount = new Map<string, number>();
    for (const attempt of attempts) {
      const number = (executionAttemptCount.get(attempt.executionId) ?? 0) + 1;
      executionAttemptCount.set(attempt.executionId, number);
      attemptNumber.set(attempt.id, number);
    }
    const attemptForReceipt = (receipt: BackendState['receipts'][number]) => attempts.find((attempt) => attempt.id === receipt.transactionAttemptId) ?? attempts.find((attempt) => attempt.executionId === receipt.executionId);
    const campaignGate = chainGate(campaign, this.now());
    const mintValue = campaign.mintPriceWei * BigInt(campaign.quantity);
    const totalCost = mintValue + (campaign.feePolicy.totalFeeBudgetWei ?? 0n);
    const cost = amount(totalCost, 'estimated', freshness, campaign.id, campaign.updatedAt);
    const walletIds = new Map<string, string>();
    for (const intent of state.intents.filter((item) => item.runId === run.id)) for (const wallet of intent.wallets) walletIds.set(wallet.toLowerCase(), wallet);
    for (const attempt of attempts) walletIds.set(attempt.wallet.toLowerCase(), attempt.wallet);
    const walletResults = [...walletIds.values()].map((wallet) => {
      const walletAttempts = attempts.filter((attempt) => attempt.wallet.toLowerCase() === wallet.toLowerCase());
      const latest = walletAttempts.at(-1);
      const finalReceipt = latest ? receipts.find((receipt) => receipt.executionId === latest.executionId && receipt.state === 'Confirmed') : undefined;
      const finality = latest ? wireFinality(campaign.chainId, latest, finalReceipt, finalReceipt?.observedAt ?? latest.updatedAt, this.now()) : null;
      const success = finality?.settlementReached === true;
      return { walletId: wallet, address: wallet, state: success ? 'Minted' : latest?.state === 'Failed' ? 'Failed' : latest ? 'Executing' : 'Unknown', attemptIds: walletAttempts.map((item) => item.id), finality, retry: retryNone(success ? 'SETTLED' : latest?.state === 'Reorged' ? 'RECONCILIATION_REQUIRED' : 'NO_SAFE_RETRY', success ? 'Settlement is recorded' : 'Outcome remains controlled by the Backend', success ? 'Inspect' : latest?.state === 'Reorged' ? 'Wait for reconciliation' : 'No safe action'), freshness };
    });
    const attemptProjection = attempts.map((attempt) => {
      const receipt = receipts.find((item) => item.executionId === attempt.executionId);
      const finality = wireFinality(campaign.chainId, attempt, receipt, receipt?.observedAt ?? attempt.updatedAt, this.now(), attempt.state === 'Reorged' ? 'Canonical observation changed; prior finality is downgraded' : undefined);
      const state = campaign.chainId === 4663 && attempt.robinhoodFinality === 'soft' ? 'Included' : campaign.chainId === 4663 && attempt.robinhoodFinality === 'posted' ? 'Posted to Ethereum' : campaign.chainId === 4663 && attempt.robinhoodFinality === 'final' ? 'Ethereum final' : attempt.state;
      return { id: attempt.id, walletId: attempt.wallet, hash: attempt.hash ?? null, nonce: attempt.nonce === undefined ? null : String(attempt.nonce), attemptNumber: String(attemptNumber.get(attempt.id) ?? 1), replacementOfId: attempt.replacementOfId ?? null, state, finality, retry: retryNone(attempt.state === 'Reorged' ? 'RECONCILIATION_REQUIRED' : 'NO_SAFE_RETRY', attempt.state === 'Reorged' ? 'Reconciliation is required before retry' : 'No retry is authorized from this read model', attempt.state === 'Reorged' ? 'Wait for reconciliation' : 'No safe action'), ...(attempt.redactedError ? { reason: issue('EXECUTION_ERROR', 'warning', 'Execution did not complete', false, 'Inspect') } : {}) };
    });
    const receiptProjection = receipts.map((receipt) => {
      const attempt = attemptForReceipt(receipt);
      const finality = wireFinality(campaign.chainId, attempt, receipt, receipt.observedAt, this.now(), receipt.state === 'Reorged' ? 'Receipt is no longer canonical' : undefined);
      const receiptFreshness = calculateFreshness(receipt.observedAt, new Date(Date.parse(receipt.observedAt) + PHASE2_DEFAULTS.readModelRetentionMs).toISOString(), this.now());
      const receiptProvenance = [{ kind: 'chain_observation', recordId: receipt.id, observedAt: receipt.observedAt }];
      const status = receipt.state === 'Confirmed' ? 'confirmed' : receipt.state === 'Failed' ? 'reverted' : receipt.state === 'Reorged' ? 'reorged' : receipt.state === 'Submitted' || receipt.state === 'Pending' ? 'pending' : 'pending';
      return { id: receipt.id, attemptId: receipt.transactionAttemptId ?? attempt?.id ?? '', hash: attempt?.hash ?? '', status, blockNumber: receipt.blockNumber === undefined ? null : String(receipt.blockNumber), blockHash: receipt.blockHash ?? null, gasUsed: receipt.gasUsed === undefined ? null : { value: receipt.gasUsed.toString(), unit: 'gas' as const, freshness: receiptFreshness, provenance: receiptProvenance }, effectiveGasPrice: receipt.effectiveGasPrice === undefined ? null : amount(receipt.effectiveGasPrice, 'actual', receiptFreshness, receipt.id, receipt.observedAt), actualSpend: amount(receipt.actualSpendWei, 'actual', receiptFreshness, receipt.id, receipt.observedAt), finality };
    });
    const eventProjection = state.events.filter((event) => event.runId === run.id).map((event) => ({ id: event.id, type: event.type, state: typeof event.data.state === 'string' ? event.data.state : null, occurredAt: event.at, message: safeMessage(event.type.replaceAll('_', ' ')) }));
    const settlementReady = walletResults.length > 0 && walletResults.every((wallet) => wallet.finality?.settlementReached === true);
    const outcome: RunProjection['run']['outcome'] = run.mode === 'dry-run' && run.state === 'Completed' ? 'dry_run_completed' : run.state === 'Completed' && settlementReady ? 'settled' : run.state === 'Completed' ? 'partial' : run.state === 'Failed' && attempts.length > 0 ? 'partial' : ['Failed', 'Aborted'].includes(run.state) ? attempts.length > 0 ? 'partial' : 'unknown' : attempts.length > 0 ? 'partial' : 'not_started';
    return { run: { id: run.id, campaignId: run.campaignId, mode: run.mode, state: run.state, outcome, createdAt: run.createdAt, updatedAt: run.updatedAt, retry: retryNone('NO_SAFE_RETRY', 'Run retry is controlled by Backend admission') }, campaign: { id: campaign.id, state: campaign.state, chainId: String(campaign.chainId), contract: campaign.contract ?? null, quantity: String(campaign.quantity), cost, gate: campaignGate, freshness, provenance: [{ kind: 'backend_store', recordId: campaign.id, observedAt: campaign.updatedAt }] }, walletResults, attempts: attemptProjection, receipts: receiptProjection, reconciliations: reconciliations.map((item) => ({ id: item.id, state: item.result, observedAt: item.observedAt, reason: item.reason ? safeMessage(item.reason) : null, retry: retryNone(item.result === 'unknown' ? 'RECONCILIATION_REQUIRED' : 'NO_SAFE_RETRY', item.result === 'unknown' ? 'Wait for reconciliation' : 'No retry is authorized', item.result === 'unknown' ? 'Wait for reconciliation' : 'No safe action') })), events: eventProjection, freshness, provenance: [{ kind: 'backend_store', recordId: run.id, observedAt: run.updatedAt }] };
  }

  private projectReadiness(check: ReadinessCheck, campaign: Campaign, asOf: Date): WalletReadinessProjection {
    const freshness = calculateFreshness(check.observedAt ?? campaign.updatedAt, check.freshUntil, asOf, 'phase2-readiness-v1');
    const checkEntries = Object.entries(check.checks);
    const checks = checkEntries.map(([code, value]) => ({ code, outcome: freshness.status === 'stale' && value ? 'stale' : freshness.status === 'unknown' ? 'unknown' : check.checkStates?.[code] ?? (value ? 'pass' : 'fail'), required: true, message: value ? `${code} check passed` : `${code} check is blocking`, evaluatedAt: check.observedAt ?? null, validUntil: check.freshUntil, freshness } satisfies GateCheck));
    const blockers = check.blockingReasons.map((reason) => this.readinessIssue(reason));
    if (freshness.status === 'stale' && blockers.length === 0) blockers.push(issue('READINESS_STALE', 'blocking', 'Readiness evidence is stale', false, 'Refresh read model'));
    if (freshness.status === 'unknown' && blockers.length === 0) blockers.push(issue('READINESS_UNKNOWN', 'blocking', 'Readiness evidence freshness is unknown', false, 'Refresh read model'));
    const decision: WalletReadinessProjection['decision'] = freshness.status === 'stale' ? 'stale' : freshness.status === 'unknown' ? 'unknown' : check.state === 'Ready' ? 'ready' : check.state === 'Unknown' ? 'unknown' : blockers.length ? 'blocked' : 'unknown';
    const mint = campaign.mintPriceWei * BigInt(campaign.quantity);
    const total = mint + (campaign.feePolicy.totalFeeBudgetWei ?? 0n);
    const costFreshness = calculateFreshness(campaign.updatedAt, new Date(Date.parse(campaign.updatedAt) + PHASE2_DEFAULTS.calendarFreshnessMs).toISOString(), asOf, 'phase2-cost-v1');
    const source = [{ kind: 'backend_store', recordId: campaign.id, observedAt: campaign.updatedAt }];
    return { campaignId: campaign.id, wallet: { id: check.wallet, address: check.wallet, label: null }, state: check.state, decision, checks, blockers, cost: { mintValue: amount(mint, 'estimated', costFreshness, campaign.id, campaign.updatedAt), executionGas: amount(campaign.feePolicy.l2ExecutionGasBudgetWei, 'estimated', costFreshness, campaign.id, campaign.updatedAt), dataPostingGas: campaign.feePolicy.l1DataGasBudgetWei === undefined ? null : amount(campaign.feePolicy.l1DataGasBudgetWei, 'estimated', costFreshness, campaign.id, campaign.updatedAt), priorityFeeComponent: amount(campaign.feePolicy.configuredPriorityFeeWei, 'estimated', costFreshness, campaign.id, campaign.updatedAt), estimatedTotal: amount(total, 'estimated', costFreshness, campaign.id, campaign.updatedAt), balance: null }, nextAction: blockers[0]?.safeAction ?? 'Inspect', freshness, provenance: source };
  }

  private unknownReadiness(campaign: Campaign, wallet: string): WalletReadinessProjection {
    const freshness = unknownFreshness('phase2-readiness-v1');
    const blocker = issue('ELIGIBILITY_UNKNOWN', 'blocking', 'Eligibility has not been observed for this wallet', false, 'Resolve eligibility');
    const check: GateCheck = { code: 'eligible', outcome: 'unknown', required: true, message: 'Eligibility is unknown', evaluatedAt: null, validUntil: null, freshness };
    const total = campaign.mintPriceWei * BigInt(campaign.quantity) + (campaign.feePolicy.totalFeeBudgetWei ?? 0n);
    const source = [{ kind: 'backend_store', recordId: campaign.id, observedAt: campaign.updatedAt }];
    return { campaignId: campaign.id, wallet: { id: wallet, address: wallet, label: null }, state: 'Unknown', decision: 'unknown', checks: [check], blockers: [blocker], cost: { mintValue: amount(campaign.mintPriceWei * BigInt(campaign.quantity), 'estimated', freshness, campaign.id, campaign.updatedAt), executionGas: amount(campaign.feePolicy.l2ExecutionGasBudgetWei, 'estimated', freshness, campaign.id, campaign.updatedAt), dataPostingGas: campaign.feePolicy.l1DataGasBudgetWei === undefined ? null : amount(campaign.feePolicy.l1DataGasBudgetWei, 'estimated', freshness, campaign.id, campaign.updatedAt), priorityFeeComponent: amount(campaign.feePolicy.configuredPriorityFeeWei, 'estimated', freshness, campaign.id, campaign.updatedAt), estimatedTotal: amount(total, 'estimated', freshness, campaign.id, campaign.updatedAt), balance: null }, nextAction: 'Resolve eligibility', freshness, provenance: source };
  }

  private projectCalendar(campaign: Campaign): CalendarProjection['campaigns'][number] {
    const now = this.now();
    const freshness = calculateFreshness(campaign.updatedAt, new Date(Date.parse(campaign.updatedAt) + PHASE2_DEFAULTS.calendarFreshnessMs).toISOString(), now, 'phase2-calendar-v1');
    const cost = amount(campaign.mintPriceWei * BigInt(campaign.quantity) + (campaign.feePolicy.totalFeeBudgetWei ?? 0n), 'estimated', freshness, campaign.id, campaign.updatedAt);
    return { id: campaign.id, state: campaign.state, chainId: String(campaign.chainId), contract: campaign.contract ?? null, openingAt: campaign.openingAt ?? null, quantity: String(campaign.quantity), cost, freshness, provenance: [{ kind: 'backend_store', recordId: campaign.id, observedAt: campaign.updatedAt }], nextAction: 'Inspect' };
  }

  private projectHealth(state: BackendState, checkedAt: string): SystemHealthProjection {
    const dependencies = { engine: state.runtime.dependencies.engine ? 'ready' : 'not_ready', chain: state.runtime.dependencies.chain ? 'ready' : 'not_ready', backup: state.runtime.dependencies.backup ? 'ready' : 'not_ready', notifications: state.runtime.dependencies.notifications ? 'ready' : 'not_ready', reconciliation: state.runtime.startupState === 'Reconciling' ? 'in_progress' : state.runtime.startupState === 'Ready' ? 'clear' : 'required' } as SystemHealthProjection['dependencies'];
    const blockers = state.runtime.blockingReasons.map((reason) => issue(reason, 'blocking', this.healthMessage(reason), false, reason.includes('RECONCILI') ? 'Wait for reconciliation' : 'Inspect'));
    for (const [name, ready] of Object.entries(state.runtime.dependencies)) if (!ready) blockers.push(issue(`${name.toUpperCase()}_NOT_READY`, 'blocking', `${name} dependency is not ready`, false, name === 'notifications' ? 'Inspect' : 'Wait for reconciliation'));
    const operational = state.runtime.operational;
    if (operational) {
      if (operational.signerReady !== true) blockers.push(issue('SIGNER_NOT_READY', 'blocking', 'The configured signer is not ready', false, 'Inspect'));
      if (!operational.notificationReady) blockers.push(issue('NOTIFICATIONS_NOT_READY', 'blocking', 'Notification delivery is not ready', false, 'Inspect'));
      if (operational.chainVerification !== 'verified') blockers.push(issue('CHAIN_VERIFICATION_REQUIRED', 'blocking', 'Chain verification is not current', false, 'Refresh read model'));
      if (Number.isFinite(Date.parse(operational.expiresAt)) && Date.parse(operational.expiresAt) <= Date.parse(checkedAt)) blockers.push(issue('OPERATIONAL_READINESS_STALE', 'blocking', 'Operational readiness evidence is stale', false, 'Refresh read model'));
      try { assertLiveOperationalReadiness(operational, new Date(checkedAt)); } catch (error) { blockers.push(issue(error instanceof Error ? error.message : 'CUSTODY_READINESS_REQUIRED', 'blocking', 'Custody readiness evidence is missing or invalid', false, 'Inspect')); }
    }
    if (state.runtime.startupState !== 'Ready' && !blockers.some((item) => item.code === 'STARTUP_RECONCILIATION_REQUIRED')) blockers.push(issue('STARTUP_RECONCILIATION_REQUIRED', 'blocking', 'Startup reconciliation is not complete', false, 'Wait for reconciliation'));
    const killed = state.killed || operational?.killSwitchEngaged === true;
    if (killed && !blockers.some((item) => item.code === 'KILLED')) blockers.push(issue('KILLED', 'blocking', 'The kill switch is engaged', false, 'No safe action'));
    return { state: killed ? 'Killed' : state.runtime.startupState === 'Ready' && blockers.length === 0 ? 'Ready' : state.runtime.startupState === 'Cold' ? 'Unknown' : 'Not ready', killSwitch: killed ? 'engaged' : 'clear', dependencies, blockers, checkedAt, freshness: calculateFreshness(checkedAt, new Date(Date.parse(checkedAt) + 30_000).toISOString(), this.now(), 'phase2-health-v1') };
  }

  private readinessSummary(rows: readonly WalletReadinessProjection[], asOf: Date): ReadinessSummary {
    const count = (predicate: (row: WalletReadinessProjection) => boolean): string => String(rows.filter(predicate).length);
    return { total: String(rows.length), ready: count((row) => row.decision === 'ready'), blocked: count((row) => row.decision === 'blocked'), unknown: count((row) => row.decision === 'unknown'), stale: count((row) => row.decision === 'stale'), ineligible: count((row) => row.state === 'Skipped' || row.state === 'Failed'), executing: count((row) => row.state === 'Executing'), freshness: rows.length ? this.aggregateFreshness(rows.map((row) => row.freshness), asOf) : unknownFreshness('phase2-readiness-v1') };
  }

  private aggregateFreshness(items: readonly Freshness[], asOf: Date): Freshness {
    if (items.length === 0 || items.some((item) => item.status === 'unknown')) return unknownFreshness(items[0]?.policyVersion ?? 'phase2-v1');
    const observed = items.map((item) => item.observedAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    const expires = items.map((item) => item.expiresAt).filter((value): value is string => value !== null).sort()[0] ?? null;
    return calculateFreshness(observed, expires, asOf, items[0]?.policyVersion ?? 'phase2-v1');
  }

  private readinessIssue(reason: string): ReadModelIssue {
    const normalized = reason.toLowerCase();
    if (normalized.includes('fund')) return issue('WALLET_UNFUNDED', 'blocking', 'Wallet needs funding for this campaign', false, 'Fund wallet');
    if (normalized.includes('eligib')) return issue('ELIGIBILITY_BLOCKED', 'blocking', 'Wallet eligibility is not confirmed', false, 'Resolve eligibility');
    if (normalized.includes('simulat')) return issue('SIMULATION_BLOCKED', 'blocking', 'Simulation did not pass for this wallet', false, 'Validate again');
    if (normalized.includes('stale')) return issue('READINESS_STALE', 'blocking', 'Readiness evidence is stale', false, 'Refresh read model');
    return issue(reason.toUpperCase().replaceAll(' ', '_'), 'blocking', 'A required readiness check is not complete', false, 'Inspect');
  }

  private healthMessage(reason: string): string {
    if (reason === 'KILLED') return 'The kill switch is engaged; no new live work will be admitted';
    if (reason.includes('RECONCILI')) return 'Submitted work must be reconciled before live work can continue';
    if (reason.includes('NOT_READY')) return 'A required operational dependency is not ready';
    return 'The operating shell is not ready for this action';
  }

  private syntheticCampaign(check: ReadinessCheck): Campaign {
    return { id: check.campaignId ?? 'unknown', state: 'Draft', chainId: 1, contract: '', strategy: 'unknown', quantity: 1, dryRun: true, spendPolicy: { maxRunWei: 0n, dailyCapWei: 0n, gasCeilingWei: 0n }, chainVerification: { chainId: 1, status: 'unverified', seaDropCompatible: false, endpointReference: 'omitted' }, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 0n }, createdAt: check.observedAt ?? new Date(0).toISOString(), updatedAt: check.observedAt ?? new Date(0).toISOString() };
  }

  private envelope<T>(requestId: string, data: T, freshness: Freshness, issues: ReadModelIssue[], nextCursor?: string): ReadModelEnvelope<T> {
    const generatedAt = this.now().toISOString();
    const state = this.store.snapshot();
    const availability: ReadModelAvailability = freshness.status === 'stale' ? 'stale' : freshness.status === 'unknown' || issues.some((item) => item.severity === 'blocking') ? 'partial' : 'available';
    return { contract: 'mintbot.read-model', version: '1', requestId, generatedAt, snapshot: { id: snapshotId(state), capturedAt: generatedAt, consistency: issues.length ? 'partial' : 'snapshot' }, availability, freshness, data, issues: issues.map((item) => ({ ...item, message: safeMessage(item.message) })), ...(nextCursor ? { nextCursor } : {}) };
  }

  private unavailable<T>(requestId: string, code: string, message: string): ReadModelEnvelope<T> {
    const generatedAt = this.now().toISOString();
    return { contract: 'mintbot.read-model', version: '1', requestId, generatedAt, snapshot: { id: snapshotId(this.store.snapshot()), capturedAt: generatedAt, consistency: 'partial' }, availability: 'unavailable', freshness: unknownFreshness(), data: null, issues: [issue(code, 'blocking', message, false, 'Inspect')] };
  }
}

function isTerminalRun(run: RunRecord): boolean { return ['Completed', 'Failed', 'Aborted', 'Cancelled'].includes(run.state); }
function encodeCursor(offset: number): string { return Buffer.from(String(offset), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string | undefined): number { if (!cursor) return 0; const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10); return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
