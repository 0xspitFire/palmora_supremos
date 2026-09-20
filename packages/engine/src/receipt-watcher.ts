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
import type { FinalityPolicy, FinalityStage, MintReceipt, ReceiptWatcher as IReceiptWatcher } from './types.js';
import type { FinalityObserver } from './finality-observer.js';

export interface ReceiptWatcherOptions {
  /** Initial poll interval in ms. Default: 500 */
  initialPollMs?: number;
  /** Maximum poll interval in ms. Default: 8000 */
  maxPollMs?: number;
  /** Maximum total wait time in ms. Default: 120000 (2 minutes) */
  maxWaitMs?: number;
  /** Backoff multiplier. Default: 2 */
  backoffMultiplier?: number;
  /** Chain-specific finality. L2 success requires the settlement stage. */
  finalityPolicy?: FinalityPolicy;
  /** Observer that advances staged L2 finality; absent means only soft is known. */
  finalityObserver?: FinalityObserver | ((txHash: Hash, blockNumber: bigint) => Promise<FinalityStage>);
}

export class ReceiptReorgedError extends Error {
  public constructor(
    public readonly txHash: Hash,
    public readonly blockNumber: bigint,
  ) {
    super(`Receipt for ${txHash} is no longer canonical`);
    this.name = 'ReceiptReorgedError';
  }
}

export class ReceiptTimeoutError extends Error {
  public constructor(public readonly txHash: Hash, public readonly waitedMs: number) {
    super(`Timeout waiting for receipt of ${txHash} after ${waitedMs}ms`);
    this.name = 'ReceiptTimeoutError';
  }
}

type ResolvedReceiptWatcherOptions =
  Required<Omit<ReceiptWatcherOptions, 'finalityObserver'>> &
  Pick<ReceiptWatcherOptions, 'finalityObserver'>;

const DEFAULT_OPTIONS: ResolvedReceiptWatcherOptions = {
  initialPollMs: 500,
  maxPollMs: 8_000,
  maxWaitMs: 120_000,
  backoffMultiplier: 2,
  finalityPolicy: { stages: ['confirmed'], settlementStage: 'confirmed' },
  finalityObserver: undefined,
};

export class ReceiptWatcherImpl implements IReceiptWatcher {
  private readonly client: PublicClient;
  private readonly options: ResolvedReceiptWatcherOptions;

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
            const observation = this.options.finalityObserver
              ? 'observe' in this.options.finalityObserver
                ? await this.options.finalityObserver.observe({ txHash, txBlockNumber: receipt.blockNumber })
                : { stage: await this.options.finalityObserver(txHash, receipt.blockNumber), ready: true }
              : undefined;
            const finalityStage = observation?.stage ?? (
              this.options.finalityPolicy.stages.includes('soft')
                ? this.options.finalityPolicy.stages[0]!
                : this.options.finalityPolicy.settlementStage
            );
            if (observation && 'canonical' in observation && observation.canonical === false) {
              throw new ReceiptReorgedError(txHash, receipt.blockNumber);
            }
            if ((observation && !observation.ready) || finalityStage !== this.options.finalityPolicy.settlementStage) {
              pollInterval = this.options.initialPollMs;
              await sleep(pollInterval);
              continue;
            }
            const componentReceipt = receipt as typeof receipt & {
              l1Fee?: bigint;
              l1DataFee?: bigint;
              priorityFeeComponentWei?: bigint;
            };
            return {
              txHash,
              status: receipt.status === 'success' ? 'success' : 'reverted',
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.effectiveGasPrice,
              ...(componentReceipt.l1DataFee === undefined && componentReceipt.l1Fee === undefined
                ? {}
                : { l1DataFeeWei: componentReceipt.l1DataFee ?? componentReceipt.l1Fee }),
              ...(componentReceipt.priorityFeeComponentWei === undefined
                ? {}
                : { priorityFeeComponentWei: componentReceipt.priorityFeeComponentWei }),
              confirmations,
              finalityStage,
            };
          }

          // Not enough confirmations yet — keep polling but at a shorter interval
          // since we know the tx is included
          pollInterval = this.options.initialPollMs;
        }
      } catch (error) {
        if (error instanceof ReceiptReorgedError) throw error;
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

    throw new ReceiptTimeoutError(txHash, this.options.maxWaitMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
