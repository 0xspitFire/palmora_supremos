import { describe, expect, it } from 'vitest';
import type { Hash } from 'viem';
import { BaseFinalityObserver, IndependentBaseFinalityObserver, type BaseFinalitySources } from './finality-observer.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const OTHER = `0x${'2'.repeat(64)}` as Hash;

function sources(input: { receipt?: Hash | null; canonical?: Hash | null; safe?: bigint; finalized?: bigint } = {}): BaseFinalitySources {
  return {
    chainId: 8453,
    currentBlockNumber: async () => 120n,
    receiptBlockHash: async () => input.receipt === undefined ? HASH : input.receipt,
    canonicalBlockHash: async () => input.canonical === undefined ? HASH : input.canonical,
    safeBlockNumber: async () => input.safe ?? 100n,
    finalizedBlockNumber: async () => input.finalized ?? 90n,
  };
}

describe('Base finalized-head policy (D-057)', () => {
  it('reports soft, posted, and Ethereum-final in order', async () => {
    expect(await new BaseFinalityObserver(sources({ safe: 99n, finalized: 98n })).observe({ txHash: HASH, txBlockNumber: 100n })).toMatchObject({ stage: 'soft', canonical: true, ready: false });
    expect(await new BaseFinalityObserver(sources({ safe: 100n, finalized: 99n })).observe({ txHash: HASH, txBlockNumber: 100n })).toMatchObject({ stage: 'posted', canonical: true, ready: false });
    expect(await new BaseFinalityObserver(sources({ safe: 110n, finalized: 100n })).observe({ txHash: HASH, txBlockNumber: 100n })).toMatchObject({ stage: 'ethereum_final', canonical: true, ready: true });
  });

  it('fails closed when canonicality is missing or disagrees', async () => {
    expect(await new BaseFinalityObserver(sources({ receipt: null, safe: 110n, finalized: 110n })).observe({ txHash: HASH, txBlockNumber: 100n })).toMatchObject({ stage: 'soft', canonical: null, ready: false });
    expect(await new BaseFinalityObserver(sources({ canonical: OTHER, safe: 110n, finalized: 110n })).observe({ txHash: HASH, txBlockNumber: 100n })).toMatchObject({ stage: 'soft', canonical: false, ready: false });
  });

  it('refuses use with another chain identity', () => {
    expect(() => new BaseFinalityObserver({ ...sources(), chainId: 1 })).toThrow('BaseFinalityObserver requires chain ID 8453');
  });

  it('requires both configured providers to agree before finality is ready', async () => {
    const primary = new BaseFinalityObserver(sources({ safe: 110n, finalized: 100n }));
    const fallback = new BaseFinalityObserver(sources({ safe: 110n, finalized: 99n }));
    await expect(new IndependentBaseFinalityObserver(primary, fallback).observe({ txHash: HASH, txBlockNumber: 100n })).rejects.toThrow('BASE_PROVIDER_FINALITY_DISAGREEMENT');
    await expect(new IndependentBaseFinalityObserver(primary, new BaseFinalityObserver(sources({ safe: 110n, finalized: 100n }))).observe({ txHash: HASH, txBlockNumber: 100n })).resolves.toMatchObject({ stage: 'ethereum_final', ready: true });
  });
});
