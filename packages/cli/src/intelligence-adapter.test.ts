import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, HttpRequestError, RpcRequestError, TimeoutError, type PublicClient } from 'viem';
import { answeredWithoutName, EngineIntelligencePort } from './intelligence-adapter.js';

/** A fake node that rejects getLogs above a block-range limit, like many providers. */
function node(limit: bigint, calls: Array<[bigint, bigint]>): PublicClient {
  return {
    getBlockNumber: async () => 10_000n,
    getBlock: async () => ({ hash: `0x${'b'.repeat(64)}`, timestamp: 1n }),
    getLogs: async (request: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([request.fromBlock, request.toBlock]);
      if (request.toBlock - request.fromBlock + 1n > limit) throw new Error('Invalid parameters were provided to the RPC method.');
      return [];
    },
  } as unknown as PublicClient;
}

describe('EngineIntelligencePort adaptive block range (T-006)', () => {
  it('halves the range until the provider accepts it, then reports the block actually reached', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const port = new EngineIntelligencePort(node(10n, calls), { initialRange: 100n, maxRange: 500n });
    const outcome = await port.scan(1_000n, 5_000n, []);
    expect(outcome).toMatchObject({ ok: true, scan: { fromBlock: 1_000n, toBlock: 1_005n } });
    expect(port.currentRange()).toBe(6n);
    expect(calls.map(([from, to]) => to - from + 1n)).toEqual([100n, 50n, 25n, 12n, 6n]);
  });

  it('grows the range back after steady success, never above the maximum', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const port = new EngineIntelligencePort(node(1_000n, calls), { initialRange: 100n, maxRange: 150n });
    for (let index = 0; index < 10; index += 1) await port.scan(1n, 5_000n, []);
    expect(port.currentRange()).toBe(150n);
  });

  it('fails only when even a single block is rejected, and refuses invalid range settings', async () => {
    const port = new EngineIntelligencePort(node(0n, []), { initialRange: 4n, maxRange: 4n });
    expect(await port.scan(1n, 100n, [])).toEqual({ ok: false, reason: 'LOGS_UNAVAILABLE: Invalid parameters were provided to the RPC method.' });
    expect(port.currentRange()).toBe(1n);
    expect(() => new EngineIntelligencePort(node(1n, []), { initialRange: 10n, maxRange: 5n })).toThrow('INTELLIGENCE_RANGE_INVALID');
  });

  it('does not shrink the range when the provider is rate-limiting, and reports why a request failed without URLs', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const limited = { ...node(1_000n, calls), getLogs: async (request: { fromBlock: bigint; toBlock: bigint }) => { calls.push([request.fromBlock, request.toBlock]); throw Object.assign(new Error('Too Many Requests at https://rpc.example.com/v2/abcdefabcdefabcdefabcdefabcdefabcdef'), { status: 429 }); } } as unknown as PublicClient;
    const port = new EngineIntelligencePort(limited, { initialRange: 100n, maxRange: 500n });
    const outcome = await port.scan(1n, 5_000n, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/^RATE_LIMITED: HTTP 429: Too Many Requests/);
    expect(outcome.reason).not.toContain('rpc.example.com');
    expect(outcome.reason).not.toContain('abcdefabcdef');
    expect(port.currentRange()).toBe(100n);
    expect(calls).toHaveLength(1);
  });

  it('includes the provider reason when a range is rejected', async () => {
    const port = new EngineIntelligencePort(node(0n, []), { initialRange: 2n, maxRange: 2n });
    const outcome = await port.scan(1n, 100n, []);
    expect(outcome).toEqual({ ok: false, reason: 'LOGS_UNAVAILABLE: Invalid parameters were provided to the RPC method.' });
  });
});

/** A real viem client over a scripted node, so the error classes are the ones viem really raises. */
function nodeAnswering(answer: () => unknown, calls: string[] = []): PublicClient {
  return createPublicClient({ transport: custom({ request: async ({ method }: { method: string }) => { calls.push(method); if (method !== 'eth_call') throw new Error(`unexpected ${method}`); return answer(); } }) }) as unknown as PublicClient;
}
const NFT = '0x3333333333333333333333333333333333333333';
const encodedName = (name: string): string => encodeAbiParameters([{ type: 'string' }], [name]);

describe('EngineIntelligencePort.readName (T-029)', () => {
  it('reads the collection name from the contract with one read-only eth_call', async () => {
    const calls: string[] = [];
    const port = new EngineIntelligencePort(nodeAnswering(() => encodedName('Pudgy Example'), calls));
    expect(await port.readName(NFT)).toEqual({ status: 'name', name: 'Pudgy Example' });
    expect(calls).toEqual(['eth_call']);
  });

  it('says "none" when the contract answers without a usable name: empty name, no such function, or a revert', async () => {
    expect(await new EngineIntelligencePort(nodeAnswering(() => encodedName(''))).readName(NFT)).toEqual({ status: 'none' });
    expect(await new EngineIntelligencePort(nodeAnswering(() => '0x')).readName(NFT)).toEqual({ status: 'none' });
    const reverted = (): never => { throw new RpcRequestError({ body: {}, url: 'http://node.invalid', error: { code: 3, message: 'execution reverted', data: '0x' } }); };
    expect(await new EngineIntelligencePort(nodeAnswering(reverted)).readName(NFT)).toEqual({ status: 'none' });
  });

  it('says "error" when the node could not be asked, so the read is tried again later', async () => {
    const down = (): never => { throw new HttpRequestError({ url: 'http://node.invalid', body: {}, cause: new Error('ECONNRESET') }); };
    const slow = (): never => { throw new TimeoutError({ url: 'http://node.invalid', body: {} }); };
    const boom = (): never => { throw new Error('socket hang up'); };
    const limited = (): never => { throw new HttpRequestError({ url: 'http://node.invalid', body: {}, status: 429 }); };
    for (const failure of [down, slow, boom, limited]) expect(await new EngineIntelligencePort(nodeAnswering(failure)).readName(NFT)).toEqual({ status: 'error' });
  });

  it('refuses a malformed address without calling the node', async () => {
    const calls: string[] = [];
    expect(await new EngineIntelligencePort(nodeAnswering(() => encodedName('x'), calls)).readName('0x12')).toEqual({ status: 'none' });
    expect(calls).toEqual([]);
  });

  it('classifies only errors that carry a viem cause chain: anything else is "could not ask"', () => {
    expect(answeredWithoutName(new Error('plain'))).toBe(false);
    expect(answeredWithoutName(null)).toBe(false);
    expect(answeredWithoutName({ walk: () => null })).toBe(false);
  });
});
