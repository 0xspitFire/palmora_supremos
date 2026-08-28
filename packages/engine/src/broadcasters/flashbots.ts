/**
 * @module broadcasters/flashbots
 *
 * Flashbots relay bundle broadcaster for Ethereum L1.
 *
 * This is the L1 PRIMARY submission path (not optional — see §6 correction #2).
 *
 * Key benefits over public mempool:
 * 1. Revert protection — a bundle that would revert is simply not included,
 *    so you pay zero gas on failure. For a fixed-price mint, this matters
 *    more than anti-frontrun protection.
 * 2. MEV protection — tx is not visible in the public mempool.
 * 3. Pre-trade privacy — block builders see the tx only if they include it.
 *
 * Protocol:
 * - Signs the JSON-RPC payload with a Flashbots auth key (NOT a wallet key)
 * - Submits to the Flashbots relay via eth_sendBundle
 * - Targets a specific block number
 * - Bundle is retried automatically for a few blocks if not included
 */

import { type Hex, type Hash, keccak256, toHex } from 'viem';
import type { Broadcaster, BroadcastResult, BroadcastOptions, FlashbotsAuthSigner } from '../types.js';

export interface FlashbotsConfig {
  /** Flashbots relay URL. Default: https://relay.flashbots.net */
  relayUrl?: string;
  /** Dedicated auth signer. Raw private keys must never enter this config. */
  authSigner: FlashbotsAuthSigner;
  /** Number of consecutive blocks to target. Default: 3 */
  blockRange?: number;
}

export class FlashbotsBroadcaster implements Broadcaster {
  readonly name = 'flashbots';
  private readonly relayUrl: string;
  private readonly authSigner: FlashbotsAuthSigner;
  private readonly blockRange: number;

  constructor(config: FlashbotsConfig) {
    this.relayUrl = config.relayUrl ?? 'https://relay.flashbots.net';
    this.authSigner = config.authSigner;
    this.blockRange = config.blockRange ?? 3;
  }

  async broadcast(signedTxs: Hex[], opts?: BroadcastOptions): Promise<BroadcastResult[]> {
    if (!opts?.targetBlock) {
      throw new Error('FlashbotsBroadcaster requires opts.targetBlock');
    }

    const results: BroadcastResult[] = [];

    // Submit bundle for each target block in the range
    for (let blockOffset = 0; blockOffset < this.blockRange; blockOffset++) {
      const targetBlock = opts.targetBlock + BigInt(blockOffset);
      const startTime = performance.now();

      try {
        const submitted = await this.sendBundle(signedTxs, targetBlock);
        const latencyMs = performance.now() - startTime;

        results.push({
          txHash: submitted.txHash,
          endpoint: this.relayUrl,
          latencyMs,
          success: true,
          providerReference: submitted.bundleHash,
        });
      } catch (err) {
        const latencyMs = performance.now() - startTime;
        results.push({
          txHash: '0x' as Hash,
          endpoint: this.relayUrl,
          latencyMs,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  /**
   * Submit a bundle to the Flashbots relay.
   *
   * Uses the eth_sendBundle JSON-RPC method with Flashbots signature authentication.
   */
  private async sendBundle(signedTxs: Hex[], targetBlock: bigint): Promise<{ txHash: Hash; bundleHash: Hash }> {
    const params = {
      txs: signedTxs,
      blockNumber: toHex(targetBlock),
    };

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendBundle',
      params: [params],
    });

    // Sign the request body for Flashbots authentication
    const bodyHash = keccak256(toHex(body));
    const signature = await this.authSigner.signMessage(bodyHash);

    const authHeader = `${this.authSigner.address}:${signature}`;

    const response = await fetch(this.relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flashbots-Signature': authHeader,
      },
      body,
    });

    const data = await response.json() as {
      result?: { bundleHash: Hash };
      error?: { message: string; code: number };
    };

    if (data.error) {
      throw new Error(`Flashbots relay error: ${data.error.message} (code: ${data.error.code})`);
    }

    if (!data.result?.bundleHash) {
      throw new Error('Flashbots relay returned no bundle hash');
    }

    return { txHash: keccak256(signedTxs[0]!), bundleHash: data.result.bundleHash };
  }
}
