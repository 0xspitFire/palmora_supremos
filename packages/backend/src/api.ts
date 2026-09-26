import { randomUUID } from 'node:crypto';
import type { BackendState } from './types.js';
import { ReadModelService, type ReadModelEnvelope } from './read-model.js';
import type { BackendStore } from './store.js';
import { Phase2ReadModelService, READ_MODEL_CONTRACT, READ_MODEL_VERSION, type ReadModelEnvelope as ReadModelV1Envelope } from './read-model-v1.js';

export interface ReadOnlyApiRequest { method: string; path: string; requestId?: string; }
export interface ReadOnlyApiResponse<T = unknown> { status: 200 | 400 | 404 | 405 | 503; headers: { allow: 'GET'; contentType: 'application/json' }; body: ReadModelEnvelope<T>; }

/** A transport-neutral GET-only API adapter for future HTTP/CLI consumers. */
export class ReadOnlyApi {
  constructor(private readonly readModels: ReadModelService) {}

  public handle(request: ReadOnlyApiRequest): ReadOnlyApiResponse {
    const requestId = request.requestId ?? randomUUID();
    if (request.method.toUpperCase() !== 'GET') return { status: 405, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'READ_MODEL_GET_ONLY', 'This read model is read-only') };
    let parsed: URL;
    try { parsed = new URL(request.path, 'http://read-model.invalid'); } catch { return { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'INVALID_READ_MODEL_PATH', 'The read-model path is invalid') }; }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/v1/read-model/home') return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getHomeEnvelope(requestId) };
    if (path === '/api/v1/read-model/health') return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getHealthEnvelope(requestId) };
    if (path === '/api/v1/read-model/alerts') return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getAlertsEnvelope(requestId, parsed.searchParams.get('cursor') ?? undefined) };
    if (path === '/api/v1/read-model/calendar') return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getCalendarEnvelope(requestId, parsed.searchParams.get('cursor') ?? undefined) };
    const runMatch = /^\/api\/v1\/read-model\/runs\/([^/]+)$/.exec(path);
    if (runMatch) { const decoded = this.decodeId(runMatch[1]); if (decoded === undefined) return { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'INVALID_READ_MODEL_ID', 'The requested identifier is invalid') }; return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getRunEnvelope(decoded, requestId) }; }
    const readinessMatch = /^\/api\/v1\/read-model\/campaigns\/([^/]+)\/readiness$/.exec(path);
    if (readinessMatch) { const decoded = this.decodeId(readinessMatch[1]); if (decoded === undefined) return { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'INVALID_READ_MODEL_ID', 'The requested identifier is invalid') }; return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModels.getReadinessEnvelope(decoded, requestId) }; }
    if (path === '/api/v1/read-model/opportunities' || /^\/api\/v1\/read-model\/opportunities\/[^/]+$/.test(path)) return { status: 503, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'OPPORTUNITIES_NOT_CONFIGURED', 'Opportunity evidence is not available in this operating shell') };
    return { status: 404, headers: { allow: 'GET', contentType: 'application/json' }, body: this.readModelsUnavailable(requestId, 'READ_MODEL_NOT_FOUND', 'Read model resource is unavailable') };
  }

  public get(path: string, requestId?: string): ReadModelEnvelope<unknown> {
    return this.handle({ method: 'GET', path, ...(requestId ? { requestId } : {}) }).body;
  }

  private readModelsUnavailable(requestId: string, code: string, message: string): ReadModelEnvelope<null> {
    const generatedAt = new Date().toISOString();
    // The service's unavailable helper is intentionally private; use a stable
    // safe envelope here rather than exposing store/configuration details.
    return { contract: 'mintbot.read-model', version: '1', requestId, generatedAt, snapshot: { id: 'unavailable', capturedAt: generatedAt, consistency: 'partial' }, availability: 'unavailable', freshness: { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion: 'phase2-v1' }, data: null, issues: [{ code, severity: 'blocking', message, retryable: false, safeAction: 'Inspect' }] };
  }

  private decodeId(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try { return decodeURIComponent(value); } catch { return undefined; }
  }
}

