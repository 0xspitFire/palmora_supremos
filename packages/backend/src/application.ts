import { randomUUID } from 'node:crypto';
import type { Campaign, ChainVerification, CommandName, FeePolicy, ValidatedCampaign } from './types.js';
import type { DurableStore } from './store.js';
import { ExecutionCoordinator } from './coordinator.js';

export interface CommandResponse<T> { id: string; state: string; nextAction: string; createdAt: string; retryable: boolean; blockingReason?: string; data?: T; }
export interface CampaignInput { chainId: number; contract: string; strategy: string; quantity: number; dryRun?: boolean; maxRunWei: bigint; dailyCapWei: bigint; gasCeilingWei: bigint; broadcastMode?: 'flashbots' | 'public' | 'sequencer'; chainVerification: ChainVerification; mintPriceWei?: bigint; feePolicy: FeePolicy; }
export class BackendApplication {
  constructor(private readonly store: DurableStore, private readonly coordinator: ExecutionCoordinator) {}
  async command<T = unknown>(name: CommandName, input: Record<string, unknown> = {}): Promise<CommandResponse<T>> {
    const now = new Date().toISOString();
    if (name === 'health') return { id: 'health', state: this.store.snapshot().killed ? 'Killed' : 'Ready', nextAction: 'Inspect health', createdAt: now, retryable: false };
    if (name === 'kill') { await this.coordinator.kill(String(input.reason ?? 'operator kill')); return { id: 'kill', state: 'Aborted', nextAction: 'Reconcile submitted work', createdAt: now, retryable: false }; }
    if (name === 'reconcile') { await this.coordinator.reconcile(); return { id: `cmd_${randomUUID()}`, state: 'Reconciled', nextAction: 'Inspect run records', createdAt: now, retryable: false }; }
    if (name === 'prepare' || name === 'resolve' || name === 'validate' || name === 'simulate') return { id: `cmd_${randomUUID()}`, state: name === 'simulate' ? 'Simulated' : 'Ready', nextAction: name === 'simulate' ? 'Arm campaign' : 'Simulate campaign', createdAt: now, retryable: true };
    if (name === 'arm') {
      const validated = input.validated as ValidatedCampaign | undefined;
      if (!validated) throw new Error('VALIDATED_CAMPAIGN_REQUIRED');
      const run = await this.coordinator.arm(validated, input.mode === 'live' ? 'live' : 'dry-run', typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined);
      return { id: run.id, state: run.state, nextAction: 'Execute run', createdAt: run.createdAt, retryable: false, data: run as unknown as T };
    }
    if (name === 'execute') {
      if (typeof input.runId !== 'string' || !Array.isArray(input.wallets)) throw new Error('RUN_AND_WALLETS_REQUIRED');
      const result = await this.coordinator.execute(input.runId, input.wallets.filter((wallet): wallet is string => typeof wallet === 'string'));
      return { id: input.runId, state: 'Active', nextAction: 'Monitor run', createdAt: now, retryable: true, data: result as T };
    }
    throw new Error(`${String(name).toUpperCase()}_UNSUPPORTED`);
  }
  async createCampaign(input: CampaignInput): Promise<Campaign> {
    if (input.quantity < 1 || !Number.isSafeInteger(input.quantity)) throw new Error('INVALID_QUANTITY');
    if (input.chainId !== 1 && input.chainId !== 4663) throw new Error('CHAIN_EXECUTION_BLOCKED');
    if (input.broadcastMode === 'flashbots' && input.chainId !== 1) throw new Error('FLASHBOTS_ETHEREUM_ONLY');
    if (input.chainId === 4663 && input.broadcastMode !== 'sequencer') throw new Error('ROBINHOOD_SEQUENCER_REQUIRED');
    if (input.chainId === 1 && input.broadcastMode === 'sequencer') throw new Error('SEQUENCER_ROBINHOOD_ONLY');
    if (input.chainVerification.chainId !== input.chainId) throw new Error('CHAIN_VERIFICATION_MISMATCH');
    if (input.feePolicy.kind === 'paid') throw new Error('PAID_MINT_POLICY_REQUIRED');
    if (input.feePolicy.configuredPriorityFeeWei < 0n) throw new Error('INVALID_PRIORITY_FEE_POLICY');
    const freeCap = input.feePolicy.configuredPriorityFeeWei * 2n;
    if (input.feePolicy.freePriorityFeeCapWei !== freeCap) throw new Error('FREE_PRIORITY_FEE_POLICY_INVALID');
    const l2Budget = input.feePolicy.l2ExecutionGasBudgetWei; const l1Budget = input.feePolicy.l1DataGasBudgetWei;
    if (l2Budget === undefined || l1Budget === undefined || l2Budget < 0n || l1Budget < 0n) throw new Error('GAS_COMPONENT_BUDGETS_REQUIRED');
    const totalFeeBudget = freeCap + l2Budget + l1Budget;
    if (input.feePolicy.totalFeeBudgetWei !== totalFeeBudget) throw new Error('TOTAL_FEE_BUDGET_MISMATCH');
    const now = new Date().toISOString(); const campaign: Campaign = { id: `cmp_${randomUUID()}`, state: 'Draft', chainId: input.chainId, contract: input.contract, strategy: input.strategy, quantity: input.quantity, dryRun: input.dryRun ?? true, spendPolicy: { maxRunWei: input.maxRunWei, dailyCapWei: input.dailyCapWei, gasCeilingWei: input.gasCeilingWei }, chainVerification: input.chainVerification, mintPriceWei: input.mintPriceWei ?? 0n, feePolicy: input.feePolicy, ...(input.broadcastMode ? { broadcastMode: input.broadcastMode } : {}), createdAt: now, updatedAt: now };
    const state = this.store.snapshot(); state.campaigns.push(campaign); this.store.replace(state); await this.store.commit(); return campaign;
  }
}
