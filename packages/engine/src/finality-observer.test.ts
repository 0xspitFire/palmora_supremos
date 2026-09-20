import { describe, expect, it } from 'vitest';
import { EthereumFinalityObserver, RobinhoodFinalityObserver } from './finality-observer.js';

const hash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const blockHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

describe('finality observers', () => {
  it('marks Ethereum final at the configured confirmation depth', async () => {
    const observer = new EthereumFinalityObserver({ chainId: 1, currentBlockNumber: async () => 12n, expectedBlockHash: blockHash, receiptBlockHash: async () => blockHash }, 2, () => new Date('2026-09-18T00:00:00.000Z'));
    const result = await observer.observe({ txHash: hash, txBlockNumber: 11n });
    expect(result).toMatchObject({ chainId: 1, stage: 'confirmed', canonical: true, ready: true });
  });

  it('does not mark Ethereum final before confirmations', async () => {
    const observer = new EthereumFinalityObserver({ chainId: 1, currentBlockNumber: async () => 11n, expectedBlockHash: blockHash, receiptBlockHash: async () => blockHash }, 2);
    expect((await observer.observe({ txHash: hash, txBlockNumber: 11n })).ready).toBe(false);
  });

  it('retains Robinhood soft and posted states until an L1 finality probe passes', async () => {
    let posted = false;
    let ethereumFinal = false;
    const observer = new RobinhoodFinalityObserver({
      chainId: 4663,
      currentBlockNumber: async () => 20n,
      expectedBlockHash: blockHash,
      receiptBlockHash: async () => blockHash,
      isPosted: async () => posted,
      isEthereumFinal: async () => ethereumFinal,
    }, 1);
    expect((await observer.observe({ txHash: hash, txBlockNumber: 20n })).stage).toBe('soft');
    posted = true;
    expect((await observer.observe({ txHash: hash, txBlockNumber: 20n })).stage).toBe('posted');
    ethereumFinal = true;
    expect((await observer.observe({ txHash: hash, txBlockNumber: 20n })).ready).toBe(true);
    expect((await observer.observe({ txHash: hash, txBlockNumber: 20n })).stage).toBe('ethereum_final');
  });

  it('detects a non-canonical receipt as not ready', async () => {
    const observer = new RobinhoodFinalityObserver({
      chainId: 4663,
      currentBlockNumber: async () => 20n,
      expectedBlockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      receiptBlockHash: async () => '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      isPosted: async () => true,
      isEthereumFinal: async () => true,
    }, 1);
    expect((await observer.observe({ txHash: hash, txBlockNumber: 20n })).ready).toBe(false);
  });

  it('fails closed when canonicality sources are not configured', async () => {
    const observer = new EthereumFinalityObserver({ chainId: 1, currentBlockNumber: async () => 12n }, 2);
    const result = await observer.observe({ txHash: hash, txBlockNumber: 11n });
    expect(result).toMatchObject({ canonical: null, ready: false, reason: 'canonicality-unknown' });
  });
});
