import { describe, expect, it } from 'vitest';
import type { Hash, PublicClient } from 'viem';
import { createNitroFinalitySources, dryRunDrop, observeFinality, checkFees } from './robinhood-readonly.js';

const H = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}` as Hash;

/** A fake Nitro node: `posted` blocks have a batch, `finalized` blocks are final. */
function fakeNode(state: { head: bigint; postedUpTo: bigint; finalizedUpTo: bigint; txByBlock: Record<string, Hash[]>; oldHash?: Hash }) {
  const client = {
    getBlockNumber: async () => state.head,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string; includeTransactions?: boolean }) => {
      if (args.blockTag === 'finalized') return { number: state.finalizedUpTo, hash: H(1), transactions: [], timestamp: 0n };
      const number = args.blockNumber!;
      const txs = number === state.head - 30_000n ? (state.oldHash ? [state.oldHash] : []) : state.txByBlock[number.toString()] ?? [];
      return { number, hash: H(Number(number % 1_000n) + 100), transactions: txs, timestamp: BigInt(Math.floor(Date.now() / 1000) - Number(state.head - number) * 2) };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => { for (const [block, list] of Object.entries(state.txByBlock)) if (list.includes(hash)) return { blockHash: H(Number(BigInt(block) % 1_000n) + 100), blockNumber: BigInt(block) }; return { blockHash: H(Number((state.head - 30_000n) % 1_000n) + 100), blockNumber: state.head - 30_000n }; },
    call: async (args: { data: string }) => { const block = BigInt(`0x${args.data.slice(-64)}`); if (block > state.postedUpTo) throw new Error('execution reverted'); return { data: '0x01' }; },
  } as unknown as PublicClient;
  return client;
}

describe('Nitro finality sources (E3)', () => {
  it('reports posted only once a batch exists and Ethereum-final only at or below the finalized block', async () => {
    const sources = createNitroFinalitySources(fakeNode({ head: 1_000n, postedUpTo: 900n, finalizedUpTo: 800n, txByBlock: {} }));
    expect(await sources.isPosted(H(1), 900n)).toBe(true);
    expect(await sources.isPosted(H(1), 901n)).toBe(false);
    expect(await sources.isEthereumFinal(H(1), 800n)).toBe(true);
    expect(await sources.isEthereumFinal(H(1), 801n)).toBe(false);
  });

  it('follows fresh transactions in order (soft, posted, final) and flags an out-of-order node', async () => {
    const state = { head: 100_000n, postedUpTo: 0n, finalizedUpTo: 0n, txByBlock: { '100000': [H(11)], '99999': [H(12)] } as Record<string, Hash[]>, oldHash: H(13) };
    const client = fakeNode(state);
    let clock = Date.now(); let step = 0;
    const report = await observeFinality(client, { samples: 2, minutes: 5, pollSeconds: 1, now: () => clock, sleep: async (ms) => { clock += ms; step += 1; if (step === 2) state.postedUpTo = 100_000n; if (step === 4) state.finalizedUpTo = 100_000n; } });
    expect(report.followed.every((entry) => entry.postedAfterSeconds !== null && entry.finalAfterSeconds !== null)).toBe(true);
    expect(report.stagesInOrder).toBe(true);
    expect(report.followed.every((entry) => entry.postedAfterSeconds! <= entry.finalAfterSeconds!)).toBe(true);
    expect(report.historical).toMatchObject({ stage: 'ethereum_final', ready: true });
  });

  it('warns when a transaction is seen as final without ever being posted', async () => {
    const state = { head: 100_000n, postedUpTo: 0n, finalizedUpTo: 100_000n, txByBlock: { '100000': [H(21)] } as Record<string, Hash[]> };
    let clock = Date.now();
    const report = await observeFinality(fakeNode(state), { samples: 1, minutes: 1, pollSeconds: 1, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(report.stagesInOrder).toBe(false);
    expect(report.summary).toContain('WARNING');
  });

  it('refuses invalid options', async () => {
    await expect(observeFinality(fakeNode({ head: 1n, postedUpTo: 0n, finalizedUpTo: 0n, txByBlock: {} }), { samples: 0 })).rejects.toThrow('FINALITY_OPTIONS_INVALID');
    await expect(observeFinality(fakeNode({ head: 1n, postedUpTo: 0n, finalizedUpTo: 0n, txByBlock: {} }), { minutes: 61 })).rejects.toThrow('FINALITY_OPTIONS_INVALID');
  });
});

describe('Robinhood fee and dry-run checks refuse bad input without touching the chain', () => {
  it('rejects bad options and bad addresses', async () => {
    const client = fakeNode({ head: 10n, postedUpTo: 0n, finalizedUpTo: 0n, txByBlock: {} });
    await expect(checkFees(client, { blocks: 0 })).rejects.toThrow('FEE_CHECK_OPTIONS_INVALID');
    await expect(checkFees(client, { samples: 1000 })).rejects.toThrow('FEE_CHECK_OPTIONS_INVALID');
    expect(await dryRunDrop(client, 'nope', ['0x1111111111111111111111111111111111111111'])).toMatchObject({ verdict: 'blocked', wallets: [] });
  });

  it('blocks plainly when the contract has no readable SeaDrop public drop', async () => {
    const client = { readContract: async () => { throw new Error('execution reverted'); }, getBlockNumber: async () => 1n } as unknown as PublicClient;
    const report = await dryRunDrop(client, '0x1111111111111111111111111111111111111111', ['0x2222222222222222222222222222222222222222']);
    expect(report.verdict).toBe('blocked');
    expect(report.summary).toContain('No readable SeaDrop public drop');
  });
});
