import { randomUUID } from 'node:crypto';
import type { BackendState } from './types.js';
import { ReadModelService, type ReadModelEnvelope } from './read-model.js';

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

export { ReadOnlyApi as ReadModelApi };
export type { BackendState };
