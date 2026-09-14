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

  it('retains an ambiguous hash when the fallback throws after primary failure', async () => {
    const primary = {
      name: 'flashbots',
      broadcast: async () => [{ txHash: '0x' as `0x${string}`, endpoint: 'flashbots', latencyMs: 1, success: false, error: 'relay unavailable' }],
    };
    const fallback = {
      name: 'public-mempool',
      broadcast: async () => { throw new Error('transport closed after send'); },
    };
    const results = await new FallbackBroadcaster(primary, fallback).broadcast([signed]);
    expect(results).toHaveLength(2);
    expect(results.at(-1)?.ambiguous).toBe(true);
    expect(results.at(-1)?.txHash).not.toBe('0x');
    expect(results.at(-1)?.responseClass).toBe('ambiguous');
  });
});
