import type { BackendStore } from './store.js';
import type { BackendState, Campaign, EventRecord, ReadinessCheck, RunRecord } from './types.js';
export interface RunReadModel { run: Readonly<RunRecord>; campaign: Readonly<Campaign>; events: readonly Readonly<EventRecord>[]; attempts: readonly Readonly<BackendState['attempts'][number]>[]; receipts: readonly Readonly<BackendState['receipts'][number]>[]; reconciliations: readonly Readonly<BackendState['reconciliations'][number]>[]; readiness: readonly Readonly<ReadinessCheck>[]; }
export class ReadModelService {
  constructor(private readonly store: BackendStore) {}
  getRun(runId: string, readiness: ReadinessCheck[] = []): RunReadModel {
    const state = this.store.snapshot(); const run = state.runs.find(item => item.id === runId); if (!run) throw new Error('RUN_NOT_FOUND');
    const campaign = state.campaigns.find(item => item.id === run.campaignId); if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    return { run, campaign, events: state.events.filter(event => event.runId === runId), attempts: state.attempts.filter(attempt => attempt.runId === runId), receipts: state.receipts.filter(receipt => receipt.runId === runId), reconciliations: state.reconciliations.filter(item => item.runId === runId), readiness };
  }
}
