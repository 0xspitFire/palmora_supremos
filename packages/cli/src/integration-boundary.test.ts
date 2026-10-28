import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliRuntime } from './runtime.js';
import { createCanonicalLifecycleStore, mapResult, paidRunMintValueCapEth, uniqueSubmittedAttempts } from './engine-adapter.js';
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

    // D-081: a wallet stopped before anything was prepared must not make the sent wallet unmappable.
    const stopped = { walletIndex: 1, address: '0x2222222222222222222222222222222222222222' as `0x${string}`, status: 'skipped' as const, error: 'CAMPAIGN_CHANGED_MID_RUN: price', durationMs: 1 };
    const mixed = mapResult({ ...result, walletResults: [...result.walletResults, stopped] }, 'backend-run', campaign);
    expect(mixed.executionIds).toEqual(['execution-canonical']);
    expect(mixed.attempts.map((attempt) => attempt.id)).toEqual(['execution-canonical:attempt:signed', 'execution-canonical:attempt:broadcast']);
    expect(mixed.state).toBe('Pending');
    const onlyStopped = mapResult({ ...result, walletResults: [stopped] }, 'backend-run', campaign);
    expect(onlyStopped).toMatchObject({ executionIds: [], state: 'Failed' });
    // Anything that may have been signed or sent, or that holds a reservation, still fails closed without an identity.
    for (const unsafe of [{ ...stopped, txHash: `0x${'a'.repeat(64)}` as `0x${string}` }, { ...stopped, attemptIds: ['a'] }, { ...stopped, reservationId: 'r' }, { ...stopped, status: 'failed' as const }, { ...stopped, status: 'timeout' as const }]) {
      expect(() => mapResult({ ...result, walletResults: [unsafe] }, 'backend-run', campaign)).toThrow('ENGINE_IDENTITY_REQUIRED');
    }
  });

  it('T-094: a wallet with a replacement keeps one hash per attempt, links the replacement, and marks the loser Replaced', () => {
    const campaign: Campaign = { id: 'campaign-rh', state: 'Armed', chainId: 4663, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false } as unknown as Campaign;
    const hashA = `0x${'a'.repeat(64)}` as `0x${string}`;
    const hashB = `0x${'b'.repeat(64)}` as `0x${string}`;
    const ids = ['exec-1:attempt:signed', 'exec-1:attempt:0:accepted', 'exec-1:attempt:replacement-1:signed', 'exec-1:replacement-1:attempt:0:accepted'];
    const wallet = {
      walletIndex: 0, address: '0x1111111111111111111111111111111111111111' as `0x${string}`, status: 'timeout' as const,
      txHash: hashB, nonce: 4, blockNumber: 99n, blockHash: `0x${'6'.repeat(64)}` as `0x${string}`, finalityStage: 'soft' as const,
      gasUsed: 100n, effectiveGasPrice: 2n, totalCostWei: 200n, durationMs: 5, executionId: 'exec-1', transactionIntentId: 'intent-1',
      attemptIds: ids, submittedAttemptId: ids[3]!,
      attemptHashes: { [ids[0]!]: hashA, [ids[1]!]: hashA, [ids[2]!]: hashB, [ids[3]!]: hashB },
      attemptReplacements: { [ids[2]!]: ids[0]!, [ids[3]!]: ids[0]! },
      replacedAttemptIds: [ids[0]!, ids[1]!],
    };
    const job = { jobId: 'j', nftContract: campaign.contract as `0x${string}`, chainId: 4663 as const, strategy: campaign.strategy, startedAt: new Date(0), completedAt: new Date(0), dryRun: false, walletResults: [wallet], totalGasSpentWei: 0n, totalMintCostWei: 0n, successCount: 0, failCount: 0 } as unknown as MintJobResult;
    const mapped = mapResult(job, 'backend-run', campaign);
    const byId = Object.fromEntries(mapped.attempts.map((attempt) => [attempt.id, attempt]));
    expect(byId[ids[0]!]).toMatchObject({ hash: hashA, state: 'Replaced' });
    expect(byId[ids[1]!]).toMatchObject({ hash: hashA, state: 'Replaced' });
    expect(byId[ids[2]!]).toMatchObject({ hash: hashB, state: 'Signed', replacementOfId: ids[0] });
    expect(byId[ids[3]!]).toMatchObject({ hash: hashB, replacementOfId: ids[0] });
    expect(byId[ids[3]!]?.state).not.toBe('Replaced');
    // the receipt belongs to the attempt that carried the mined hash
    expect(mapped.receipts[0]?.transactionAttemptId).toBe(ids[3]);
    // without the new fields every attempt still shares the wallet hash, exactly as before
    const plain = mapResult({ ...job, walletResults: [{ ...wallet, attemptHashes: undefined, attemptReplacements: undefined, replacedAttemptIds: undefined }] } as unknown as MintJobResult, 'backend-run', campaign);
    expect(plain.attempts.every((attempt) => attempt.hash === hashB && attempt.replacementOfId === undefined && attempt.state !== 'Replaced')).toBe(true);
  });

  it('does not retain the direct engine execution bypass', async () => {
    const source = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('new MintEngine');
    expect(source).not.toContain('unavailableEngine');
    expect(source).toContain('EXPLICIT_APPROVE_ARM_RUN_REQUIRED');
  });

  it('reconciles one canonical transaction when signed and accepted lifecycle attempts share a hash', () => {
    const common = { executionId: 'execution-1', runId: 'run-1', wallet: '0x1111111111111111111111111111111111111111', nonce: 0, hash: `0x${'a'.repeat(64)}`, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as const;
    const attempts = uniqueSubmittedAttempts([
      { ...common, id: 'execution-1:attempt:0:accepted', state: 'Submitted' },
      { ...common, id: 'execution-1:attempt:signed', state: 'Signed' },
      { ...common, id: 'execution-1:attempt:1:accepted', state: 'Submitted' },
      { ...common, id: 'execution-1:attempt:2:accepted', state: 'Submitted', hash: `0x${'b'.repeat(64)}` },
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.id).toBe('execution-1:attempt:0:accepted');
    expect(attempts[1]?.id).toBe('execution-1:attempt:2:accepted');
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
