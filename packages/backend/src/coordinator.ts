import { randomUUID } from 'node:crypto';
import type { BackendStore } from './store.js';
import type { AttemptRecord, BackendState, Campaign, CampaignState, EngineAdapter, EventRecord, ExecutionResult, IntentRecord, ReceiptRecord, Reservation, RunRecord, ValidatedCampaign } from './types.js';
import { SpendLedger } from './spend-ledger.js';
import { EvidenceService, liveRequestDigest } from './evidence.js';
import { rebindExecutionResult, type CanonicalExecutionStore } from './canonical-store.js';
import { assertRobinhoodLiveAllowed } from './robinhood-enablement.js';
import { assertBaseLiveAllowed } from './base-enablement.js';
import { assertLiveOperationalReadiness, type CustodyPolicyBinding } from './custody.js';
import type { CompensatingAssuranceConfig } from './compensating-controls.js';

const resolveAssurance = (option: CoordinatorAssuranceOption, run: AssuranceRun): CompensatingAssuranceConfig | undefined => (option === undefined ? undefined : typeof option === 'function' ? option(run) : option);
/** What the arm gate knows about the run being armed or executed. The campaign is the stored one, never the caller's copy. */
export interface AssuranceRun { chainId: number; wallets: readonly string[]; campaign: Campaign }
type CoordinatorAssuranceOption = CompensatingAssuranceConfig | ((run: AssuranceRun) => CompensatingAssuranceConfig) | undefined;

export function receiptAuthorizesSettlement(chainId: 1 | 8453 | 4663, receipt: Pick<ReceiptRecord, 'state' | 'finalityStage' | 'robinhoodFinality'>): boolean {
  if (receipt.state !== 'Confirmed' && receipt.state !== 'Failed') return false;
  if (chainId === 1) return true;
  if (receipt.finalityStage !== 'ethereum_final') return false;
  return chainId !== 4663 || receipt.robinhoodFinality === 'final';
}

/** A pending aggregate may contain a terminal failure in another wallet. */
export function partialFleetFailurePending(result: Pick<ExecutionResult, 'state' | 'attempts' | 'receipts'>): boolean {
  return result.state === 'Pending' && (result.attempts.some((attempt) => attempt.state === 'Failed') || result.receipts.some((receipt) => receipt.state === 'Failed'));
}

export class ExecutionCoordinator {
  readonly ledger: SpendLedger;
  private readonly evidence: EvidenceService;

  constructor(
    private readonly store: BackendStore,
    private readonly engine: EngineAdapter,
    private readonly options: { expectedCustodyPolicy?: CustodyPolicyBinding | ((run: AssuranceRun) => CustodyPolicyBinding); /** Set only by the owner's CLI (D-043); the service never sets it, so unattended runs still need Turnkey or a cloud key service. */ acceptPersonalLiveLocalCustody?: boolean; /** D-058/D-059: set by the service configuration to accept `turnkey-compensating-controls` evidence; absent means that evidence kind is refused. */ compensatingAssurance?: CompensatingAssuranceConfig | ((run: AssuranceRun) => CompensatingAssuranceConfig); /** T-042 requirement 2: awaited before every live arm and execute so readiness is observed in-process just now, never read from an earlier observation. A failure refuses the run (fail closed). */ refreshReadiness?: (run: AssuranceRun) => Promise<void>; /** D-059: when set, a live run cannot arm or execute unless the independent wallet watcher covers every armed wallet and is alive. */ walletWatch?: { covers(chainId: number, wallets: readonly string[]): boolean; isHealthy(at?: Date): boolean }; alerts?: { cap(reason: string, runId?: string): Promise<void>; failed?(reason: string, runId?: string): Promise<void>; confirmed?(runId: string, facts: { chainId: number; collection: string; wallet?: string; quantity?: number; hash: string; feePaid?: string }): Promise<void>; mintFailed?(runId: string, facts: { chainId: number; collection: string; wallet?: string; quantity?: number; hash: string; feePaid?: string }, reason?: string): Promise<void> } } = {},
  ) {
    // T-044 security re-review (D1): the compensated profile counts on the watcher to see what the other checks cannot, so
    // configuring one without the other is a start-up error, not a silently weaker arm gate.
    if (options.compensatingAssurance !== undefined && !options.walletWatch) throw new Error('COMPENSATING_ASSURANCE_REQUIRES_WALLET_WATCH');
    this.ledger = new SpendLedger(store);
    this.evidence = new EvidenceService(store);
  }

