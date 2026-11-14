import {
  READ_MODEL_CONTRACT,
  READ_MODEL_VERSION,
  type AlertsReadModel,
  type AnalyticsReadModel,
  type CalendarReadModel,
  type HomeReadModel,
  type OpportunityReadModel,
  type ReadinessReadModel,
  type ReadModelEnvelope,
  type RunReadModel,
  type SystemHealth,
  type ReadOnlySnapshot,
  type DashboardPagination,
} from './contracts.js';

export interface ReadModelGetRequest {
  readonly method: 'GET';
  readonly path: string;
}

/**
 * The host supplies an authenticated GET transport. The request is immutable
 * and method-constrained so this package cannot issue a mutation request or
 * acquire browser wallet, RPC, signer, or key authority.
 */
export type ReadModelGetter = (request: ReadModelGetRequest) => Promise<unknown>;

export interface ReadModelClientOptions {
  get: ReadModelGetter;
  basePath?: string;
}

type UnknownRecord = Record<string, unknown>;
type DataGuard<T> = (data: unknown) => data is T;

const UNKNOWN_FRESHNESS = {
  status: 'unknown' as const,
  observedAt: null,
  expiresAt: null,
  ageSeconds: null,
  policyVersion: 'read-model-v1',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasRecord(value: UnknownRecord, key: string): boolean {
  return isRecord(value[key]);
}

function hasArray(value: UnknownRecord, key: string): boolean {
  return Array.isArray(value[key]);
}

function isFreshness(value: unknown): boolean {
  return isRecord(value) && (value.status === 'fresh' || value.status === 'stale' || value.status === 'unknown');
}

function isIssue(value: unknown): boolean {
  return isRecord(value) && hasString(value, 'code') && hasString(value, 'severity') && hasString(value, 'message') && hasString(value, 'safeAction');
}

function isHome(value: unknown): value is HomeReadModel {
  if (!isRecord(value) || !hasArray(value, 'attention') || !hasArray(value, 'opportunities') || !hasArray(value, 'calendarHighlights') || !hasArray(value, 'alerts') || !hasRecord(value, 'system')) return false;
  const attention = value.attention as unknown[];
  const opportunities = value.opportunities as unknown[];
  const calendar = value.calendarHighlights as unknown[];
  const alerts = value.alerts as unknown[];
  return attention.every(isIssue) && opportunities.every(isRecord) && calendar.every(isRecord) && alerts.every(isRecord) && isHealth(value.system);
}

function isOpportunityList(value: unknown): value is ReadonlyArray<OpportunityReadModel> {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'id') && hasRecord(item, 'project') && hasRecord(item, 'chain') && hasRecord(item, 'gate'));
}

function isNullableIsoTimestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isCalendar(value: unknown): value is CalendarReadModel {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'id') && hasRecord(item, 'project') && hasRecord(item, 'chain') && isNullableIsoTimestamp(item.openingAt) && hasRecord(item, 'verification'));
}

function nonnegativeCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function nullableMoney(value: unknown): boolean { return value === null || typeof value === 'string' && value.length <= 81 && /^-?(0|[1-9][0-9]*)$/.test(value); }
function nullableUnsignedMoney(value: unknown): boolean { return value === null || typeof value === 'string' && value.length <= 80 && /^(0|[1-9][0-9]*)$/.test(value); }
function analyticsKey(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,200}$/.test(value); }

