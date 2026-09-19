import { randomUUID } from 'node:crypto';
import type { Campaign, ChainVerification, CommandName, FeePolicy, ValidatedCampaign } from './types.js';
import type { BackendStore } from './store.js';
import { ExecutionCoordinator } from './coordinator.js';
import { HealthService } from './health.js';
import { assertRobinhoodFreePolicy, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI } from './policy.js';
import { liveRequestDigest } from './evidence.js';

export interface CommandResponse<T> { id: string; state: string; nextAction: string; createdAt: string; retryable: boolean; blockingReason?: string; data?: T; }
export interface CampaignInput { chainId: number; contract: string; strategy: string; quantity: number; dryRun?: boolean; maxRunWei: bigint; dailyCapWei: bigint; gasCeilingWei: bigint; broadcastMode?: 'flashbots' | 'public' | 'sequencer'; chainVerification: ChainVerification; mintPriceWei?: bigint; feePolicy: FeePolicy; openingAt?: string; tMinusMs?: number; }
export interface ApprovalCommandInput { validated: ValidatedCampaign; idempotencyKey?: string; }
export interface ArmCommandInput { validated: ValidatedCampaign; mode: 'dry-run' | 'live'; idempotencyKey?: string; approvalId?: string; }
export interface RunCommandInput { runId: string; wallets: string[]; idempotencyKey?: string; }
export interface SummaryCommandInput { runId?: string; }
export interface FundCommandInput { runId?: string; wallets?: string[]; }
export type TypedCommandInput = ApprovalCommandInput | ArmCommandInput | RunCommandInput | SummaryCommandInput | FundCommandInput | { reason?: string; idempotencyKey?: string };
export class BackendApplication {
  constructor(private readonly store: BackendStore, private readonly coordinator: ExecutionCoordinator) {}
  async command<T = unknown>(name: CommandName, input: Record<string, unknown> = {}): Promise<CommandResponse<T>> {
    const now = new Date().toISOString();
    if (name === 'health') { const health = new HealthService(this.store).check(); return { id: 'health', state: health.state, nextAction: health.ready ? 'Monitor health' : 'Resolve blocking reasons', createdAt: now, retryable: false, data: health as T }; }
    if (name === 'kill') { const reason = String(input.reason ?? 'operator kill'); await this.coordinator.kill(reason); return { id: 'kill', state: 'Aborted', nextAction: 'Reconcile submitted work', createdAt: now, retryable: false }; }
    if (name === 'reconcile') { await this.coordinator.reconcile(); return { id: String(input.idempotencyKey ?? 'reconcile'), state: 'Reconciled', nextAction: 'Inspect run records', createdAt: now, retryable: false }; }
    if (name === 'prepare' || name === 'resolve' || name === 'validate' || name === 'simulate') throw new Error(`${name.toUpperCase()}_ADAPTER_NOT_CONFIGURED`);
    if (name === 'approve') {
      const validated = input.validated as ValidatedCampaign | undefined;
      if (!validated) throw new Error('VALIDATED_CAMPAIGN_REQUIRED');
      const campaign = this.store.snapshot().campaigns.find(item => item.id === validated.campaign.id);
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      const approvalKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : `approval:${campaign.id}:${validated.evidenceAt}`;
      const wallets = [...(validated.wallets ?? [])];
      const simulationIds = [...(validated.simulationIds ?? [])];
      const requestDigest = liveRequestDigest(campaign, 'live', wallets, simulationIds);
      const existing = this.store.snapshot().events.find(event => event.type === 'campaign_approved' && event.data.idempotencyKey === approvalKey);
      if (existing) {
        if (existing.data.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return { id: existing.id, state: 'Approved', nextAction: 'Arm the approved campaign', createdAt: existing.at, retryable: false, data: existing.data as T };
      }
      const event = { id: `approval_${randomUUID()}`, type: 'campaign_approved', at: now, data: { campaignId: campaign.id, idempotencyKey: approvalKey, requestDigest, wallets, evidenceAt: validated.evidenceAt, simulationIds } };
      await this.store.transaction(state => { state.events.push(event); });
      return { id: event.id, state: 'Approved', nextAction: 'Arm the approved campaign', createdAt: now, retryable: false, data: event.data as T };
    }
    if (name === 'arm') {
      const validated = input.validated as ValidatedCampaign | undefined;
      if (!validated) throw new Error('VALIDATED_CAMPAIGN_REQUIRED');
      const mode = input.mode === 'live' ? 'live' : 'dry-run';
      if (mode === 'live') {
        const campaign = this.store.snapshot().campaigns.find(item => item.id === validated.campaign.id);
        const approvalDigest = campaign ? liveRequestDigest(campaign, 'live', [...(validated.wallets ?? [])], [...(validated.simulationIds ?? [])]) : undefined;
        const approved = this.store.snapshot().events.some(event => event.type === 'campaign_approved' && event.data.campaignId === validated.campaign.id && event.data.requestDigest === approvalDigest && (!input.approvalId || event.id === input.approvalId));
        if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
        if (!approved) throw new Error('APPROVAL_REQUIRED');
      }
      const run = await this.coordinator.arm(validated, mode, typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined);
      return { id: run.id, state: run.state, nextAction: 'Execute run', createdAt: run.createdAt, retryable: false, data: run as unknown as T };
    }
    if (name === 'dry-run') {
      const validated = input.validated as ValidatedCampaign | undefined;
      if (!validated || !Array.isArray(validated.wallets)) throw new Error('VALIDATED_CAMPAIGN_REQUIRED');
      const campaign = this.store.snapshot().campaigns.find(item => item.id === validated.campaign.id);
      if (!campaign) throw new Error('CAMPAIGN_NOT_FOUND');
      const wallets = validated.wallets.filter((wallet): wallet is string => typeof wallet === 'string');
      const simulationIds = [...(validated.simulationIds ?? [])];
      const idempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : `dry-run:${campaign.id}:${wallets.map(wallet => wallet.toLowerCase()).join(',')}`;
      const requestDigest = liveRequestDigest(campaign, 'dry-run', wallets, simulationIds);
      const priorCommand = this.store.snapshot().events.find(event => event.type === 'command_dry_run' && event.data.idempotencyKey === idempotencyKey);
      if (priorCommand) {
        if (priorCommand.data.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return priorCommand.data.response as CommandResponse<T>;
      }
      const run = await this.coordinator.arm({ ...validated, campaign, wallets, simulationIds }, 'dry-run', idempotencyKey);
      const result = await this.coordinator.execute(run.id, wallets);
      const completed = this.store.snapshot().runs.find(item => item.id === run.id);
      if (!completed) throw new Error('RUN_NOT_FOUND');
      const response: CommandResponse<T> = { id: run.id, state: completed.state, nextAction: 'Inspect run summary', createdAt: now, retryable: false, data: result as T };
      await this.store.transaction(state => { state.events.push({ id: `cmd_${randomUUID()}`, type: 'command_dry_run', runId: run.id, at: now, data: { idempotencyKey, requestDigest, response } }); });
      return response;
    }
    if (name === 'run' || name === 'execute') {
      if (typeof input.runId !== 'string' || !Array.isArray(input.wallets)) throw new Error('RUN_AND_WALLETS_REQUIRED');
      const runId = input.runId;
      const wallets = input.wallets.filter((wallet): wallet is string => typeof wallet === 'string');
      const idempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : `run:${runId}:${wallets.map(wallet => wallet.toLowerCase()).join(',')}`;
      const requestDigest = `${runId}:${wallets.map(wallet => wallet.toLowerCase()).join(',')}`;
      const priorCommand = this.store.snapshot().events.find(event => event.type === 'command_run' && event.data.idempotencyKey === idempotencyKey);
      if (priorCommand) {
        if (priorCommand.data.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_KEY_CONFLICT');
        return priorCommand.data.response as CommandResponse<T>;
      }
      const result = await this.coordinator.execute(runId, wallets);
      const run = this.store.snapshot().runs.find(item => item.id === runId); if (!run) throw new Error('RUN_NOT_FOUND');
      const response: CommandResponse<T> = { id: runId, state: run.state, nextAction: ['Completed', 'Failed', 'Aborted'].includes(run.state) ? 'Inspect run' : 'Monitor run', createdAt: now, retryable: false, data: result as T };
      await this.store.transaction(state => { state.events.push({ id: `cmd_${randomUUID()}`, type: 'command_run', runId, at: now, data: { idempotencyKey, requestDigest, response } }); });
      return response;
    }
    if (name === 'summary') {
      const state = this.store.snapshot();
      const runId = typeof input.runId === 'string' ? input.runId : undefined;
      const runs = runId ? state.runs.filter(run => run.id === runId) : state.runs;
      return { id: runId ?? 'summary', state: 'Summarized', nextAction: 'Inspect canonical run facts', createdAt: now, retryable: false, data: runs.map(run => ({ run, campaign: state.campaigns.find(campaign => campaign.id === run.campaignId), attempts: state.attempts.filter(attempt => attempt.runId === run.id), receipts: state.receipts.filter(receipt => receipt.runId === run.id), reconciliations: state.reconciliations.filter(item => item.runId === run.id), reservations: state.reservations.filter(item => item.runId === run.id) })) as T };
    }
    if (name === 'fund') {
      const state = this.store.snapshot();
      const run = typeof input.runId === 'string' ? state.runs.find(item => item.id === input.runId) : undefined;
      if (input.runId !== undefined && !run) throw new Error('RUN_NOT_FOUND');
      const intent = run ? state.intents.find(item => item.id === run.intentId) : undefined;
      const wallets = Array.isArray(input.wallets) ? input.wallets.filter((wallet): wallet is string => typeof wallet === 'string') : intent?.wallets ?? [];
      if (wallets.length === 0) throw new Error('FUNDING_WALLETS_REQUIRED');
      return { id: typeof input.runId === 'string' ? input.runId : 'fund', state: 'FundingReport', nextAction: 'Fund through the approved operator flow, then rerun health', createdAt: now, retryable: false, data: { wallets, autoFund: false, canonicalSource: 'wallet_balance', note: 'Backend never handles private keys or performs unattended funding' } as T };
    }
    throw new Error(`${String(name).toUpperCase()}_UNSUPPORTED`);
  }
  async createCampaign(input: CampaignInput): Promise<Campaign> {
    if (input.quantity < 1 || !Number.isSafeInteger(input.quantity)) throw new Error('INVALID_QUANTITY');
    if (input.openingAt !== undefined && !Number.isFinite(Date.parse(input.openingAt))) throw new Error('INVALID_OPENING_TIME');
    if (input.tMinusMs !== undefined && (!Number.isFinite(input.tMinusMs) || input.tMinusMs < 0)) throw new Error('INVALID_T_MINUS');
    if (input.maxRunWei < 0n || input.dailyCapWei < 0n || input.gasCeilingWei < 0n || (input.mintPriceWei ?? 0n) < 0n) throw new Error('INVALID_SPEND_POLICY');
    if (input.chainId !== 1 && input.chainId !== 4663) throw new Error('CHAIN_EXECUTION_BLOCKED');
    if (input.broadcastMode === 'flashbots' && input.chainId !== 1) throw new Error('FLASHBOTS_ETHEREUM_ONLY');
    if (input.chainId === 4663 && input.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
    if (input.chainId === 1 && input.broadcastMode === 'sequencer') throw new Error('SEQUENCER_ROBINHOOD_ONLY');
    if (input.chainVerification.chainId !== input.chainId) throw new Error('CHAIN_VERIFICATION_MISMATCH');
    if (input.feePolicy.configuredPriorityFeeWei < 0n) throw new Error('INVALID_PRIORITY_FEE_POLICY');
    const l2Budget = input.feePolicy.l2ExecutionGasBudgetWei; const l1Budget = input.feePolicy.l1DataGasBudgetWei;
    if (l2Budget === undefined || l1Budget === undefined || l2Budget < 0n || l1Budget < 0n) throw new Error('GAS_COMPONENT_BUDGETS_REQUIRED');
    const totalFeeBudget = input.feePolicy.configuredPriorityFeeWei + l2Budget + l1Budget;
    if (input.feePolicy.totalFeeBudgetWei !== totalFeeBudget) throw new Error('TOTAL_FEE_BUDGET_MISMATCH');
    if (totalFeeBudget > input.gasCeilingWei) throw new Error('GAS_CEILING_EXCEEDED');
    const mintPriceWei = input.mintPriceWei ?? 0n;
    if (input.feePolicy.kind === 'paid') {
      if (input.chainId === 4663) throw new Error('ROBINHOOD_PAID_MINTS_DISABLED');
      if (input.chainId !== 1 || input.broadcastMode !== 'public') throw new Error('PAID_ETHEREUM_PUBLIC_MODE_REQUIRED');
      if (mintPriceWei <= 0n) throw new Error('PAID_MINT_VALUE_REQUIRED');
      const allInExposure = mintPriceWei * BigInt(input.quantity) + totalFeeBudget;
      if (allInExposure > input.maxRunWei || allInExposure > input.dailyCapWei) throw new Error('PAID_ETHEREUM_CAP_REQUIRED');
    } else {
      if (mintPriceWei !== 0n) throw new Error('FREE_MINT_VALUE_MUST_BE_ZERO');
      const freeCap = input.feePolicy.configuredPriorityFeeWei * 2n;
      if (input.feePolicy.freeTotalSpendCapWei !== freeCap) throw new Error('FREE_TOTAL_SPEND_POLICY_INVALID');
      if (totalFeeBudget > freeCap) throw new Error('FREE_TOTAL_SPEND_CAP_EXCEEDED');
      if (input.chainId === 4663) assertRobinhoodFreePolicy(input.gasCeilingWei, input.dailyCapWei, totalFeeBudget);
      if (input.chainId === 4663 && input.dailyCapWei > ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI) throw new Error('ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED');
    }
    const now = new Date().toISOString(); const campaign: Campaign = { id: `cmp_${randomUUID()}`, state: 'Draft', chainId: input.chainId, contract: input.contract, strategy: input.strategy, quantity: input.quantity, dryRun: input.dryRun ?? true, spendPolicy: { maxRunWei: input.maxRunWei, dailyCapWei: input.dailyCapWei, gasCeilingWei: input.gasCeilingWei }, chainVerification: input.chainVerification, mintPriceWei, feePolicy: input.feePolicy, ...(input.broadcastMode ? { broadcastMode: input.broadcastMode } : {}), ...(input.openingAt ? { openingAt: input.openingAt } : {}), ...(input.tMinusMs === undefined ? {} : { tMinusMs: input.tMinusMs }), createdAt: now, updatedAt: now };
    await this.store.transaction(state => { state.campaigns.push(campaign); }); return campaign;
  }
}
