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
});