function isAnalytics(value: unknown): value is AnalyticsReadModel {
  if (!isRecord(value) || value.mode !== 'shadow-only' || value.currency !== 'ETH' || value.method !== 'FIFO' || !isRecord(value.coverage) || !isRecord(value.totals) || !Array.isArray(value.groups) || value.groups.length > 20 || !Array.isArray(value.shadow) || value.shadow.length > 20) return false;
  const coverage = value.coverage;
  if (!['canonical-finalized-mints-only', 'verified-observed-transactions'].includes(String(coverage.scope)) || coverage.externalTransfersAndSalesComplete !== false || coverage.providerCoverageAsserted !== false || !['partial', 'provided-input-only', 'no_samples'].includes(String(coverage.acquisitionHistory))) return false;
  if (!['canonicalExecutions', 'completeCosts', 'incompleteCosts', 'confirmedActivities', 'pendingExcluded', 'reorgedExcluded', 'unavailableObservations', 'groupsOmitted'].every(key => nonnegativeCount(coverage[key]))) return false;
  if (!['recordedCanonicalCostWei', 'realizedPnlWei', 'realizedRoiBps', 'unrealizedPnlWei', 'transactionAndMarketplaceFeesWei'].every(key => nullableMoney((value.totals as UnknownRecord)[key]))) return false;
  if (!nullableUnsignedMoney(value.totals.recordedCanonicalCostWei) || !nullableUnsignedMoney(value.totals.transactionAndMarketplaceFeesWei)) return false;
  if (value.funding !== undefined) {
    const funding = value.funding;
    if (!isRecord(funding) || funding.principalIsExpense !== false || funding.allocatedGasAlreadyInAcquisitionBasis !== true || !nonnegativeCount(funding.unknownOperations) || !['principalWei', 'gasExpenseWei', 'allocatedGasWei', 'unallocatedGasWei'].every(key => typeof funding[key] === 'string' && nullableUnsignedMoney(funding[key]))) return false;
    if (BigInt(funding.allocatedGasWei as string) + BigInt(funding.unallocatedGasWei as string) !== BigInt(funding.gasExpenseWei as string)) return false;
  }
  return value.groups.every(row => isRecord(row) && ['wallet', 'campaign', 'signal_source', 'mint_type'].includes(String(row.dimension)) && analyticsKey(row.key) && nonnegativeCount(row.executions) && nonnegativeCount(row.dispositions) && nullableUnsignedMoney(row.recordedCostWei) && nullableMoney(row.realizedPnlWei) && typeof row.unknownBasisQuantity === 'string' && /^(0|[1-9][0-9]*)$/.test(row.unknownBasisQuantity) && row.unknownBasisQuantity.length <= 80)
    && value.shadow.every(row => isRecord(row) && analyticsKey(row.policyId) && nonnegativeCount(row.selected) && nonnegativeCount(row.measured) && nonnegativeCount(row.unknownOutcomes) && nullableMoney(row.knownRealizedPnlWei) && (row.winRateBps === null || nonnegativeCount(row.winRateBps) && row.winRateBps <= 10_000));
}

function isReadiness(value: unknown): value is ReadinessReadModel {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'campaignId') && hasRecord(item, 'wallet') && hasString(item, 'decision') && hasRecord(item, 'cost'));
}

function isFinality(value: unknown): boolean {
  return isRecord(value)
    && hasString(value, 'stage')
    && hasString(value, 'requiredStage')
    && typeof value.settlementReached === 'boolean';
}

function isAlerts(value: unknown): value is AlertsReadModel {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'id') && hasString(item, 'sourceEventId') && hasString(item, 'text') && hasString(item, 'state'));
}

function isRun(value: unknown): value is RunReadModel {
  if (!isRecord(value) || !hasRecord(value, 'run') || !hasRecord(value, 'campaign') || !hasArray(value, 'walletResults') || !hasArray(value, 'attempts') || !hasArray(value, 'receipts') || !hasArray(value, 'reconciliations') || !hasArray(value, 'events')) return false;
  const wallets = value.walletResults as unknown[];
  const receipts = value.receipts as unknown[];
  return wallets.every((item) => isRecord(item) && (item.finality === null || isFinality(item.finality)))
    && receipts.every((item) => isRecord(item) && isFinality(item.finality));
}

function isHealth(value: unknown): value is SystemHealth {
  if (isRecord(value) && value.discovery !== undefined) {
    const discovery = value.discovery;
    if (!isRecord(discovery) || !['starting', 'healthy', 'degraded'].includes(String(discovery.status)) || !Array.isArray(discovery.chains) || discovery.chains.length > 3) return false;
    const seen = new Set<number>();
    for (const row of discovery.chains) {
      if (!isRecord(row) || typeof row.chainId !== 'number' || ![1, 8453, 4663].includes(row.chainId) || seen.has(row.chainId) || !['starting', 'scanning', 'catching_up', 'partial', 'healthy', 'unavailable', 'stalled'].includes(String(row.state)) || row.lastSuccessAt !== undefined && (!isNullableIsoTimestamp(row.lastSuccessAt) || row.lastSuccessAt === null) || row.operation !== undefined && (typeof row.operation !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.operation))) return false;
      if (['lastSuccessBlock', 'headBlock'].some(key => row[key] !== undefined && (typeof row[key] !== 'string' || !/^(0|[1-9][0-9]{0,23})$/.test(row[key] as string))) || row.caughtUp !== undefined && typeof row.caughtUp !== 'boolean') return false;
      if (discovery.status === 'healthy' && ['unavailable', 'stalled', 'starting', 'catching_up', 'partial'].includes(String(row.state))) return false;
      seen.add(row.chainId);
    }
  }
  return isRecord(value) && hasString(value, 'state') && hasRecord(value, 'dependencies') && hasArray(value, 'blockers') && hasString(value, 'checkedAt');
}

