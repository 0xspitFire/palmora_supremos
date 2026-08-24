/**
 * @module receipt-watcher
 *
 * Transaction receipt watcher with exponential backoff.
 *
 * After a transaction is broadcast, this module polls for the receipt
 * with increasing intervals: 500ms → 1s → 2s → 4s → ... up to maxPollMs.
 *
 * Waits for the configured confirmation depth before returning.
 * Times out after maxWaitMs (default: 120s for L1, 30s for L2).
 */

import type { Hash, PublicClient } from 'viem';
import type { MintReceipt, ReceiptWatcher as IReceiptWatcher } from './types.js';

export interface ReceiptWatcherOptions {
  /** Initial poll interval in ms. Default: 500 */
  initialPollMs?: number;
  /** Maximum poll interval in ms. Default: 8000 */
  maxPollMs?: number;
  /** Maximum total wait time in ms. Default: 120000 (2 minutes) */
  maxWaitMs?: number;
  /** Backoff multiplier. Default: 2 */
  backoffMultiplier?: number;
}

const DEFAULT_OPTIONS: Required<ReceiptWatcherOptions> = {
  initialPollMs: 500,
  maxPollMs: 8_000,
  maxWaitMs: 120_000,
  backoffMultiplier: 2,
};

export class ReceiptWatcherImpl implements IReceiptWatcher {
  private readonly client: PublicClient;
  private readonly options: Required<ReceiptWatcherOptions>;

  constructor(client: PublicClient, options?: ReceiptWatcherOptions) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async waitForReceipt(
    txHash: Hash,
    confirmationDepth: number,
  ): Promise<MintReceipt> {
    const startTime = Date.now();
    let pollInterval = this.options.initialPollMs;

    while (Date.now() - startTime < this.options.maxWaitMs) {
      try {
        const receipt = await this.client.getTransactionReceipt({ hash: txHash });

        if (receipt) {
          // Check confirmation depth
          const currentBlock = await this.client.getBlockNumber();
          const confirmations = Number(currentBlock - receipt.blockNumber) + 1;

          if (confirmations >= confirmationDepth) {
            return {
              txHash,
              status: receipt.status === 'success' ? 'success' : 'reverted',
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.effectiveGasPrice,
              confirmations,
            };
          }

          // Not enough confirmations yet — keep polling but at a shorter interval
          // since we know the tx is included
          pollInterval = this.options.initialPollMs;
        }
      } catch {
        // Receipt not found yet — this is expected, keep polling
      }

      // Wait before next poll
      await sleep(pollInterval);

      // Exponential backoff (capped)
      pollInterval = Math.min(
        pollInterval * this.options.backoffMultiplier,
        this.options.maxPollMs,
      );
    }

    throw new Error(
      `Timeout waiting for receipt of ${txHash} after ${this.options.maxWaitMs}ms`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
