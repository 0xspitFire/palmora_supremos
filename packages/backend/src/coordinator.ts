import { randomUUID } from 'node:crypto';
import type { DurableStore } from './store.js';
import type { Campaign, CampaignState, EngineAdapter, EventRecord, IntentRecord, ReceiptRecord, ReconciliationRecord, RunRecord, ValidatedCampaign } from './types.js';
import { SpendLedger } from './spend-ledger.js';
export class ExecutionCoordinator {
  readonly ledger: SpendLedger;
  constructor(private readonly store: DurableStore, private readonly engine: EngineAdapter) { this.ledger = new SpendLedger(store); }
  async arm(input: ValidatedCampaign, mode: 'dry-run' | 'live', idempotencyKey?: string): Promise<RunRecord> {
    if (mode === 'live' && input.campaign.dryRun) throw new Error('LIVE_REQUIRES_NON_DRY_CAMPAIGN');
    if (mode === 'live' && (input.campaign.chainVerification.status !== 'verified' || !input.campaign.chainVerification.seaDropCompatible)) throw new Error('CHAIN_VERIFICATION_REQUIRED');
    if (mode === 'live' && (!input.campaign.chainVerification.evidenceId || !input.campaign.chainVerification.checkedAt || input.campaign.chainVerification.sourceBlock === undefined)) throw new Error('CHAIN_VERIFICATION_EVIDENCE_REQUIRED');
    if (mode === 'live' && input.campaign.chainId === 4663 && input.campaign.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
    if (mode === 'live' && input.campaign.feePolicy.kind === 'paid') throw new Error('PAID_MINT_POLICY_REQUIRED');
    if (mode === 'live' && !input.simulationId) throw new Error('SIMULATION_REQUIRED');
    const state = this.store.snapshot(); const existing = idempotencyKey && state.runs.find(r => r.idempotencyKey === idempotencyKey); if (existing) return existing;
    const now = new Date().toISOString(); const run: RunRecord = { id: `run_${randomUUID()}`, intentId: `intent_${randomUUID()}`, campaignId: input.campaign.id, state: 'Armed', ...(idempotencyKey ? { idempotencyKey } : {}), createdAt: now, updatedAt: now };
    const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: input.campaign.id, policy: structuredClone(input.campaign.spendPolicy), feePolicy: structuredClone(input.campaign.feePolicy), chainVerification: structuredClone(input.campaign.chainVerification), simulationId: input.simulationId, evidenceAt: input.evidenceAt, createdAt: now };
    state.runs.push(run); state.intents.push(intent); state.events.push(this.event('run_armed', run.id, { mode, simulationId: input.simulationId, intentId: intent.id })); this.store.replace(state); await this.store.commit(); return run;
  }
  async execute(runId: string, wallets: string[]): Promise<unknown> {
    if (this.store.snapshot().killed) throw new Error('KILLED'); const state = this.store.snapshot(); const run = state.runs.find(r => r.id === runId); if (!run) throw new Error('RUN_NOT_FOUND');
    if (state.attempts.some(attempt => attempt.runId === runId) || state.events.some(event => event.runId === runId && event.type === 'execution_facts_recorded')) throw new Error('RUN_ALREADY_EXECUTED');
    if (run.state !== 'Armed') throw new Error('RUN_NOT_ARMED');
    const campaign = state.campaigns.find(c => c.id === run.campaignId); if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    const totalFee = campaign.feePolicy.totalFeeBudgetWei; if (totalFee === undefined) throw new Error('TOTAL_FEE_BUDGET_REQUIRED');
    const reservationAmount = campaign.mintPriceWei * BigInt(campaign.quantity) + totalFee;
    const reservations = []; for (const wallet of wallets) { if (this.store.snapshot().killed) { run.state = 'Aborted'; break; } reservations.push(await this.ledger.reserve(runId, campaign.id, wallet, reservationAmount, campaign.spendPolicy.maxRunWei, campaign.chainId, campaign.spendPolicy.dailyCapWei)); }
    const current = this.store.snapshot(); const currentRun = current.runs.find(item => item.id === runId); if (currentRun) { if (run.state === 'Aborted') currentRun.state = 'Aborted'; else this.transition(currentRun, 'Active'); }
    current.events.push(this.event('admission', runId, { reservationCount: reservations.length })); this.store.replace(current); await this.store.commit();
    if (run.state === 'Aborted') return { run, reservations };
    const result = await this.engine.execute({ runId, intentId: run.intentId, campaign, reservationIds: reservations.map(r => r.id) });
    if (result.attempts.some(attempt => attempt.runId !== runId || !result.executionIds.includes(attempt.executionId))) throw new Error('INVALID_ENGINE_EXECUTION_FACTS');
    const after = this.store.snapshot(); after.attempts.push(...result.attempts); for (const attempt of result.attempts) after.receipts.push({ id: `receipt_${randomUUID()}`, executionId: attempt.executionId, runId, state: attempt.state, robinhoodFinality: attempt.robinhoodFinality, observedAt: new Date().toISOString() } satisfies ReceiptRecord); after.events.push(this.event('execution_facts_recorded', runId, { executionCount: result.executionIds.length })); this.store.replace(after); await this.store.commit(); return result;
  }
  kill(reason: string): Promise<void> { const state = this.store.snapshot(); state.killed = true; state.killReason = reason; state.events.push(this.event('kill', undefined, { reason })); this.store.replace(state); return this.store.commit(); }
  async reconcile(): Promise<void> { const state = this.store.snapshot(); for (const run of state.runs.filter(r => ['Armed', 'Active'].includes(r.state))) { const result = await this.engine.reconcile(run); state.reconciliations.push({ id: `rec_${randomUUID()}`, runId: run.id, result, observedAt: new Date().toISOString() } satisfies ReconciliationRecord); if ((result === 'confirmed' || result === 'final') && run.state === 'Armed') { this.transition(run, 'Active'); this.transition(run, 'Completed'); } else if (result === 'confirmed' || result === 'final') this.transition(run, 'Completed'); else if (result === 'soft' || result === 'posted') { if (run.state === 'Armed') this.transition(run, 'Active'); } else if (result === 'failed' || result === 'reorged') this.transition(run, 'Failed'); } this.store.replace(state); await this.store.commit(); }
  private transition(run: RunRecord, next: CampaignState): void { const allowed: Partial<Record<CampaignState, CampaignState[]>> = { Armed: ['Active', 'Aborted', 'Failed'], Active: ['Completed', 'Failed', 'Aborted'] }; if (run.state !== next && !allowed[run.state]?.includes(next)) throw new Error(`INVALID_RUN_TRANSITION:${run.state}->${next}`); run.state = next; run.updatedAt = new Date().toISOString(); }
  private event(type: string, runId: string | undefined, data: Record<string, unknown>): EventRecord { return { id: `evt_${randomUUID()}`, ...(runId ? { runId } : {}), type, at: new Date().toISOString(), data }; }
}
export type { Campaign };
