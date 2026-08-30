import { describe, expect, it } from 'vitest';
import { FallbackBroadcaster } from './fallback.js';

const signed = '0x1234' as `0x${string}`;

describe('fallback broadcaster', () => {
  it('keeps Ethereum private routing primary and uses public fallback after total failure', async () => {
    const calls: string[] = [];
    const primary = {
      name: 'flashbots',
      broadcast: async () => { calls.push('primary'); return [{ txHash: '0x' as `0x${string}`, endpoint: 'flashbots', latencyMs: 1, success: false, error: 'relay unavailable' }]; },
      warmup: async () => { calls.push('primary-warmup'); },
    };
    const fallback = {
      name: 'blast',
      broadcast: async () => { calls.push('fallback'); return [{ txHash: '0xabc' as `0x${string}`, endpoint: 'rpc', latencyMs: 2, success: true }]; },
      warmup: async () => { calls.push('fallback-warmup'); },
    };
    const broadcaster = new FallbackBroadcaster(primary, fallback);
    const results = await broadcaster.broadcast([signed]);
    expect(calls).toEqual(['primary', 'fallback']);
    expect(results.at(-1)?.success).toBe(true);
  });
});