export interface Phase2ReadOnlyApiResponse { status: 200 | 400 | 404 | 405 | 503; headers: { allow: 'GET'; contentType: 'application/json' }; body: ReadModelV1Envelope<unknown>; }

/** GET-only transport adapter for the Phase 2 v1 projection service. */
export class Phase2ReadOnlyApi {
  constructor(private readonly readModels: Phase2ReadModelService, private readonly store: BackendStore) {}

  public handle(request: ReadOnlyApiRequest): Phase2ReadOnlyApiResponse {
    const requestId = request.requestId ?? randomUUID();
    if (request.method.toUpperCase() !== 'GET') return { status: 405, headers: { allow: 'GET', contentType: 'application/json' }, body: this.unavailable(requestId, 'READ_MODEL_GET_ONLY', 'This read model is read-only') };
    let parsed: URL;
    try { parsed = new URL(request.path, 'http://read-model.invalid'); } catch { return { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.unavailable(requestId, 'INVALID_READ_MODEL_PATH', 'The read-model path is invalid') }; }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    const state = this.store.snapshot();
    const cursor = this.numberParam(parsed.searchParams.get('cursor'), 0);
    const limit = this.numberParam(parsed.searchParams.get('limit'), 1);
    const projection = { requestId, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
    if (path === '/api/v1/read-model/home') return this.ok(this.readModels.home(state, projection));
    if (path === '/api/v1/read-model/health') return this.ok(this.readModels.health(state, projection));
    if (path === '/api/v1/read-model/alerts') return this.ok(this.readModels.alerts(state, projection));
    if (path === '/api/v1/read-model/calendar') return this.ok(this.readModels.calendar(state, projection));
    if (path === '/api/v1/read-model/opportunities' || /^\/api\/v1\/read-model\/opportunities\/[^/]+$/.test(path)) return this.ok(this.readModels.opportunities(state, projection));
    const runMatch = /^\/api\/v1\/read-model\/runs\/([^/]+)$/.exec(path);
    if (runMatch) { const decoded = this.decodeId(runMatch[1]); return decoded === undefined ? { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.unavailable(requestId, 'INVALID_READ_MODEL_ID', 'The requested identifier is invalid') } : this.ok(this.readModels.run(state, decoded, projection)); }
    const readinessMatch = /^\/api\/v1\/read-model\/campaigns\/([^/]+)\/readiness$/.exec(path);
    if (readinessMatch) { const decoded = this.decodeId(readinessMatch[1]); return decoded === undefined ? { status: 400, headers: { allow: 'GET', contentType: 'application/json' }, body: this.unavailable(requestId, 'INVALID_READ_MODEL_ID', 'The requested identifier is invalid') } : this.ok(this.readModels.readiness(state, decoded, projection)); }
    return { status: 404, headers: { allow: 'GET', contentType: 'application/json' }, body: this.unavailable(requestId, 'READ_MODEL_NOT_FOUND', 'Read model resource is unavailable') };
  }

  private ok(body: ReadModelV1Envelope<unknown>): Phase2ReadOnlyApiResponse { return { status: 200, headers: { allow: 'GET', contentType: 'application/json' }, body }; }

  private unavailable(requestId: string, code: string, message: string): ReadModelV1Envelope<null> {
    const generatedAt = new Date().toISOString();
    return { contract: READ_MODEL_CONTRACT, version: READ_MODEL_VERSION, requestId, generatedAt, snapshot: { id: 'unavailable', capturedAt: generatedAt, consistency: 'partial' }, availability: 'unavailable', freshness: { status: 'unknown', observedAt: null, expiresAt: null, ageSeconds: null, policyVersion: 'read-model-v1' }, data: null, issues: [{ code, severity: 'blocking', message, retryable: false, safeAction: 'Inspect' }] };
  }

  private numberParam(value: string | null, minimum: number): number | undefined { if (value === null || !/^\d+$/.test(value)) return undefined; const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined; }

  private decodeId(value: string | undefined): string | undefined { if (!value) return undefined; try { return decodeURIComponent(value); } catch { return undefined; } }
}

export { Phase2ReadOnlyApi as ReadModelApi };
export type { BackendState };