function isEnvelope(value: unknown): value is ReadModelEnvelope<unknown> {
  return isRecord(value)
    && value.contract === READ_MODEL_CONTRACT
    && value.version === READ_MODEL_VERSION
    && hasString(value, 'requestId')
    && hasString(value, 'generatedAt')
    && hasRecord(value, 'snapshot')
    && hasString(value.snapshot as UnknownRecord, 'id')
    && hasString(value.snapshot as UnknownRecord, 'capturedAt')
    && hasString(value.snapshot as UnknownRecord, 'consistency')
    && typeof value.availability === 'string' && ['available', 'partial', 'stale', 'unavailable'].includes(value.availability)
    && isFreshness(value.freshness)
    && Array.isArray(value.issues)
    && (value.issues as unknown[]).every(isIssue);
}

function schemaIssue(code: string, message: string): ReadModelEnvelope<never>['issues'][number] {
  return { code, severity: 'blocking', message, retryable: false, safeAction: 'No safe action' };
}

function unavailableEnvelope(code: string, message: string): ReadModelEnvelope<never> {
  return {
    contract: READ_MODEL_CONTRACT,
    version: READ_MODEL_VERSION,
    requestId: 'unknown',
    generatedAt: '',
    snapshot: { id: 'unknown', capturedAt: '', consistency: 'partial' },
    availability: 'unavailable',
    freshness: UNKNOWN_FRESHNESS,
    data: null,
    issues: [schemaIssue(code, message)],
  };
}

function validateEnvelope<T>(payload: unknown, guard: DataGuard<T>): ReadModelEnvelope<T> {
  if (!isEnvelope(payload)) return unavailableEnvelope('READ_MODEL_ENVELOPE_INVALID', 'Backend returned an invalid read-model envelope.') as ReadModelEnvelope<T>;
  if (payload.availability === 'unavailable' && payload.data === null) return payload as ReadModelEnvelope<T>;
  if (!guard(payload.data)) {
    return {
      ...payload,
      availability: 'unavailable',
      data: null,
      issues: [...payload.issues, schemaIssue('READ_MODEL_SCHEMA_MISMATCH', 'Backend response shape does not match mintbot.read-model/v1; legacy data was not coerced.')],
    } as ReadModelEnvelope<T>;
  }
  return payload as ReadModelEnvelope<T>;
}

function isAllowedRoute(route: string): boolean {
  return route === '/analytics'
    || route === '/home'
    || route === '/opportunities'
    || route === '/calendar'
    || route === '/alerts'
    || route === '/health'
    || /^\/campaigns\/[^/]+\/readiness$/.test(route)
    || /^\/runs\/[^/]+$/.test(route);
}

function isPagination(value: unknown): value is DashboardPagination {
  return isRecord(value) && typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page >= 1
    && typeof value.pages === 'number' && Number.isSafeInteger(value.pages) && value.pages >= value.page && value.pages <= 9999
    && value.pageSize === 50 && isRecord(value.totals) && ['opportunities', 'calendar', 'alerts'].every(key => nonnegativeCount((value.totals as UnknownRecord)[key]))
    && value.pages === Math.max(1, Math.ceil(Math.max(...Object.values(value.totals as Record<string, number>)) / 50))
    && (value.readinessId === undefined || typeof value.readinessId === 'string' && /^[A-Za-z0-9_:-]{1,100}$/.test(value.readinessId));
}

/** Routes implemented by Backend's GET-only read-model adapter. */
export class ReadModelClient {
  private readonly get: ReadModelGetter;
  private readonly basePath: string;

  public constructor(options: ReadModelClientOptions) {
    this.get = options.get;
    this.basePath = (options.basePath ?? '/api/v1/read-model').replace(/\/+$/, '') || '/api/v1/read-model';
  }

