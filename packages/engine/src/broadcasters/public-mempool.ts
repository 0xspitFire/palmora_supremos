/**
 * @module broadcasters/public-mempool
 *
 * Single-RPC public mempool broadcaster.
 * The simplest broadcast path — sends via eth_sendRawTransaction to one endpoint.
 *
 * Used as:
 * - Fallback when Flashbots/blast is unavailable
 * - Default for simple/test scenarios
 * - L2 single-sequencer submission (wrapped by SequencerDirectBroadcaster)
 */

import type { Hex, Hash } from 'viem';
import type { Broadcaster, BroadcastResult, BroadcastOptions } from '../types.js';

export class PublicMempoolBroadcaster implements Broadcaster {
  readonly name = 'public-mempool';
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async broadcast(signedTxs: Hex[], _opts?: BroadcastOptions): Promise<BroadcastResult[]> {
    const results: BroadcastResult[] = [];

    for (const signedTx of signedTxs) {
      const startTime = performance.now();

      try {
        const response = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendRawTransaction',
            params: [signedTx],
          }),
        });

        const data = await response.json() as { result?: Hash; error?: { message: string } };
        const latencyMs = performance.now() - startTime;

        if (data.result) {
          results.push({
            txHash: data.result,
            endpoint: this.rpcUrl,
            latencyMs,
            success: true,
          });
        } else {
          results.push({
            txHash: '0x' as Hash,
            endpoint: this.rpcUrl,
            latencyMs,
            success: false,
            error: data.error?.message ?? 'Unknown RPC error',
          });
        }
      } catch (err) {
        const latencyMs = performance.now() - startTime;
        results.push({
          txHash: '0x' as Hash,
          endpoint: this.rpcUrl,
          latencyMs,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
