import {
  READ_MODEL_CONTRACT,
  READ_MODEL_VERSION,
  type AlertsReadModel,
  type CalendarReadModel,
  type HomeReadModel,
  type OpportunityReadModel,
  type ReadinessReadModel,
  type ReadModelEnvelope,
  type RunReadModel,
  type SystemHealth,
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
  return attention.every(isIssue) && opportunities.every(isRecord) && calendar.every(isRecord) && alerts.every(isRecord);
}

function isOpportunityList(value: unknown): value is ReadonlyArray<OpportunityReadModel> {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'id') && hasRecord(item, 'project') && hasRecord(item, 'chain') && hasRecord(item, 'gate'));
}

function isCalendar(value: unknown): value is CalendarReadModel {
  return Array.isArray(value) && value.every((item) => isRecord(item) && hasString(item, 'id') && hasRecord(item, 'project') && hasRecord(item, 'chain') && hasString(item, 'openingAt') && hasRecord(item, 'verification'));
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
    && hasString(value, 'availability')
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
  if (payload.data === null || payload.availability === 'unavailable') return payload as ReadModelEnvelope<T>;
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
  return route === '/home'
    || route === '/opportunities'
    || route === '/calendar'
    || route === '/alerts'
    || route === '/health'
    || /^\/campaigns\/[^/]+\/readiness$/.test(route)
    || /^\/runs\/[^/]+$/.test(route);
}

/** Routes implemented by Backend's GET-only read-model adapter. */
export class ReadModelClient {
  private readonly get: ReadModelGetter;
  private readonly basePath: string;

  public constructor(options: ReadModelClientOptions) {
    this.get = options.get;
    this.basePath = (options.basePath ?? '/api/v1/read-model').replace(/\/+$/, '') || '/api/v1/read-model';
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