  /** One backend capture. A malformed/mixed batch must never become a partial silent success. */
  public async getDashboard(readinessId?: string, page = 1): Promise<ReadOnlySnapshot> {
    const unavailable = (): ReadOnlySnapshot => {
      const envelope = unavailableEnvelope('DASHBOARD_SNAPSHOT_UNAVAILABLE', 'The consistent dashboard snapshot is unavailable.');
      return { pagination: envelope, home: envelope, calendar: envelope, alerts: envelope, health: envelope, analytics: envelope, ...(readinessId === undefined ? {} : { readiness: envelope }) };
    };
    if (readinessId !== undefined && !/^[A-Za-z0-9_:-]{1,100}$/.test(readinessId)) return unavailable();
    if (!Number.isSafeInteger(page) || page < 1 || page > 9999) return unavailable();
    try {
      const query = new URLSearchParams();
      if (readinessId !== undefined) query.set('readiness', readinessId);
      if (page !== 1) query.set('page', page.toString());
      const path = `${this.basePath}/dashboard${query.size === 0 ? '' : `?${query}`}`;
      const payload = await this.get(Object.freeze({ method: 'GET' as const, path }));
      if (!isEnvelope(payload) || !isRecord(payload.data) || payload.snapshot.consistency !== 'snapshot' || !isNullableIsoTimestamp(payload.generatedAt) || !isNullableIsoTimestamp(payload.snapshot.capturedAt)) return unavailable();
      const data = payload.data;
      const snapshot = {
        pagination: validateEnvelope(data.pagination, isPagination),
        home: validateEnvelope(data.home, isHome), calendar: validateEnvelope(data.calendar, isCalendar),
        alerts: validateEnvelope(data.alerts, isAlerts), health: validateEnvelope(data.health, isHealth),
        analytics: validateEnvelope(data.analytics, isAnalytics),
        ...(readinessId === undefined ? {} : { readiness: validateEnvelope(data.readiness, isReadiness) }),
      };
      if (Object.values(snapshot).some(surface => surface.snapshot.id !== payload.snapshot.id || surface.snapshot.capturedAt !== payload.snapshot.capturedAt || surface.generatedAt !== payload.generatedAt || surface.snapshot.consistency !== 'snapshot')) return unavailable();
      const metadata = snapshot.pagination.data;
      if (metadata) {
        const expected = (total: number): number => Math.min(metadata.pageSize, Math.max(0, total - (metadata.page - 1) * metadata.pageSize));
        if (snapshot.calendar.data && snapshot.calendar.data.length !== expected(metadata.totals.calendar) || snapshot.alerts.data && snapshot.alerts.data.length !== expected(metadata.totals.alerts) || snapshot.home.data && (snapshot.home.data.opportunities.length !== expected(metadata.totals.opportunities) || snapshot.home.data.calendarHighlights.length !== expected(metadata.totals.calendar) || snapshot.home.data.alerts.length !== expected(metadata.totals.alerts))) return unavailable();
      }
      if (!['available', 'partial', 'stale', 'unavailable'].includes(payload.availability) || payload.availability === 'unavailable' && !Object.values(snapshot).some(surface => surface.availability === 'unavailable')) return unavailable();
      return snapshot;
    } catch { return unavailable(); }
  }

  public getAnalytics(): Promise<ReadModelEnvelope<AnalyticsReadModel>> {
    return this.getRoute('/analytics', undefined, isAnalytics);
  }

  public getHome(): Promise<ReadModelEnvelope<HomeReadModel>> {
    return this.getRoute('/home', undefined, isHome);
  }

  public getOpportunities(): Promise<ReadModelEnvelope<ReadonlyArray<OpportunityReadModel>>> {
    return this.getRoute('/opportunities', undefined, isOpportunityList);
  }

  public getCalendar(cursor?: string): Promise<ReadModelEnvelope<CalendarReadModel>> {
    return this.getRoute('/calendar', cursor, isCalendar);
  }

  public getReadiness(campaignId: string): Promise<ReadModelEnvelope<ReadinessReadModel>> {
    return this.getRoute(`/campaigns/${encodeURIComponent(campaignId)}/readiness`, undefined, isReadiness);
  }

  public getRun(runId: string): Promise<ReadModelEnvelope<RunReadModel>> {
    return this.getRoute(`/runs/${encodeURIComponent(runId)}`, undefined, isRun);
  }

  public getAlerts(cursor?: string): Promise<ReadModelEnvelope<AlertsReadModel>> {
    return this.getRoute('/alerts', cursor, isAlerts);
  }

  public getHealth(): Promise<ReadModelEnvelope<SystemHealth>> {
    return this.getRoute('/health', undefined, isHealth);
  }

  private async getRoute<T>(route: string, cursor: string | undefined, guard: DataGuard<T>): Promise<ReadModelEnvelope<T>> {
    if (!isAllowedRoute(route)) return unavailableEnvelope('READ_MODEL_ROUTE_INVALID', 'Requested read-model route is not allowlisted.') as ReadModelEnvelope<T>;
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const request = Object.freeze({ method: 'GET' as const, path: `${this.basePath}${route}${query}` });
    try {
      return validateEnvelope(await this.get(request), guard);
    } catch {
      return unavailableEnvelope('READ_MODEL_TRANSPORT_ERROR', 'Backend read-model transport failed; no client-side substitute was used.') as ReadModelEnvelope<T>;
    }
  }
}
