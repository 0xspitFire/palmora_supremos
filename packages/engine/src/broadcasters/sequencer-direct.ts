/**
 * @module broadcasters/sequencer-direct
 *
 * Direct-to-sequencer broadcaster for L2 chains (Base, Robinhood).
 *
 * On L2s with a single sequencer, ordering is FCFS —
 * client-side latency to the sequencer genuinely matters here.
 * This broadcaster sends directly to the sequencer endpoint,
 * optionally combined with blast for redundancy.
 */

import type { Hex, Hash } from 'viem';
import type { Broadcaster, BroadcastResult, BroadcastOptions } from '../types.js';

export class SequencerDirectBroadcaster implements Broadcaster {
  readonly name = 'sequencer-direct';
  private readonly sequencerUrl: string;
  private readonly fallbackUrls: readonly string[];

  constructor(sequencerUrl: string, fallbackUrls: readonly string[] = []) {
    this.sequencerUrl = sequencerUrl;
    this.fallbackUrls = fallbackUrls;
  }

  async broadcast(signedTxs: Hex[], _opts?: BroadcastOptions): Promise<BroadcastResult[]> {
    const allResults: BroadcastResult[] = [];

    for (const signedTx of signedTxs) {
      // Send to sequencer first (lowest latency), then fallbacks in parallel
      const allUrls = [this.sequencerUrl, ...this.fallbackUrls];
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [signedTx],
      });

      const promises = allUrls.map(async (url): Promise<BroadcastResult> => {
        const startTime = performance.now();
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          const data = await response.json() as { result?: Hash; error?: { message: string } };
          const latencyMs = performance.now() - startTime;

          if (data.result) {
            return { txHash: data.result, endpoint: url, latencyMs, success: true };
          }
          return {
            txHash: '0x' as Hash, endpoint: url, latencyMs, success: false,
            error: data.error?.message ?? 'Unknown error',
          };
        } catch (err) {
          return {
            txHash: '0x' as Hash, endpoint: url, latencyMs: performance.now() - startTime,
            success: false, error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      const results = await Promise.all(promises);
      allResults.push(...results);
    }

    return allResults;
  }

  async warmup(): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [],
    });

    const urls = [this.sequencerUrl, ...this.fallbackUrls];
    await Promise.allSettled(
      urls.map((url) =>
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      ),
    );
  }
}
