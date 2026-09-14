import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliRuntime } from './runtime.js';
import { paidRunMintValueCapEth } from './engine-adapter.js';
import type { Campaign } from '@mint-bot/backend';

describe('CLI integration boundary', () => {
  it('derives a positive paid mint-value cap from the campaign run policy', () => {
    const campaign: Campaign = { id: 'campaign-paid', state: 'Draft', chainId: 1, contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', strategy: 'seadrop-v1-public', quantity: 1, dryRun: false, spendPolicy: { maxRunWei: 2_000_000_000_000_000_000n, dailyCapWei: 2_000_000_000_000_000_000n, gasCeilingWei: 100_000_000_000_000_000n }, chainVerification: { chainId: 1, status: 'verified', seaDropCompatible: true, endpointReference: 'ETH_FEED_REFERENCE' }, mintPriceWei: 1_000_000_000_000_000_000n, feePolicy: { kind: 'paid', configuredPriorityFeeWei: 1_000_000_000_000_000n, l2ExecutionGasBudgetWei: 0n, l1DataGasBudgetWei: 0n, totalFeeBudgetWei: 1_000_000_000_000_000n }, broadcastMode: 'public', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    expect(paidRunMintValueCapEth(campaign)).toBe(2);
  });

  it('does not retain the direct engine execution bypass', async () => {
    const source = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('new MintEngine');
    expect(source).not.toContain('unavailableEngine');
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
    } finally {
      if ('close' in runtime.store && typeof runtime.store.close === 'function') runtime.store.close();
      await import('node:fs/promises').then(({ rm }) => rm(statePath, { force: true }));
    }
  });
});
