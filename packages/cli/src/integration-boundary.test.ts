import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliRuntime } from './runtime.js';
import { createCanonicalLifecycleStore, mapResult, paidRunMintValueCapEth } from './engine-adapter.js';
import type { MintJobResult } from '@mint-bot/engine';
import type { Campaign } from '@mint-bot/backend';

describe('CLI integration boundary', () => {
  it('derives a positive paid mint-value cap from the campaign run policy', () => {
    const campaign: Campaign = { id: 'campaign-paid', state: 'Draft', chainId: 1, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, spendPolicy: { maxRunWei: 2_000_000_000_000_000_000n, dailyCapWei: 2_000_000_000_000_000_000n, gasCeilingWei: 100_000_000_000_000_000n }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETH_FEED_REFERENCE' }, mintPriceWei: 1_000_000_000_000_000_000n, feePolicy: { kind: 'paid', configuredPriorityFeeWei: 1_000_000_000_000_000n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 1_000_000_000_000_000n }, broadcastMode: 'public', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    expect(paidRunMintValueCapEth(campaign)).toBe(2);
  });

  it('maps Engine-provided identities and keeps Robinhood staged receipts non-terminal', () => {
    const campaign: Campaign = { id: 'campaign-rh', state: 'Armed', chainId: 4663, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, spendPolicy: { maxRunWei: 2_000_000_000_000_000_000n, dailyCapWei: 2_000_000_000_000_000_000n, gasCeilingWei: 100_000_000_000_000_000n }, chainVerification: { chainId: 4663, status: 'verified', seaDropCompatible: true, endpointReference: 'RH_SEQUENCER_REFERENCE' }, mintPriceWei: 0n, feePolicy: { kind: 'free', configuredPriorityFeeWei: 1_000_000_000_000_000n, freeTotalSpendCapWei: 2_000_000_000_000_000n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 1_000_000_000_000_000n }, broadcastMode: 'sequencer', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const result: MintJobResult = { jobId: 'engine-run', nftContract: campaign.contract as `0x${string}`, chainId: 4663, strategy: campaign.strategy, startedAt: new Date(0), completedAt: new Date(0), dryRun: false, walletResults: [{ walletIndex: 0, address: '0x1111111111111111111111111111111111111111', status: 'timeout', txHash: `0x${'a'.repeat(64)}`, nonce: 1, blockNumber: 5n, blockHash: `0x${'b'.repeat(64)}`, finalityStage: 'soft', totalFeeWei: 4n, totalCostWei: 4n, executionId: 'execution-canonical', transactionIntentId: 'intent-canonical', attemptIds: ['execution-canonical:attempt:signed', 'execution-canonical:attempt:broadcast'], submittedAttemptId: 'execution-canonical:attempt:broadcast', durationMs: 1 }], totalGasSpentWei: 4n, totalMintCostWei: 0n, successCount: 0, failCount: 0 };
    const mapped = mapResult(result, 'backend-run', campaign);
    expect(mapped.executionIds).toEqual(['execution-canonical']);
    expect(mapped.attempts[0]?.executionId).toBe('execution-canonical');
    expect(mapped.attempts.map((attempt) => attempt.id)).toEqual(['execution-canonical:attempt:signed', 'execution-canonical:attempt:broadcast']);
    expect(mapped.receipts[0]?.transactionAttemptId).toBe('execution-canonical:attempt:broadcast');
    expect(mapped.receipts[0]?.state).toBe('Confirmed');
    expect(mapped.receipts[0]?.robinhoodFinality).toBe('soft');
    expect(mapped.state).toBe('Pending');
    const incomplete = { ...result, walletResults: [{ ...result.walletResults[0]!, executionId: undefined, transactionIntentId: undefined }] };
    expect(() => mapResult(incomplete, 'backend-run', campaign)).toThrow('ENGINE_IDENTITY_REQUIRED');
    expect(mapResult({ ...incomplete, dryRun: true }, 'backend-run', campaign).executionIds).toEqual([]);
  });

  it('does not retain the direct engine execution bypass', async () => {
    const source = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('new MintEngine');
    expect(source).not.toContain('unavailableEngine');
    expect(source).toContain('EXPLICIT_APPROVE_ARM_RUN_REQUIRED');
  });

  it('creates a durable SQLite backend runtime', async () => {
    const statePath = `${process.cwd()}/.tmp-cli-runtime-${process.pid}.sqlite`;
    const runtime = await createCliRuntime(process.cwd(), {
      prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' as const }),
      execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Confirmed' as const }),
      reconcile: async () => ({ result: 'unknown' as const, attempts: [], receipts: [] }),
    }, statePath);
    try {
      expect(runtime.store.capabilities()).toEqual({ durable: true, atomicAcrossProcesses: true });
      const lifecycle = createCanonicalLifecycleStore(runtime.store);
      expect(lifecycle.durable).toBe(true);
      expect(lifecycle.storeKind).toBe('normalized-sqlite');
      expect(typeof lifecycle.persistRun).toBe('function');
      expect(typeof lifecycle.persistReceipt).toBe('function');
    } finally {
      if ('close' in runtime.store && typeof runtime.store.close === 'function') runtime.store.close();
      await import('node:fs/promises').then(({ rm }) => rm(statePath, { force: true }));
    }
  });
});
