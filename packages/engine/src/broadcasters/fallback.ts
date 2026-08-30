import type { Hex } from 'viem';
import type { Broadcaster, BroadcastOptions, BroadcastResult } from '../types.js';

/** Use the approved primary route first, then fall back only on total failure. */
export class FallbackBroadcaster implements Broadcaster {
  public readonly name: Broadcaster['name'];

  public constructor(private readonly primary: Broadcaster, private readonly fallback: Broadcaster) {
    this.name = primary.name;
  }

  public async broadcast(signedTxs: Hex[], options?: BroadcastOptions): Promise<BroadcastResult[]> {
    let primaryResults: BroadcastResult[];
    try {
      primaryResults = await this.primary.broadcast(signedTxs, options);
    } catch (error) {
      primaryResults = signedTxs.map(() => ({ txHash: '0x' as `0x${string}`, endpoint: this.primary.name, latencyMs: 0, success: false, error: error instanceof Error ? error.name : 'primary_broadcast_failed' }));
    }
    if (primaryResults.some((result) => result.success)) return primaryResults;
    const fallbackResults = await this.fallback.broadcast(signedTxs, options);
    return [...primaryResults, ...fallbackResults];
  }

  public async warmup(): Promise<void> {
    await Promise.allSettled([
      this.primary.warmup?.(),
      this.fallback.warmup?.(),
    ]);
  }
}
