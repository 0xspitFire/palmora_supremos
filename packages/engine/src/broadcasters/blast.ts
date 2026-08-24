/**
 * @module broadcasters/blast
 *
 * Multi-endpoint parallel blast broadcaster.
 *
 * Ported from solotop999/opensea-nft-public-mint rpc-blast.ts.
 * Key optimization: pre-serialize the JSON-RPC request body and headers
 * BEFORE T-0, so the hot path is pure network I/O.
 *
 * For each signed tx, fires eth_sendRawTransaction to ALL configured
 * endpoints in parallel. First successful response wins.
 *
 * This is the L2 primary broadcast path where latency-to-sequencer matters.
 */

import type { Hex, Hash } from 'viem';
import type { Broadcaster, BroadcastResult, BroadcastOptions } from '../types.js';

/** Pre-computed blast payload for a single endpoint. */
interface BlastPayload {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export class BlastBroadcaster implements Broadcaster {
  readonly name = 'blast';
  private readonly endpoints: readonly string[];
  private warmAgent: unknown = null; // HTTP agent for keep-alive (set during warmup)

  constructor(endpoints: readonly string[]) {
    if (endpoints.length === 0) {
      throw new Error('BlastBroadcaster requires at least one endpoint');
    }
    this.endpoints = endpoints;
  }

  /**
   * Pre-compute the blast payloads for a signed transaction.
   * Call this BEFORE T-0 so the hot path is pure network I/O.
   */
  prepareBlast(signedTx: Hex): BlastPayload[] {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendRawTransaction',
      params: [signedTx],
    });

    return this.endpoints.map((url) => ({
      url,
      body,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  async broadcast(signedTxs: Hex[], _opts?: BroadcastOptions): Promise<BroadcastResult[]> {
    const allResults: BroadcastResult[] = [];

    for (const signedTx of signedTxs) {
      const payloads = this.prepareBlast(signedTx);
      const results = await this.fireBlast(payloads);
      allResults.push(...results);
    }

    return allResults;
  }

  /**
   * Pre-warm connections to all endpoints.
   * Sends lightweight eth_chainId calls to establish and keep-alive HTTP connections.
   */
  async warmup(): Promise<void> {
    const warmupBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'eth_chainId',
      params: [],
    });

    const warmupPromises = this.endpoints.map(async (url) => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: warmupBody,
        });
      } catch {
        // Warmup failure is non-fatal — the endpoint may still work at fire time
      }
    });

    await Promise.allSettled(warmupPromises);
  }

  /**
   * Fire pre-computed payloads to all endpoints in parallel.
   * Returns results from all endpoints (the caller picks the best).
   */
  private async fireBlast(payloads: BlastPayload[]): Promise<BroadcastResult[]> {
    const promises = payloads.map(async (payload): Promise<BroadcastResult> => {
      const startTime = performance.now();

      try {
        const response = await fetch(payload.url, {
          method: 'POST',
          headers: payload.headers,
          body: payload.body,
        });

        const data = await response.json() as { result?: Hash; error?: { message: string } };
        const latencyMs = performance.now() - startTime;

        if (data.result) {
          return {
            txHash: data.result,
            endpoint: payload.url,
            latencyMs,
            success: true,
          };
        }

        return {
          txHash: '0x' as Hash,
          endpoint: payload.url,
          latencyMs,
          success: false,
          error: data.error?.message ?? 'Unknown error',
        };
      } catch (err) {
        return {
          txHash: '0x' as Hash,
          endpoint: payload.url,
          latencyMs: performance.now() - startTime,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return Promise.all(promises);
  }
}
