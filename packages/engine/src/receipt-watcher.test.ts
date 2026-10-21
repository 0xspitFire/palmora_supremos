import { describe, expect, it } from 'vitest';
import type { Hash, PublicClient } from 'viem';
import { ReceiptReorgedError, ReceiptWatcherImpl } from './receipt-watcher.js';

const hash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash;
const blockHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash;

describe('receipt watcher recovery boundaries', () => {
  it('propagates a non-canonical receipt immediately instead of swallowing it as polling lag', async () => {
    const client = {
      getTransactionReceipt: async () => ({
        transactionHash: hash,
        blockHash,
        blockNumber: 42n,
        status: 'success',
        gasUsed: 21_000n,
        effectiveGasPrice: 2n,
      }),
      getBlockNumber: async () => 42n,
    } as unknown as PublicClient;
    const watcher = new ReceiptWatcherImpl(client, {
      initialPollMs: 1,
      maxPollMs: 1,
      maxWaitMs: 5_000,
      finalityPolicy: { stages: ['confirmed'], settlementStage: 'confirmed' },
      finalityObserver: {
        observe: async () => ({
          chainId: 1 as const,
          stage: 'confirmed' as const,
          ready: false,
          canonical: false,
          observedAt: new Date(),
        }),
      },
    });

    await expect(watcher.waitForReceipt(hash, 1)).rejects.toBeInstanceOf(ReceiptReorgedError);
  });

  it('refuses Base settlement when the independent provider disagrees on receipt facts', async () => {
    const receipt = { transactionHash: hash, blockHash, blockNumber: 42n, status: 'success', gasUsed: 21_000n, effectiveGasPrice: 2n, l1Fee: 3n, operatorFee: 4n };
    const client = { getTransactionReceipt: async () => receipt, getBlockNumber: async () => 42n } as unknown as PublicClient;
    const fallback = { getTransactionReceipt: async () => ({ ...receipt, gasUsed: 21_001n }) } as unknown as PublicClient;
    const watcher = new ReceiptWatcherImpl(client, { chainId: 8453, baseFallbackClient: fallback, initialPollMs: 1, maxPollMs: 1, maxWaitMs: 100, finalityPolicy: { stages: ['soft', 'posted', 'ethereum_final'], settlementStage: 'ethereum_final' }, finalityObserver: { observe: async () => ({ chainId: 8453 as const, stage: 'ethereum_final' as const, ready: true, canonical: true, observedAt: new Date() }) } });
    await expect(watcher.waitForReceipt(hash, 1)).rejects.toThrow('BASE_PROVIDER_RECEIPT_DISAGREEMENT');
  });

  it('normalizes equivalent Base fee quantities before comparing providers', async () => {
    const primaryReceipt = { transactionHash: hash, blockHash, blockNumber: 42n, status: 'success', gasUsed: 21_000n, effectiveGasPrice: 2n, l1Fee: '0x3', operatorFee: '0x4' };
    const fallbackReceipt = { ...primaryReceipt, l1Fee: 3n, operatorFee: undefined };
    const client = { getTransactionReceipt: async () => primaryReceipt, getBlockNumber: async () => 42n } as unknown as PublicClient;
    const fallback = { getTransactionReceipt: async () => fallbackReceipt, readContract: async () => 4n } as unknown as PublicClient;
    const watcher = new ReceiptWatcherImpl(client, { chainId: 8453, baseFallbackClient: fallback, initialPollMs: 1, maxPollMs: 1, maxWaitMs: 100, finalityPolicy: { stages: ['soft', 'posted', 'ethereum_final'], settlementStage: 'ethereum_final' }, finalityObserver: { observe: async () => ({ chainId: 8453 as const, stage: 'ethereum_final' as const, ready: true, canonical: true, observedAt: new Date() }) } });
    await expect(watcher.waitForReceipt(hash, 1)).resolves.toMatchObject({ l1DataFeeWei: 3n, operatorFeeWei: 4n });
  });

  it('refuses Base settlement when normalized fee components differ', async () => {
    const primaryReceipt = { transactionHash: hash, blockHash, blockNumber: 42n, status: 'success', gasUsed: 21_000n, effectiveGasPrice: 2n, l1Fee: '0x3', operatorFee: '0x4' };
    const fallbackReceipt = { ...primaryReceipt, l1Fee: 4n, operatorFee: 4n };
    const client = { getTransactionReceipt: async () => primaryReceipt, getBlockNumber: async () => 42n } as unknown as PublicClient;
    const fallback = { getTransactionReceipt: async () => fallbackReceipt } as unknown as PublicClient;
    const watcher = new ReceiptWatcherImpl(client, { chainId: 8453, baseFallbackClient: fallback, initialPollMs: 1, maxPollMs: 1, maxWaitMs: 100, finalityPolicy: { stages: ['soft', 'posted', 'ethereum_final'], settlementStage: 'ethereum_final' }, finalityObserver: { observe: async () => ({ chainId: 8453 as const, stage: 'ethereum_final' as const, ready: true, canonical: true, observedAt: new Date() }) } });
    await expect(watcher.waitForReceipt(hash, 1)).rejects.toThrow('BASE_PROVIDER_FEE_DISAGREEMENT');
  });
});
