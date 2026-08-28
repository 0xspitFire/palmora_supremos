import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';
import { SpendLedger } from './spend-ledger.js';
import { ReadinessService } from './readiness.js';
import { NotificationDispatcher } from './notifications.js';
import { normalizeError } from './errors.js';
import { BackendApplication } from './application.js';
import { ExecutionCoordinator } from './coordinator.js';
import { ReadModelService } from './read-model.js';
import { normalizeTotalFeeBudget } from './fees.js';
import { resolveWalletPath } from './keystore-path.js';

describe('backend application contracts', () => {
  it('atomically enforces campaign spend exposure', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store);
    await ledger.reserve('run-a', 'campaign-a', '0x1', 70n, 100n);
    await expect(ledger.reserve('run-b', 'campaign-a', '0x2', 31n, 100n)).rejects.toThrow('SPEND_CAP_EXCEEDED');
    expect(ledger.available('campaign-a', 100n)).toBe(30n);
  });

  it('persists bigint reservations across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mint-backend-')); const file = join(dir, 'state.json');
    try {
      const first = new DurableStore(file); await first.open(); const ledger = new SpendLedger(first); await ledger.reserve('run', 'campaign', 'wallet', 42n, 100n);
      const second = new DurableStore(file); await second.open(); expect(second.snapshot().reservations[0]?.amountWei).toBe(42n);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('returns field-level readiness blockers', () => {
    const result = new ReadinessService().evaluate({ wallet: '0x1', funded: true, eligible: false, constructible: true, simulated: false, gasPolicy: true });
    expect(result.state).toBe('Funded'); expect(result.blockingReasons).toEqual(['eligible', 'simulated']);
  });

  it('deduplicates notification delivery', async () => {
    const sent: string[] = []; const store = new DurableStore(); const dispatcher = new NotificationDispatcher(store, { send: async ({ text }) => { sent.push(text); } });
    await dispatcher.dispatch('started', 'run started', 'run-1', 'same-key'); await dispatcher.dispatch('started', 'run started', 'run-1', 'same-key');
    expect(sent).toEqual(['run started']);
  });

  it('redacts sensitive error fields', () => {
    const error = normalizeError(new Error('privateKey=secret calldata=0xdeadbeef'));
    expect(error.message).toBe('privateKey=[REDACTED] calldata=[REDACTED]');
  });

  it('creates one intent for an idempotent arm request', async () => {
    const store = new DurableStore(); const campaignStore = new BackendApplication(store, undefined as never);
    const campaign = await campaignStore.createCampaign({ chainId: 1, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 100n, dailyCapWei: 200n, gasCeilingWei: 10n, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'MINT_BOT_SECRETS:ETHEREUM_RPC_URL' }, feePolicy: { kind: 'free', configuredPriorityFeeWei: 3n, freePriorityFeeCapWei: 6n, l2ExecutionGasBudgetWei: 10n, l1DataGasBudgetWei: 4n, totalFeeBudgetWei: 20n } });
    const coordinator = new ExecutionCoordinator(store, { execute: async () => ({ executionIds: [], attempts: [], state: 'Prepared' }), reconcile: async () => 'unknown' });
    const validated = { campaign, simulationId: 'sim-1', evidenceAt: new Date().toISOString() };
    const first = await coordinator.arm(validated, 'dry-run', 'same-request'); const second = await coordinator.arm(validated, 'dry-run', 'same-request');
    expect(second.id).toBe(first.id); expect(store.snapshot().intents).toHaveLength(1); expect(store.snapshot().events[0]?.data.intentId).toBe(first.intentId);
  });

  it('blocks non-Ethereum campaigns and exposes canonical run records', async () => {
    const store = new DurableStore(); const app = new BackendApplication(store, undefined as never);
    const campaign = await app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, maxRunWei: 10n, dailyCapWei: 10n, gasCeilingWei: 1n, broadcastMode: 'sequencer', chainVerification: { chainId: 4663, status: 'unverified', seaDropCompatible: false, endpointReference: 'MINT_BOT_SECRETS:ROBINHOOD_RPC_URL' }, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, freePriorityFeeCapWei: 0n, l2ExecutionGasBudgetWei: 2n, l1DataGasBudgetWei: 1n, totalFeeBudgetWei: 3n } });
    const coordinator = new ExecutionCoordinator(store, { execute: async () => ({ executionIds: [], attempts: [], state: 'Prepared' }), reconcile: async () => 'unknown' });
    await expect(coordinator.arm({ campaign, simulationId: 'sim', evidenceAt: new Date().toISOString() }, 'live')).rejects.toThrow('CHAIN_VERIFICATION_REQUIRED');
    expect(() => new ReadModelService(store).getRun('missing')).toThrow('RUN_NOT_FOUND');
  });

  it('fails closed when a priority multiplier lacks a finite total-fee basis', () => {
    expect(() => normalizeTotalFeeBudget({ priorityFeeMultiplier: 2 })).toThrow('AMBIGUOUS_TOTAL_FEE_BUDGET');
    expect(normalizeTotalFeeBudget({ gasLimit: 100n, gasPriceWei: 3n, dataFeeWei: 5n, baseFeeWei: 2n, priorityFeeMultiplier: 2 })).toBe(705n);
  });

  it('rejects fee snapshots that omit independent gas exposure', async () => {
    const app = new BackendApplication(new DurableStore(), undefined as never);
    await expect(app.createCampaign({ chainId: 4663, contract: '0xabc', strategy: 'seadrop-v1-public', quantity: 1, maxRunWei: 10n, dailyCapWei: 10n, gasCeilingWei: 1n, broadcastMode: 'sequencer', chainVerification: { chainId: 4663, status: 'unverified', seaDropCompatible: false, endpointReference: 'MINT_BOT_SECRETS:ROBINHOOD_RPC_URL' }, feePolicy: { kind: 'free', configuredPriorityFeeWei: 0n, freePriorityFeeCapWei: 0n, totalFeeBudgetWei: 0n } })).rejects.toThrow('GAS_COMPONENT_BUDGETS_REQUIRED');
  });

  it('serializes concurrent reservations at the cap boundary', async () => {
    const ledger = new SpendLedger(new DurableStore());
    const results = await Promise.allSettled([ledger.reserve('run-a', 'campaign', 'wallet-a', 60n, 100n), ledger.reserve('run-b', 'campaign', 'wallet-b', 60n, 100n)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('keeps settled spend inside the per-run cap', async () => {
    const store = new DurableStore(); const ledger = new SpendLedger(store);
    const first = await ledger.reserve('run', 'campaign', 'wallet-a', 70n, 100n);
    await ledger.settle(first.id);
    await expect(ledger.reserve('run', 'campaign', 'wallet-b', 31n, 100n)).rejects.toThrow('SPEND_CAP_EXCEEDED');
  });

  it('keeps wallet paths inside the approved keystore root', () => {
    const root = join('C:', 'project');
    expect(resolveWalletPath(root)).toBe(join(resolveWalletPath(root), '.'));
    expect(() => resolveWalletPath(root, './Rets/other')).toThrow('WALLET_PATH_OUTSIDE_APPROVED_ROOT');
  });
});
