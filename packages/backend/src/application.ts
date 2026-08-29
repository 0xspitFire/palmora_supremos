import { randomUUID } from 'node:crypto';
import type { Campaign, ChainVerification, CommandName, FeePolicy, ValidatedCampaign } from './types.js';
import type { BackendStore } from './store.js';
import { ExecutionCoordinator } from './coordinator.js';
import { HealthService } from './health.js';
import { assertRobinhoodFreePolicy, ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI } from './policy.js';

export interface CommandResponse<T> { id: string; state: string; nextAction: string; createdAt: string; retryable: boolean; blockingReason?: string; data?: T; }
export interface CampaignInput { chainId: number; contract: string; strategy: string; quantity: number; dryRun?: boolean; maxRunWei: bigint; dailyCapWei: bigint; gasCeilingWei: bigint; broadcastMode?: 'flashbots' | 'public' | 'sequencer'; chainVerification: ChainVerification; mintPriceWei?: bigint; feePolicy: FeePolicy; }
export class BackendApplication {
  constructor(private readonly store: BackendStore, private readonly coordinator: ExecutionCoordinator) {}
  async command<T = unknown>(name: CommandName, input: Record<string, unknown> = {}): Promise<CommandResponse<T>> {
    const now = new Date().toISOString();
    if (name === 'health') { const health = new HealthService(this.store).check(); return { id: 'health', state: health.state, nextAction: health.ready ? 'Monitor health' : 'Resolve blocking reasons', createdAt: now, retryable: false, data: health as T }; }
    if (name === 'kill') { await this.coordinator.kill(String(input.reason ?? 'operator kill')); return { id: 'kill', state: 'Aborted', nextAction: 'Reconcile submitted work', createdAt: now, retryable: false }; }
    if (name === 'reconcile') { await this.coordinator.reconcile(); return { id: `cmd_${randomUUID()}`, state: 'Reconciled', nextAction: 'Inspect run records', createdAt: now, retryable: false }; }
    if (name === 'prepare' || name === 'resolve' || name === 'validate' || name === 'simulate' || name === 'dry-run') throw new Error(`${name.toUpperCase()}_ADAPTER_NOT_CONFIGURED`);
    if (name === 'arm') {
      const validated = input.validated as ValidatedCampaign | undefined;
      if (!validated) throw new Error('VALIDATED_CAMPAIGN_REQUIRED');
      const run = await this.coordinator.arm(validated, input.mode === 'live' ? 'live' : 'dry-run', typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined);
      return { id: run.id, state: run.state, nextAction: 'Execute run', createdAt: run.createdAt, retryable: false, data: run as unknown as T };
    }
    if (name === 'execute') {
      if (typeof input.runId !== 'string' || !Array.isArray(input.wallets)) throw new Error('RUN_AND_WALLETS_REQUIRED');
      const result = await this.coordinator.execute(input.runId, input.wallets.filter((wallet): wallet is string => typeof wallet === 'string'));
      const run = this.store.snapshot().runs.find(item => item.id === input.runId); if (!run) throw new Error('RUN_NOT_FOUND');
      return { id: input.runId, state: run.state, nextAction: ['Completed', 'Failed', 'Aborted'].includes(run.state) ? 'Inspect run' : 'Monitor run', createdAt: now, retryable: false, data: result as T };
    }
    throw new Error(`${String(name).toUpperCase()}_UNSUPPORTED`);
  }
  async createCampaign(input: CampaignInput): Promise<Campaign> {
    if (input.quantity < 1 || !Number.isSafeInteger(input.quantity)) throw new Error('INVALID_QUANTITY');
    if (input.maxRunWei < 0n || input.dailyCapWei < 0n || input.gasCeilingWei < 0n || (input.mintPriceWei ?? 0n) < 0n) throw new Error('INVALID_SPEND_POLICY');
    if (input.chainId !== 1 && input.chainId !== 4663) throw new Error('CHAIN_EXECUTION_BLOCKED');
    if (input.broadcastMode === 'flashbots' && input.chainId !== 1) throw new Error('FLASHBOTS_ETHEREUM_ONLY');
    if (input.chainId === 4663 && input.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
    if (input.chainId === 1 && input.broadcastMode === 'sequencer') throw new Error('SEQUENCER_ROBINHOOD_ONLY');
    if (input.chainVerification.chainId !== input.chainId) throw new Error('CHAIN_VERIFICATION_MISMATCH');
    if (input.feePolicy.kind === 'paid') throw new Error('PAID_MINT_POLICY_REQUIRED');
    if ((input.mintPriceWei ?? 0n) !== 0n) throw new Error('FREE_MINT_VALUE_MUST_BE_ZERO');
    if (input.feePolicy.configuredPriorityFeeWei < 0n) throw new Error('INVALID_PRIORITY_FEE_POLICY');
    const freeCap = input.feePolicy.configuredPriorityFeeWei * 2n;
    if (input.feePolicy.freeTotalSpendCapWei !== freeCap) throw new Error('FREE_TOTAL_SPEND_POLICY_INVALID');
    const l2Budget = input.feePolicy.l2ExecutionGasBudgetWei; const l1Budget = input.feePolicy.l1DataGasBudgetWei;
    if (l2Budget === undefined || l1Budget === undefined || l2Budget < 0n || l1Budget < 0n) throw new Error('GAS_COMPONENT_BUDGETS_REQUIRED');
    const totalFeeBudget = input.feePolicy.configuredPriorityFeeWei + l2Budget + l1Budget;
    if (input.feePolicy.totalFeeBudgetWei !== totalFeeBudget) throw new Error('TOTAL_FEE_BUDGET_MISMATCH');
    if (totalFeeBudget > freeCap) throw new Error('FREE_TOTAL_SPEND_CAP_EXCEEDED');
    if (totalFeeBudget > input.gasCeilingWei) throw new Error('GAS_CEILING_EXCEEDED');
    if (input.chainId === 4663) assertRobinhoodFreePolicy(input.gasCeilingWei, input.dailyCapWei, totalFeeBudget);
    if (input.chainId === 4663 && input.dailyCapWei > ROBINHOOD_FREE_ACTIVE_PERIOD_CAP_WEI) throw new Error('ROBINHOOD_ACTIVE_PERIOD_CAP_EXCEEDED');
    const now = new Date().toISOString(); const campaign: Campaign = { id: `cmp_${randomUUID()}`, state: 'Draft', chainId: input.chainId, contract: input.contract, strategy: input.strategy, quantity: input.quantity, dryRun: input.dryRun ?? true, spendPolicy: { maxRunWei: input.maxRunWei, dailyCapWei: input.dailyCapWei, gasCeilingWei: input.gasCeilingWei }, chainVerification: input.chainVerification, mintPriceWei: input.mintPriceWei ?? 0n, feePolicy: input.feePolicy, ...(input.broadcastMode ? { broadcastMode: input.broadcastMode } : {}), createdAt: now, updatedAt: now };
    await this.store.transaction(state => { state.campaigns.push(campaign); }); return campaign;
  }
}
