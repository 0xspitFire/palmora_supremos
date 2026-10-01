import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { classifyFailure, probeRpc } from './rpc-probe.js';

function fakeClient(behaviour: { limitAbove?: number; failAll?: boolean; slowMs?: number }): { client: PublicClient; calls: () => number; inflightMax: () => number } {
  let calls = 0; let inflight = 0; let maxInflight = 0;
  const run = async (): Promise<unknown> => {
    calls += 1; inflight += 1; maxInflight = Math.max(maxInflight, inflight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (behaviour.failAll && calls > 1) throw Object.assign(new Error('Internal error'), { status: 500 });
      if (behaviour.limitAbove !== undefined && maxInflight > behaviour.limitAbove) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      return 1n;
    } finally { inflight -= 1; }
  };
  const client = { getBlockNumber: async () => run().then(() => 100n), getLogs: async () => run().then(() => []) } as unknown as PublicClient;
  return { client, calls: () => calls, inflightMax: () => maxInflight };
}

describe('RPC load probe (read-only)', () => {
  it('climbs through the levels and reports clean when the provider keeps up', async () => {
    const { client, inflightMax } = fakeClient({});
    const result = await probeRpc(client, { levels: [1, 4], requestsPerLevel: 8 });
    expect(result.levels.map((level) => [level.concurrency, level.ok, level.requests])).toEqual([[1, 8, 8], [4, 8, 8]]);
    expect(result).toMatchObject({ cleanUpToConcurrency: 4, firstRateLimitAtConcurrency: null, stoppedEarly: false, totalRequests: 16 });
    expect(inflightMax()).toBeLessThanOrEqual(5);
    expect(result.summary).toContain('Clean with up to 4 request(s) at once');
  });

  it('stops climbing at the first rate limit instead of hammering the provider', async () => {
    const { client } = fakeClient({ limitAbove: 2 });
    const result = await probeRpc(client, { levels: [1, 5, 15], requestsPerLevel: 10 });
    expect(result.firstRateLimitAtConcurrency).toBe(5);
    expect(result.levels).toHaveLength(2);
    expect(result.stoppedEarly).toBe(true);
    expect(result.cleanUpToConcurrency).toBe(1);
    expect(result.summary).toContain('rate limiting began at 5 at once');
  });

  it('reports a failing provider and refuses invalid options and over-large probes', async () => {
    const failing = await probeRpc(fakeClient({ failAll: true }).client, { levels: [1, 3], requestsPerLevel: 6 });
    expect(failing.cleanUpToConcurrency).toBeNull();
    expect(failing.levels[0]?.failures.other).toBe(6);
    expect(failing.summary).toContain('Even the first step had failures');
    await expect(probeRpc(fakeClient({}).client, { levels: [0] })).rejects.toThrow('PROBE_OPTIONS_INVALID');
    await expect(probeRpc(fakeClient({}).client, { requestsPerLevel: 101 })).rejects.toThrow('PROBE_OPTIONS_INVALID');
    const capped = await probeRpc(fakeClient({}).client, { levels: [1, 2, 3, 4], requestsPerLevel: 100 });
    expect(capped.totalRequests).toBe(300);
    expect(capped.stoppedEarly).toBe(true);
  });

  it('classifies failures without exposing the URL', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { status: 429 }))).toBe('rate_limited');
    expect(classifyFailure(new Error('The request timed out.'))).toBe('timeout');
    expect(classifyFailure(new Error('boom https://rpc.example/key'))).toBe('other');
  });
});
