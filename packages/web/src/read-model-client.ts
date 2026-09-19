import type {
  AlertsReadModel,
  CalendarReadModel,
  HomeReadModel,
  OpportunityReadModel,
  ReadinessReadModel,
  ReadModelEnvelope,
  RunReadModel,
  SystemHealth,
} from './contracts.js';

/**
 * The host supplies an authenticated GET transport. Keeping it injected means
 * this package cannot acquire browser wallet, RPC, signer, or key authority.
 */
export type ReadModelGetter = <T>(path: string) => Promise<ReadModelEnvelope<T>>;

export interface ReadModelClientOptions {
  get: ReadModelGetter;
  basePath?: string;
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
    return this.getRoute<HomeReadModel>('/home');
  }

  public getOpportunities(): Promise<ReadModelEnvelope<ReadonlyArray<OpportunityReadModel>>> {
    return this.getRoute<ReadonlyArray<OpportunityReadModel>>('/opportunities');
  }

  public getCalendar(cursor?: string): Promise<ReadModelEnvelope<CalendarReadModel>> {
    return this.getRoute<CalendarReadModel>('/calendar', cursor);
  }

  public getReadiness(campaignId: string): Promise<ReadModelEnvelope<ReadinessReadModel>> {
    return this.getRoute<ReadinessReadModel>(`/campaigns/${encodeURIComponent(campaignId)}/readiness`);
  }

  public getRun(runId: string): Promise<ReadModelEnvelope<RunReadModel>> {
    return this.getRoute<RunReadModel>(`/runs/${encodeURIComponent(runId)}`);
  }

  public getAlerts(cursor?: string): Promise<ReadModelEnvelope<AlertsReadModel>> {
    return this.getRoute<AlertsReadModel>('/alerts', cursor);
  }

  public getHealth(): Promise<ReadModelEnvelope<SystemHealth>> {
    return this.getRoute<SystemHealth>('/health');
  }

  private getRoute<T>(route: string, cursor?: string): Promise<ReadModelEnvelope<T>> {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return this.get(`${this.basePath}${route}${query}`);
  }
}
