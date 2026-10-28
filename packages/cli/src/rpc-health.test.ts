import { describe, expect, it } from 'vitest';
import { checkChainRpc, providerGroup, renderRpcHealth, type ReadEndpoint } from './rpc-health.js';

const A = 'https://eth-mainnet.alpha.example/v2/SECRET-KEY-A';
const B = 'https://mainnet.beta.example/SECRET-KEY-B';
const C = 'https://rpc2.alpha.example/SECRET-KEY-C';

function reader(table: Record<string, { chainId?: number; block?: bigint } | Error>): ReadEndpoint {
  return async (url) => {
    const entry = table[url];
    if (!entry) throw new Error('connect ECONNREFUSED');
    if (entry instanceof Error) throw entry;
    return { chainId: entry.chainId ?? 1, block: entry.block ?? 100n };
  };
}

describe('rpc-health', () => {
  it('is failover ready with two independent working providers that agree', async () => {
    const result = await checkChainRpc({ chainId: 1, slots: [{ name: 'ETHEREUM_RPC_URL', urls: [A] }, { name: 'ETHEREUM_RPC_FBACK', urls: [B] }], read: reader({ [A]: { block: 100n }, [B]: { block: 101n } }) });
    expect(result.failoverReady).toBe(true);
    expect(result.independentProviders).toBe(2);
    expect(result.blockSpread).toBe(1);
  });

  it('does not count two keys at the same provider as independent', async () => {
    const result = await checkChainRpc({ chainId: 1, slots: [{ name: 'ETHEREUM_RPC_URL', urls: [A] }, { name: 'ETHEREUM_RPC_FBACK', urls: [C] }], read: reader({ [A]: {}, [C]: {} }) });
    expect(result.failoverReady).toBe(false);
    expect(result.independentProviders).toBe(1);
    expect(result.slots[0]?.sameProviderAs).toEqual(['ETHEREUM_RPC_FBACK']);
  });

  it('fails closed on a wrong chain, a dead slot, an empty slot and a lagging provider', async () => {
    const wrong = await checkChainRpc({ chainId: 8453, slots: [{ name: 'BASE_RPC_URL', urls: [A] }, { name: 'BASE_RPC_FBACK', urls: [B] }], read: reader({ [A]: { chainId: 8453 }, [B]: { chainId: 1 } }) });
    expect(wrong.slots[1]).toMatchObject({ working: false, failure: 'wrong_chain' });
    expect(wrong.failoverReady).toBe(false);

    const mixed = await checkChainRpc({ chainId: 4663, slots: [{ name: 'ROBINHOOD_RPC_URL', urls: [A] }, { name: 'ROBINHOOD_RPC_FBACK', urls: [] }], read: reader({ [A]: { chainId: 4663 } }) });
    expect(mixed.slots[1]).toMatchObject({ configured: false, working: false });
    expect(mixed.failoverReady).toBe(false);

    const lagging = await checkChainRpc({ chainId: 1, slots: [{ name: 'ETHEREUM_RPC_URL', urls: [A] }, { name: 'ETHEREUM_RPC_FBACK', urls: [B] }], read: reader({ [A]: { block: 100n }, [B]: { block: 150n } }) });
    expect(lagging.failoverReady).toBe(false);
    expect(lagging.notes.join(' ')).toMatch(/disagree/);

    const none = await checkChainRpc({ chainId: 1, slots: [], read: reader({}) });
    expect(none).toMatchObject({ failoverReady: false, blockSpread: null });
  });

  it('classifies a rate limit and a timeout without leaking the endpoint', async () => {
    const result = await checkChainRpc({ chainId: 1, slots: [{ name: 'ETHEREUM_RPC_URL', urls: [A] }, { name: 'ETHEREUM_RPC_FBACK', urls: [B] }], read: reader({ [A]: Object.assign(new Error('429 Too Many Requests'), { status: 429 }), [B]: new Error('request timed out') }) });
    expect(result.slots.map((slot) => slot.failure)).toEqual(['rate_limited', 'timeout']);
    const text = JSON.stringify(result) + renderRpcHealth([result]);
    expect(text).not.toMatch(/SECRET-KEY|alpha\.example|beta\.example|https?:/);
  });

  it('tries the next url in a slot before calling the slot dead', async () => {
    const result = await checkChainRpc({ chainId: 1, slots: [{ name: 'ETHEREUM_RPC_URL', urls: [A, B] }], read: reader({ [B]: {} }) });
    expect(result.slots[0]?.working).toBe(true);
  });

  it('derives a coarse provider group only for comparison', () => {
    expect(providerGroup(A)).toBe('alpha.example');
    expect(providerGroup('not a url')).toBeUndefined();
  });
});
