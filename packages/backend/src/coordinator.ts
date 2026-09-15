import { randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { AttemptRecord, BackendState, Campaign, CampaignState, EngineAdapter, EventRecord, IntentRecord, ReceiptRecord, Reservation, RunRecord, ValidatedCampaign } from './types.js';
import { SpendLedger } from './spend-ledger.js';
import { EvidenceService, liveRequestDigest } from './evidence.js';
import { assertRobinhoodFreePolicy } from './policy.js';
import { rebindExecutionResult, type CanonicalExecutionStore } from './canonical-store.js';

export class ExecutionCoordinator {
  readonly ledger: SpendLedger;
  private readonly evidence: EvidenceService;

  constructor(
    private readonly store: BackendStore,
    private readonly engine: EngineAdapter,
  ) {
    this.ledger = new SpendLedger(store);
    this.evidence = new EvidenceService(store);
  }

  private assertLiveStoreReady(): void { const capabilities = this.store.capabilities(); if (!capabilities.durable) throw new Error('DURABLE_STORE_REQUIRED'); if (!capabilities.atomicAcrossProcesses) throw new Error('ATOMIC_STORE_REQUIRED'); }

  async start(): Promise<void> {
    await this.store.transaction(state => {
      state.runtime = { ...state.runtime, startupState: 'Reconciling', blockingReasons: ['RECONCILIATION_IN_PROGRESS'] };
    });
    await this.reconcile();
    await this.store.transaction(state => {
      const unresolved = state.runs
        .filter(run => ['Armed', 'Active'].includes(run.state) || (run.state === 'Aborted' && state.attempts.some(attempt => attempt.runId === run.id && attempt.hash)))
        .filter(run => {
          const result = state.reconciliations.filter(item => item.runId === run.id).at(-1)?.result;
          const chainId = state.campaigns.find(campaign => campaign.id === run.campaignId)?.chainId;
          const terminal = result === 'failed' || result === 'final' || (result === 'confirmed' && chainId === 1);
          return !terminal;
        });
      state.runtime = unresolved.length === 0
        ? { ...state.runtime, startupState: 'Ready', reconciliationCompletedAt: new Date().toISOString(), blockingReasons: [] }
        : { ...state.runtime, startupState: 'Blocked', reconciliationCompletedAt: new Date().toISOString(), blockingReasons: ['UNRESOLVED_EXECUTIONS'] };
    });
  }

  async arm(input: ValidatedCampaign, mode: 'dry-run' | 'live', idempotencyKey?: string): Promise<RunRecord> {
    const initial = this.store.snapshot();
    const campaign = initial.campaigns.find(item => item.id === input.campaign.id);
    if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
    const canonicalInput: ValidatedCampaign = { ...input, campaign };
    if (mode === 'live' && campaign.dryRun) throw new Error('LIVE_REQUIRES_NON_DRY_CAMPAIGN');
    let simulationIds = input.simulationIds ?? [];
    if (mode === 'live') {
      if (initial.runtime.startupState !== 'Ready') throw new Error('STARTUP_RECONCILIATION_REQUIRED');
      if (!initial.runtime.dependencies.engine || !initial.runtime.dependencies.chain || !initial.runtime.dependencies.backup) throw new Error('DEPLOYMENT_DEPENDENCIES_NOT_READY');
      this.assertLiveStoreReady();
      if (!initial.runtime.operational || initial.runtime.operational.expiresAt <= new Date().toISOString() || !initial.runtime.operational.secretStoreReference || !initial.runtime.operational.storePath || !initial.runtime.operational.signerReady || initial.runtime.operational.killSwitchEngaged || !initial.runtime.operational.notificationReady || initial.runtime.operational.chainVerification !== 'verified') throw new Error('RUNTIME_READINESS_REQUIRED');
      simulationIds = this.evidence.assertLiveEvidence(canonicalInput);
      if (campaign.chainVerification.status !== 'verified' || !campaign.chainVerification.seaDropCompatible) throw new Error('CHAIN_VERIFICATION_REQUIRED');
      if (!campaign.chainVerification.evidenceId || !campaign.chainVerification.checkedAt || campaign.chainVerification.sourceBlock === undefined) throw new Error('CHAIN_VERIFICATION_EVIDENCE_REQUIRED');
      if (campaign.chainId === 4663 && campaign.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
      if (campaign.chainId === 4663 && campaign.feePolicy.kind === 'paid') throw new Error('ROBINHOOD_PAID_MINTS_DISABLED');
      if (campaign.chainId === 1 && campaign.feePolicy.kind === 'paid') {
        if (campaign.broadcastMode !== 'public') throw new Error('PAID_ETHEREUM_PUBLIC_MODE_REQUIRED');
        const fee = campaign.feePolicy.totalFeeBudgetWei;
        if (fee === undefined) throw new Error('PAID_ETHEREUM_CAP_REQUIRED');
        const allInExposure = campaign.mintPriceWei * BigInt(campaign.quantity) + fee;
        if (allInExposure > campaign.spendPolicy.maxRunWei || allInExposure > campaign.spendPolicy.dailyCapWei || fee > campaign.spendPolicy.gasCeilingWei) throw new Error('PAID_ETHEREUM_CAP_REQUIRED');
      }
    }
    const requestDigest = liveRequestDigest(campaign, mode, input.wallets ?? [], simulationIds);
    const existing = idempotencyKey && initial.runs.find(run => run.idempotencyKey === idempotencyKey);
    if (existing) { if (existing.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT'); return existing; }
    const now = new Date().toISOString();
    const run: RunRecord = { id: `run_${randomUUID()}`, intentId: `intent_${randomUUID()}`, campaignId: campaign.id, mode, requestDigest, state: 'Armed', ...(idempotencyKey ? { idempotencyKey } : {}), createdAt: now, updatedAt: now };
    const intent: IntentRecord = { id: run.intentId, runId: run.id, campaignId: campaign.id, campaignSnapshot: structuredClone(campaign), wallets: [...(input.wallets ?? [])], policy: structuredClone(campaign.spendPolicy), feePolicy: structuredClone(campaign.feePolicy), chainVerification: structuredClone(campaign.chainVerification), simulationIds: [...simulationIds], evidenceAt: input.evidenceAt, createdAt: now };
    return this.store.transaction(state => {
      const duplicate = idempotencyKey && state.runs.find(item => item.idempotencyKey === idempotencyKey);
      if (duplicate) { if (duplicate.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT'); return duplicate; }
      state.runs.push(run);
      state.intents.push(intent);
      state.events.push(this.event('run_armed', run.id, { mode, simulationIds, intentId: intent.id }));
      return run;
    });
  }

  async execute(runId: string, wallets: string[]): Promise<unknown> {
    const state = this.store.snapshot();
    if (state.killed) throw new Error('KILLED');
    const run = state.runs.find(item => item.id === runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (state.attempts.some(attempt => attempt.runId === runId) || state.events.some(event => event.runId === runId && event.type === 'execution_facts_recorded')) throw new Error('RUN_ALREADY_EXECUTED');
    if (run.state !== 'Armed') throw new Error('RUN_NOT_ARMED');
    const intent = state.intents.find(item => item.id === run.intentId);
    if (!intent) throw new Error('INTENT_NOT_FOUND');
    const campaign = structuredClone(intent.campaignSnapshot);
    if (run.mode === 'dry-run') return this.executeDryRun(run, campaign, wallets);
    const current = this.store.snapshot();
    if (current.runtime.startupState !== 'Ready') throw new Error('STARTUP_RECONCILIATION_REQUIRED');
    if (!current.runtime.dependencies.engine || !current.runtime.dependencies.chain || !current.runtime.dependencies.backup) throw new Error('DEPLOYMENT_DEPENDENCIES_NOT_READY');
    this.assertLiveStoreReady();
    if (!current.runtime.operational || current.runtime.operational.expiresAt <= new Date().toISOString() || !current.runtime.operational.secretStoreReference || !current.runtime.operational.storePath || !current.runtime.operational.signerReady || current.runtime.operational.killSwitchEngaged || !current.runtime.operational.notificationReady || current.runtime.operational.chainVerification !== 'verified') throw new Error('RUNTIME_READINESS_REQUIRED');
    this.evidence.assertLiveEvidence({ campaign, wallets: intent.wallets, simulationIds: intent.simulationIds, evidenceAt: intent.evidenceAt });
    if (wallets.length !== intent.wallets.length || wallets.some(wallet => !intent.wallets.some(armed => armed.toLowerCase() === wallet.toLowerCase()))) throw new Error('EXECUTION_FLEET_MISMATCH');
    const totalFee = campaign.feePolicy.totalFeeBudgetWei;
    if (totalFee === undefined) throw new Error('TOTAL_FEE_BUDGET_REQUIRED');
    const reservationAmount = campaign.mintPriceWei * BigInt(campaign.quantity) + totalFee;
    if (campaign.chainId === 4663) assertRobinhoodFreePolicy(campaign.spendPolicy.gasCeilingWei, campaign.spendPolicy.dailyCapWei, reservationAmount);
    const canonical = this.canonicalStore();
    let reservations: Reservation[];
    let prepared: Awaited<ReturnType<CanonicalExecutionStore['admitExecution']>>['executions'] = [];
    if (canonical) {
      const admission = await canonical.admitExecution({ run, intent, campaign, wallets });
      reservations = admission.reservations;
      prepared = admission.executions;
    } else {
      reservations = await this.ledger.reserveBatch(runId, campaign.id, wallets, reservationAmount, campaign.spendPolicy.maxRunWei, campaign.chainId, campaign.spendPolicy.dailyCapWei, current => {
        if (current.killed) throw new Error('KILLED');
        const currentRun = current.runs.find(item => item.id === runId);
        if (!currentRun || currentRun.state !== 'Armed') throw new Error('RUN_NOT_ARMED');
        this.transition(currentRun, 'Active');
        current.events.push(this.event('admission', runId, { reservationCount: wallets.length }));
      });
    }
    if (this.store.snapshot().killed) {
      if (canonical) await canonical.abortRemaining('KILLED');
      else {
        for (const reservation of reservations) await this.ledger.release(reservation.id);
        await this.store.transaction(latest => {
          const active = latest.runs.find(item => item.id === runId);
          if (active?.state === 'Active') this.transition(active, 'Aborted');
          latest.events.push(this.event('admission_cancelled', runId, { reason: 'KILLED' }));
        });
      }
      throw new Error('KILLED');
    }
    let result;
    try {
      result = await this.engine.execute({ runId, intentId: run.intentId, campaign, wallets: intent.wallets, reservationIds: reservations.map(item => item.id) });
    } catch (error) {
      if (canonical && this.store.snapshot().killed) await canonical.abortRemaining('KILLED');
      else await this.store.transaction(latest => { latest.events.push(this.event('execution_outcome_unknown', runId, { reason: 'ENGINE_ERROR' })); });
      throw error;
    }
    result = rebindExecutionResult(result, prepared);
    this.assertEngineFacts(runId, campaign.chainId, result.executionIds, result.attempts, result.receipts);
    const killedAfterExecution = this.store.snapshot().killed;
    await this.store.transaction(after => {
      after.attempts.push(...result.attempts);
      after.receipts.push(...result.receipts);
      after.events.push(this.event('execution_facts_recorded', runId, { executionCount: result.executionIds.length }));
      const persistedRun = after.runs.find(item => item.id === runId);
      if (persistedRun && killedAfterExecution && persistedRun.state === 'Active') this.transition(persistedRun, 'Aborted');
      else if (persistedRun && result.state === 'Failed') this.transition(persistedRun, 'Failed');
      else if (persistedRun && result.state === 'Aborted' && persistedRun.state === 'Active') this.transition(persistedRun, 'Aborted');
      else if (persistedRun && result.state === 'Confirmed' && campaign.chainId === 1) this.transition(persistedRun, 'Completed');
      this.applyAccountingToState(after, campaign, runId, result.attempts, result.receipts);
    });
    if (canonical && killedAfterExecution) await canonical.abortRemaining('KILLED');
    return result;
  }

  async kill(reason: string): Promise<void> {
    await this.store.transaction(state => {
      state.killed = true;
      state.killReason = reason;
      state.runtime = { ...state.runtime, startupState: 'Blocked', blockingReasons: [...new Set([...state.runtime.blockingReasons, 'KILLED'])] };
      state.events.push(this.event('kill', undefined, { reason }));
    });
    const canonical = this.canonicalStore();
    if (canonical) await canonical.abortRemaining(reason);
    else await this.store.transaction(state => {
      for (const run of state.runs.filter(item => ['Armed', 'Active'].includes(item.state))) this.transition(run, 'Aborted');
    });
  }

  async reconcile(): Promise<void> {
    const snapshot = this.store.snapshot();
    const candidates = snapshot.runs.filter(run => ['Armed', 'Active', 'Completed'].includes(run.state) || (run.state === 'Aborted' && snapshot.attempts.some(attempt => attempt.runId === run.id && attempt.hash)));
    for (const candidate of candidates) {
      const snapshot = this.store.snapshot();
      const run = snapshot.runs.find(item => item.id === candidate.id);
      const intent = run && snapshot.intents.find(item => item.id === run.intentId);
      if (!run || !intent) throw new Error('INTENT_NOT_FOUND');
      const update = await this.engine.reconcile(run);
      const executionIds = [...new Set([...update.attempts.map(item => item.executionId), ...update.receipts.map(item => item.executionId)])];
      this.assertEngineFacts(run.id, intent.campaignSnapshot.chainId, executionIds, update.attempts, update.receipts, true);
      this.assertReconciliationCoherence(run.id, intent.campaignSnapshot.chainId, update.result, snapshot.attempts.filter(item => item.runId === run.id), update.attempts, update.receipts);
      await this.store.transaction(state => {
        const currentRun = state.runs.find(item => item.id === run.id);
        if (!currentRun) throw new Error('RUN_NOT_FOUND');
        state.attempts.push(...update.attempts.filter(item => !state.attempts.some(existing => existing.id === item.id)));
        state.receipts.push(...update.receipts.filter(item => !state.receipts.some(existing => existing.id === item.id)));
        state.reconciliations.push({ id: `rec_${randomUUID()}`, runId: run.id, result: update.result, observedAt: new Date().toISOString(), ...(update.reason ? { reason: update.reason } : {}) });
         if (currentRun.state === 'Aborted') {
           // A kill aborts new admissions but never erases submitted facts.
         } else if ((update.result === 'confirmed' && intent.campaignSnapshot.chainId === 1) || update.result === 'final') {
          if (currentRun.state === 'Armed') this.transition(currentRun, 'Active');
          if (currentRun.state === 'Active') this.transition(currentRun, 'Completed');
        } else if (update.result === 'soft' || update.result === 'posted') {
          if (currentRun.state === 'Armed') this.transition(currentRun, 'Active');
        } else if ((update.result === 'failed' || update.result === 'reorged') && currentRun.state !== 'Failed') {
          this.transition(currentRun, 'Failed');
        }
        this.applyAccountingToState(state, intent.campaignSnapshot, run.id, update.attempts, update.receipts);
      });
    }
  }

  private async executeDryRun(run: RunRecord, campaign: Campaign, wallets: readonly string[]): Promise<unknown> {
    const result = await this.engine.prepare({ runId: run.id, intentId: run.intentId, campaign, wallets });
    if (result.state !== 'Prepared' || result.receipts.length > 0 || result.attempts.some(attempt => attempt.hash !== undefined || !['Prepared', 'Failed'].includes(attempt.state))) throw new Error('DRY_RUN_SIDE_EFFECT_DETECTED');
    await this.store.transaction(state => {
      const current = state.runs.find(item => item.id === run.id);
      if (current) { this.transition(current, 'Active'); this.transition(current, 'Completed'); }
      state.events.push(this.event('dry_run_completed', run.id, { executionCount: result.executionIds.length }));
    });
    return result;
  }

  private applyAccountingToState(state: BackendState, campaign: Campaign, runId: string, attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[]): void {
    for (const reservation of state.reservations.filter(item => item.runId === runId && item.status !== 'released')) {
      const walletAttempts = attempts.filter(attempt => attempt.wallet.toLowerCase() === reservation.wallet.toLowerCase());
      const confirmed = walletAttempts.find(attempt => attempt.state === 'Confirmed' && (campaign.chainId === 1 || attempt.robinhoodFinality === 'final'));
      const receipt = confirmed && receipts.find(item => item.executionId === confirmed.executionId);
      const failedReceipt = receipts.find(item => item.state === 'Failed' && walletAttempts.some(attempt => attempt.executionId === item.executionId));
      const reorgReceipt = receipts.find(item => item.state === 'Reorged' && walletAttempts.some(attempt => attempt.executionId === item.executionId));
      if (receipt || failedReceipt) this.setReservation(reservation, 'settled', (receipt ?? failedReceipt)!.actualSpendWei);
      else if (reorgReceipt) this.setReservation(reservation, 'reorged', reorgReceipt.actualSpendWei);
      else if (walletAttempts.length > 0 && walletAttempts.every(attempt => attempt.state === 'Failed' && !attempt.hash)) this.setReservation(reservation, 'released');
    }
  }

  private setReservation(reservation: Reservation, status: Reservation['status'], actualAmountWei?: bigint): void {
    if (reservation.status === 'settled') return;
    if (actualAmountWei !== undefined && (actualAmountWei < 0n || actualAmountWei > reservation.amountWei)) throw new Error('INVALID_SETTLEMENT_AMOUNT');
    if (reservation.status === 'released') throw new Error('INVALID_RESERVATION_TRANSITION');
    reservation.status = status; reservation.updatedAt = new Date().toISOString(); if (actualAmountWei !== undefined) reservation.actualAmountWei = actualAmountWei;
  }

  private transition(run: RunRecord, next: CampaignState): void {
    const allowed: Partial<Record<CampaignState, CampaignState[]>> = { Armed: ['Active', 'Aborted', 'Failed'], Active: ['Completed', 'Failed', 'Aborted'], Completed: ['Failed'] };
    if (run.state !== next && !allowed[run.state]?.includes(next)) throw new Error(`INVALID_RUN_TRANSITION:${run.state}->${next}`);
    run.state = next;
    run.updatedAt = new Date().toISOString();
  }

  private assertEngineFacts(runId: string, chainId: 1 | 4663, executionIds: readonly string[], attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[], allowUnfinalizedRobinhood = false): void {
    if (new Set(executionIds).size !== executionIds.length) throw new Error('DUPLICATE_EXECUTION_ID');
    if (attempts.some(item => item.runId !== runId || !executionIds.includes(item.executionId)) || receipts.some(item => item.runId !== runId || !executionIds.includes(item.executionId))) throw new Error('INVALID_ENGINE_EXECUTION_FACTS');
    if (new Set(attempts.map(item => item.id)).size !== attempts.length || new Set(receipts.map(item => item.id)).size !== receipts.length) throw new Error('DUPLICATE_ENGINE_FACT_ID');
    if (receipts.some(receipt => !['Confirmed', 'Reorged', 'Failed'].includes(receipt.state) || receipt.blockNumber === undefined || !receipt.blockHash || receipt.actualSpendWei === undefined || receipt.actualSpendWei < 0n)) throw new Error('INVALID_RECEIPT_FACT');
    if (chainId === 4663 && !allowUnfinalizedRobinhood && receipts.some(receipt => !receipt.robinhoodFinality)) throw new Error('ROBINHOOD_FINALITY_REQUIRED');
  }

  private assertReconciliationCoherence(runId: string, chainId: 1 | 4663, result: string, existingAttempts: readonly AttemptRecord[], attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[]): void {
    const expected = [...new Set(existingAttempts.map(item => item.executionId))];
    if (['confirmed', 'final', 'reorged'].includes(result)) {
      if (expected.length === 0) throw new Error('TERMINAL_RECONCILIATION_FACTS_REQUIRED');
      if (expected.some(id => !receipts.some(receipt => receipt.executionId === id))) throw new Error('INCOMPLETE_TERMINAL_RECEIPTS');
    }
    if (result === 'final' && (chainId !== 4663 || receipts.some(receipt => receipt.state !== 'Confirmed' || receipt.robinhoodFinality !== 'final'))) throw new Error('INVALID_FINALITY_COHERENCE');
    if (result === 'confirmed' && (chainId !== 1 || receipts.some(receipt => receipt.state !== 'Confirmed'))) throw new Error('INVALID_FINALITY_COHERENCE');
    if (result === 'reorged' && receipts.some(receipt => receipt.state !== 'Reorged')) throw new Error('INVALID_REORG_COHERENCE');
    if (result === 'failed' && attempts.length === 0 && receipts.length === 0) throw new Error('FAILED_RECONCILIATION_FACTS_REQUIRED');
    if (attempts.some(item => item.runId !== runId)) throw new Error('INVALID_ENGINE_EXECUTION_FACTS');
  }

  private event(type: string, runId: string | undefined, data: Record<string, unknown>): EventRecord {
    return { id: `evt_${randomUUID()}`, ...(runId ? { runId } : {}), type, at: new Date().toISOString(), data };
  }

  private canonicalStore(): CanonicalExecutionStore | undefined {
    const candidate = this.store as Partial<CanonicalExecutionStore>;
    return typeof candidate.admitExecution === 'function' && typeof candidate.abortRemaining === 'function' ? candidate as CanonicalExecutionStore : undefined;
  }
}

export type { Campaign };