  private assuranceContext(campaign: Campaign, wallets: readonly string[]): { config: CompensatingAssuranceConfig; chainId: number; wallets: readonly string[] } | undefined {
    const chainId = campaign.chainId;
    const config = resolveAssurance(this.options.compensatingAssurance, { chainId, wallets, campaign });
    // A per-run function must supply the funding envelope and the minimum balance for EVERY wallet in this run; without them the funding
    // arrival (D-059 item 3, D-060) would silently not be enforced.
    if (config && typeof this.options.compensatingAssurance === 'function' && !wallets.every(wallet => config.runEnvelopeWei?.[wallet.toLowerCase()] !== undefined && config.minimumBalanceWei?.[wallet.toLowerCase()] !== undefined)) throw new Error('COMPENSATING_ASSURANCE_FUNDING_MISSING');
    return config ? { config, chainId, wallets } : undefined;
  }

  private expectedCustodyPolicy(campaign: Campaign, wallets: readonly string[]): CustodyPolicyBinding | undefined {
    const expected = this.options.expectedCustodyPolicy;
    return typeof expected === 'function' ? expected({ chainId: campaign.chainId, wallets, campaign }) : expected;
  }

  /** Fresh readiness for a live arm or execute. Without the hook the stored observation is used as before. */
  private async refreshReadiness(campaign: Campaign, wallets: readonly string[]): Promise<boolean> {
    const refresh = this.options.refreshReadiness;
    if (!refresh) return false;
    try { await refresh({ chainId: campaign.chainId, wallets, campaign }); } catch (error) {
      // Only a fixed, upper-case code may be shown (so the operator sees which check failed); free text from a provider never is.
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}(?::[A-Z0-9_]{1,80})?$/.test(error.message) ? error.message : undefined;
      throw new Error(code ? `READINESS_REFRESH_FAILED:${code}` : 'READINESS_REFRESH_FAILED');
    }
    return true;
  }

  /** D-059 item 6: an unwatched wallet, or a watcher that has gone quiet, cannot be armed or executed. Absent option = no change in behaviour. */
  private assertWalletWatch(chainId: number, wallets: readonly string[]): void {
    const watch = this.options.walletWatch;
    if (!watch) return;
    if (!watch.covers(chainId, wallets)) throw new Error('FLEET_WATCH_NOT_COVERING_WALLETS');
    if (!watch.isHealthy(new Date())) throw new Error('FLEET_WATCH_NOT_HEALTHY');
  }

  private assertLiveStoreReady(): void { const capabilities = this.store.capabilities(); if (!capabilities.durable) throw new Error('DURABLE_STORE_REQUIRED'); if (!capabilities.atomicAcrossProcesses) throw new Error('ATOMIC_STORE_REQUIRED'); }

  async start(): Promise<void> {
    await this.store.transaction(state => {
      state.runtime = { ...state.runtime, startupState: 'Reconciling', blockingReasons: ['RECONCILIATION_IN_PROGRESS'] };
    });
    // A host crash can land after a live request arms its run but before execute admits or signs anything. Only this
    // request-owned shape is auto-closed, and the canonical store must prove there is no attempt of any kind.
    for (const run of this.store.snapshot().runs.filter(item => item.state === 'Armed' && item.mode === 'live' && item.idempotencyKey?.startsWith('live-request:'))) {
      await this.closeUnsentRun(run.id, 'STARTUP_UNSENT_LIVE_REQUEST');
    }
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
    // Campaign history is immutable. A Turnkey campaign created before exact
    // signed-record binding existed must be recreated; a policy reference alone
    // is never treated as a wildcard during live admission.
    if (mode === 'live' && campaign.custodyPolicy?.provider === 'turnkey' && !/^sha256:[0-9a-f]{64}$/.test(campaign.custodyPolicy.recordDigest ?? '')) throw new Error('TURNKEY_CAMPAIGN_POLICY_BINDING_REQUIRED');
    let simulationIds = input.simulationIds ?? [];
    if (mode === 'live') {
      if (initial.runtime.startupState !== 'Ready') throw new Error('STARTUP_RECONCILIATION_REQUIRED');
      if (!initial.runtime.dependencies.engine || !initial.runtime.dependencies.chain || !initial.runtime.dependencies.backup) throw new Error('DEPLOYMENT_DEPENDENCIES_NOT_READY');
      this.assertLiveStoreReady();
      const readiness = (await this.refreshReadiness(campaign, input.wallets ?? [])) ? this.store.snapshot() : initial;
      // The refresh can take seconds; a kill set meanwhile must still stop this arm.
      if (readiness.killed) throw new Error('KILLED');
      if (!readiness.runtime.operational?.secretStoreReference || !readiness.runtime.operational.storePath) throw new Error('RUNTIME_READINESS_REQUIRED');
      assertLiveOperationalReadiness(readiness.runtime.operational, new Date(), this.expectedCustodyPolicy(campaign, input.wallets ?? []), this.options.acceptPersonalLiveLocalCustody ? { chainId: campaign.chainId, wallets: input.wallets ?? [] } : undefined, this.assuranceContext(campaign, input.wallets ?? []));
      this.assertWalletWatch(campaign.chainId, input.wallets ?? []);
      simulationIds = this.evidence.assertLiveEvidence(canonicalInput);
      if (campaign.chainVerification.status !== 'verified' || !campaign.chainVerification.seaDropCompatible) throw new Error('CHAIN_VERIFICATION_REQUIRED');
      if (!campaign.chainVerification.evidenceId || !campaign.chainVerification.checkedAt || campaign.chainVerification.sourceBlock === undefined) throw new Error('CHAIN_VERIFICATION_EVIDENCE_REQUIRED');
      if (campaign.chainId === 4663 && campaign.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
      if (campaign.chainId === 4663 && campaign.feePolicy.kind === 'paid') assertRobinhoodLiveAllowed('paid', this.robinhoodEnablement(), new Date());
      if (campaign.chainId === 8453) {
        if (campaign.broadcastMode !== 'public') throw new Error('BASE_SINGLE_PRIMARY_RPC_REQUIRED');
        if (campaign.quantity > 4) throw new Error('BASE_QUANTITY_LIMIT_EXCEEDED');
        if ((input.wallets ?? []).length > 6) throw new Error('BASE_FLEET_LIMIT_EXCEEDED');
        assertBaseLiveAllowed(campaign.feePolicy.kind, this.baseEnablement(), new Date());
      }
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
    const readiness = (await this.refreshReadiness(campaign, intent.wallets)) ? this.store.snapshot() : current;
    if (readiness.killed) throw new Error('KILLED');
    if (!readiness.runtime.operational?.secretStoreReference || !readiness.runtime.operational.storePath) throw new Error('RUNTIME_READINESS_REQUIRED');
    assertLiveOperationalReadiness(readiness.runtime.operational, new Date(), this.expectedCustodyPolicy(campaign, intent.wallets), this.options.acceptPersonalLiveLocalCustody ? { chainId: campaign.chainId, wallets: intent.wallets } : undefined, this.assuranceContext(campaign, intent.wallets));
    this.assertWalletWatch(campaign.chainId, intent.wallets);
    this.evidence.assertLiveEvidence({ campaign, wallets: intent.wallets, simulationIds: intent.simulationIds, evidenceAt: intent.evidenceAt });
    if (wallets.length !== intent.wallets.length || wallets.some(wallet => !intent.wallets.some(armed => armed.toLowerCase() === wallet.toLowerCase()))) throw new Error('EXECUTION_FLEET_MISMATCH');
    if (campaign.chainId === 4663) {
      assertRobinhoodLiveAllowed('free', this.robinhoodEnablement(), new Date());
      if (campaign.feePolicy.kind === 'paid') assertRobinhoodLiveAllowed('paid', this.robinhoodEnablement(), new Date());
    }
    if (campaign.chainId === 8453) assertBaseLiveAllowed(campaign.feePolicy.kind, this.baseEnablement(), new Date());
    const totalFee = campaign.feePolicy.totalFeeBudgetWei;
    if (totalFee === undefined) throw new Error('TOTAL_FEE_BUDGET_REQUIRED');
    const reservationAmount = campaign.mintPriceWei * BigInt(campaign.quantity) + totalFee;
    const canonical = this.canonicalStore();
    // Fleet spend limits (D-032/D-033) live only in canonical admission, so live spend must go through it.
    if (!canonical) throw new Error('CANONICAL_STORE_REQUIRED_FOR_LIVE');
    let reservations: Reservation[];
    let prepared: Awaited<ReturnType<CanonicalExecutionStore['admitExecution']>>['executions'] = [];
    let notices: readonly string[] = [];
    if (canonical) {
      try {
        const admission = await canonical.admitExecution({ run, intent, campaign, wallets });
        reservations = admission.reservations;
        prepared = admission.executions;
        notices = admission.notices ?? [];
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === 'STALE_PENDING_RESERVATION_REQUIRES_RECONCILIATION' || reason === 'ADMISSION_CLOCK_ROLLBACK') {
          await this.raiseAdmissionBlock(runId, reason);
        }
        throw error;
      }
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
      await this.raiseFleetNotices(runId, notices);
      throw error;
    }
    await this.raiseFleetNotices(runId, notices);
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
    // A mixed fleet can have one wallet fail before broadcast while another
    // remains pending. The aggregate must remain Pending so reconciliation
    // continues, but that must not make the already-known failure silent.
    if (partialFleetFailurePending(result)) await this.raiseExecutionNotice(runId, 'PARTIAL_FLEET_FAILURE_PENDING');
    if (canonical && killedAfterExecution) await canonical.abortRemaining('KILLED');
    return result;
  }

  /** Records and alerts fleet notices after the engine has run, so an alert never delays or changes execution. */
  private async raiseFleetNotices(runId: string, notices: readonly string[]): Promise<void> {
    for (const notice of notices) {
      try {
        await this.store.transaction(state => { state.events.push(this.event('fleet_spend_notice', runId, { notice })); });
        await this.options.alerts?.cap(notice, runId);
      } catch { /* notice persistence and delivery never block, prove, or alter execution */ }
    }
  }

  private async raiseAdmissionBlock(runId: string, reason: string): Promise<void> {
    try { await this.store.transaction(state => { state.events.push(this.event('admission_blocked', runId, { reason })); }); }
    catch { /* event persistence cannot replace the fail-closed admission error */ }
    try { await this.options.alerts?.cap(reason, runId); }
    catch { /* alert delivery cannot replace the fail-closed admission error */ }
  }

  private async raiseExecutionNotice(runId: string, reason: string): Promise<void> {
    try { await this.store.transaction(state => { state.events.push(this.event('execution_notice', runId, { reason })); }); }
    catch { /* a notice cannot alter execution truth */ }
    try { await this.options.alerts?.failed?.(reason, runId); }
    catch { /* notification delivery cannot alter execution truth */ }
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

  /**
   * D-074: after a live request failed, closes that one run if nothing of it can have been sent (the store decides, and any doubt
   * leaves the run for reconciliation). It is not the kill switch and never touches another run.
   */
  async closeUnsentRun(runId: string, reason: string): Promise<'closed' | 'left' | 'absent'> {
    const canonical = this.canonicalStore();
    if (!canonical?.abortRunIfUnsent) return 'absent';
    const outcome = await canonical.abortRunIfUnsent(runId, reason);
    if (outcome === 'closed') await this.store.transaction(state => { state.events.push(this.event('run_closed_unsent', runId, { reason })); });
    return outcome;
  }

  private reconcilePass?: Promise<void>;

  /**
   * One reconcile pass at a time, shared by every caller (the service timer and the owner's `/reconcile`): a call that arrives while a
   * pass is running waits for that pass instead of starting a second one, so the same receipts are never written or accounted twice.
   */
  async reconcile(): Promise<void> {
    if (this.reconcilePass) return this.reconcilePass;
    const pass = this.reconcileOnce().finally(() => { if (this.reconcilePass === pass) this.reconcilePass = undefined; });
    this.reconcilePass = pass;
    return pass;
  }

  private async reconcileOnce(): Promise<void> {
    const snapshot = this.store.snapshot();
    // D-072: a completed run whose latest reconciliation is already final cannot change any more, so it is not read again every pass.
    const settledFinal = (runId: string): boolean => snapshot.reconciliations.filter(item => item.runId === runId).at(-1)?.result === 'final';
    const hasUnreportedRobinhoodFinality = (run: RunRecord): boolean => {
      const intent = snapshot.intents.find(item => item.runId === run.id);
      if (intent?.campaignSnapshot.chainId !== 4663 || (!this.options.alerts?.confirmed && !this.options.alerts?.mintFailed)) return false;
      return snapshot.receipts.some(receipt => receipt.runId === run.id && receipt.finalityStage === 'ethereum_final' && receipt.robinhoodFinality === 'final' && (receipt.state === 'Confirmed' || receipt.state === 'Failed') && !snapshot.events.some(event => event.type === 'robinhood_finality_reported' && event.runId === run.id && event.data.receiptId === receipt.id));
    };
    const candidates = snapshot.runs.filter(run => (['Armed', 'Active'].includes(run.state) || (run.state === 'Completed' && !settledFinal(run.id))) || (run.state === 'Aborted' && snapshot.attempts.some(attempt => attempt.runId === run.id && attempt.hash)) || hasUnreportedRobinhoodFinality(run));
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
         const reconciliationAttemptId = update.receipts.find(item => item.transactionAttemptId)?.transactionAttemptId ?? update.attempts[0]?.id ?? snapshot.attempts.find(item => item.runId === run.id && item.hash)?.id;
         state.reconciliations.push({ id: `rec_${randomUUID()}`, runId: run.id, result: update.result, observedAt: new Date().toISOString(), ...(reconciliationAttemptId ? { attemptId: reconciliationAttemptId } : {}), ...(update.reason ? { reason: update.reason } : {}) });
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
      // Robinhood has staged finality. Tell the owner only after reconciliation
      // proves Ethereum finality; an alert failure never changes chain truth.
      if (intent.campaignSnapshot.chainId === 4663) {
        const latest = this.store.snapshot();
        const attempts = latest.attempts.filter(item => item.runId === run.id);
        for (const receipt of latest.receipts.filter(item => item.runId === run.id && item.finalityStage === 'ethereum_final' && item.robinhoodFinality === 'final' && (item.state === 'Confirmed' || item.state === 'Failed') && !latest.events.some(event => event.type === 'robinhood_finality_reported' && event.runId === run.id && event.data.receiptId === item.id))) {
          // A replacement may share the execution id. Finality belongs to the
          // exact transaction-attempt id named by the authoritative receipt.
          const attempt = receipt.transactionAttemptId ? attempts.find(item => item.id === receipt.transactionAttemptId && item.hash) : undefined;
          if (!attempt?.hash) continue;
          const facts = { chainId: 4663, collection: `${intent.campaignSnapshot.contract.slice(0, 6)}…${intent.campaignSnapshot.contract.slice(-4)}`, wallet: attempt.wallet, quantity: intent.campaignSnapshot.quantity, hash: attempt.hash, feePaid: `${receipt.actualSpendWei ?? 0n} wei` };
          try {
            if (receipt.state === 'Confirmed') await this.options.alerts?.confirmed?.(run.id, facts);
            else await this.options.alerts?.mintFailed?.(run.id, facts, update.reason ?? 'TRANSACTION_REVERTED');
            await this.store.transaction(state => {
              if (!state.events.some(event => event.type === 'robinhood_finality_reported' && event.runId === run.id && event.data.receiptId === receipt.id)) state.events.push(this.event('robinhood_finality_reported', run.id, { receiptId: receipt.id, transactionAttemptId: attempt.id, outcome: receipt.state }));
            });
          } catch { /* delivery does not alter reconciliation or settlement */ }
        }
      }
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
      const confirmed = walletAttempts.find(attempt => attempt.state === 'Confirmed');
      const receipt = confirmed && receipts.find(item => item.executionId === confirmed.executionId && item.state === 'Confirmed' && receiptAuthorizesSettlement(campaign.chainId, item));
      const failedReceipt = receipts.find(item => item.state === 'Failed' && receiptAuthorizesSettlement(campaign.chainId, item) && walletAttempts.some(attempt => attempt.executionId === item.executionId));
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

  private assertEngineFacts(runId: string, chainId: 1 | 8453 | 4663, executionIds: readonly string[], attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[], allowUnfinalizedL2 = false): void {
    if (new Set(executionIds).size !== executionIds.length) throw new Error('DUPLICATE_EXECUTION_ID');
    if (attempts.some(item => item.runId !== runId || !executionIds.includes(item.executionId)) || receipts.some(item => item.runId !== runId || !executionIds.includes(item.executionId))) throw new Error('INVALID_ENGINE_EXECUTION_FACTS');
    if (new Set(attempts.map(item => item.id)).size !== attempts.length || new Set(receipts.map(item => item.id)).size !== receipts.length) throw new Error('DUPLICATE_ENGINE_FACT_ID');
    if (receipts.some(receipt => !['Pending', 'Confirmed', 'Reorged', 'Failed'].includes(receipt.state) || (receipt.state === 'Pending' && (!allowUnfinalizedL2 || chainId === 1)) || receipt.blockNumber === undefined || !receipt.blockHash || receipt.actualSpendWei === undefined || receipt.actualSpendWei < 0n)) throw new Error('INVALID_RECEIPT_FACT');
    if (chainId !== 1 && !allowUnfinalizedL2 && receipts.some(receipt => receipt.finalityStage !== 'ethereum_final')) throw new Error('L2_FINALITY_REQUIRED');
    if (chainId === 4663 && receipts.some(receipt => receipt.finalityStage === 'ethereum_final' && receipt.robinhoodFinality !== 'final')) throw new Error('ROBINHOOD_FINALITY_REQUIRED');
  }

  private assertReconciliationCoherence(runId: string, chainId: 1 | 8453 | 4663, result: string, existingAttempts: readonly AttemptRecord[], attempts: readonly AttemptRecord[], receipts: readonly ReceiptRecord[]): void {
    const expected = [...new Set(existingAttempts.map(item => item.executionId))];
    if (['confirmed', 'final', 'reorged'].includes(result)) {
      if (expected.length === 0) throw new Error('TERMINAL_RECONCILIATION_FACTS_REQUIRED');
      if (expected.some(id => !receipts.some(receipt => receipt.executionId === id))) throw new Error('INCOMPLETE_TERMINAL_RECEIPTS');
    }
    if (result === 'final' && (chainId === 1 || receipts.some(receipt => receipt.state !== 'Confirmed' || receipt.finalityStage !== 'ethereum_final' || (chainId === 4663 && receipt.robinhoodFinality !== 'final')))) throw new Error('INVALID_FINALITY_COHERENCE');
    if (result === 'confirmed' && (chainId !== 1 || receipts.some(receipt => receipt.state !== 'Confirmed'))) throw new Error('INVALID_FINALITY_COHERENCE');
    if (result === 'reorged' && receipts.some(receipt => receipt.state !== 'Reorged')) throw new Error('INVALID_REORG_COHERENCE');
    if (result === 'failed' && attempts.length === 0 && receipts.length === 0) throw new Error('FAILED_RECONCILIATION_FACTS_REQUIRED');
    if (attempts.some(item => item.runId !== runId)) throw new Error('INVALID_ENGINE_EXECUTION_FACTS');
  }

  private event(type: string, runId: string | undefined, data: Record<string, unknown>): EventRecord {
    return { id: `evt_${randomUUID()}`, ...(runId ? { runId } : {}), type, at: new Date().toISOString(), data };
  }

  /** Key 2 (D-040). Only the canonical store can supply it; any other store means no record, so Robinhood stays refused. */
  private robinhoodEnablement(): unknown { return this.canonicalStore()?.robinhoodEnablement?.(); }
  private baseEnablement(): unknown { return this.canonicalStore()?.baseEnablement?.(); }

  private canonicalStore(): CanonicalExecutionStore | undefined {
    const candidate = this.store as Partial<CanonicalExecutionStore>;
    return typeof candidate.admitExecution === 'function' && typeof candidate.abortRemaining === 'function' ? candidate as CanonicalExecutionStore : undefined;
  }
}

export type { Campaign };
