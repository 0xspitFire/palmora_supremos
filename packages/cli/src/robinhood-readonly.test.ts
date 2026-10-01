import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi, zeroAddress, type Hash, type PublicClient } from 'viem';
import { SEADROP_V1_ADDRESS } from '@mint-bot/engine';
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


function dropClient(drop: { mintPrice: bigint; startTime: number; endTime: number; maxTotalMintableByWallet?: number }): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getPublicDrop') return { mintPrice: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime, maxTotalMintableByWallet: drop.maxTotalMintableByWallet ?? 5, feeBps: 0, restrictFeeRecipients: false };
      throw new Error('not implemented');
    },
    call: async () => ({ data: '0x' }),
    estimateGas: async () => 100_000n,
    getGasPrice: async () => 10_000_000n,
    getBalance: async () => 5_000_000_000_000n,
    getBlockNumber: async () => 1n,
  } as unknown as PublicClient;
}

describe('dry run (E6)', () => {
  const nft = '0x1111111111111111111111111111111111111111';
  const wallet = '0x2222222222222222222222222222222222222222';
  const now = new Date('2026-10-01T12:00:00Z');
  const open = { startTime: Math.floor(now.getTime() / 1000) - 3600, endTime: Math.floor(now.getTime() / 1000) + 3600 };

  it('refuses a paid drop (D-038) and a drop that is not open, without simulating', async () => {
    const paid = await dryRunDrop(dropClient({ mintPrice: 1n, ...open }), nft, [wallet], { now });
    expect(paid).toMatchObject({ verdict: 'blocked', wallets: [] });
    expect(paid.summary).toContain('Paid Robinhood mints are blocked');
    const ended = await dryRunDrop(dropClient({ mintPrice: 0n, startTime: open.startTime - 7200, endTime: open.startTime - 3600 }), nft, [wallet], { now });
    expect(ended).toMatchObject({ verdict: 'blocked', wallets: [], drop: { status: 'ended' } });
    const upcoming = await dryRunDrop(dropClient({ mintPrice: 0n, startTime: open.endTime, endTime: 0 }), nft, [wallet], { now });
    expect(upcoming.drop?.status).toBe('upcoming');
  });

  it('simulates a free open drop, flags a wallet with too little ETH, and validates its inputs', async () => {
    const ok = await dryRunDrop(dropClient({ mintPrice: 0n, ...open }), nft, [wallet], { now, quantity: 99 });
    expect(ok).toMatchObject({ verdict: 'ok', quantity: 5, wallets: [{ simulation: 'passed', withinPerWalletCap: true, hasEnoughForGas: true }] });
    const poor = { ...dropClient({ mintPrice: 0n, ...open }), getBalance: async () => 0n } as unknown as PublicClient;
    expect((await dryRunDrop(poor, nft, [wallet], { now })).wallets[0]).toMatchObject({ hasEnoughForGas: false });
    expect((await dryRunDrop(dropClient({ mintPrice: 0n, ...open }), nft, [], { now })).summary).toContain('1 to 50 valid wallet');
    expect((await dryRunDrop(dropClient({ mintPrice: 0n, ...open }), nft, ['bad'], { now })).verdict).toBe('blocked');
    expect((await dryRunDrop(dropClient({ mintPrice: 0n, ...open }), nft, [wallet], { now, quantity: 0 })).summary).toContain('whole number');
  });
});

describe('fee check (E5) arithmetic', () => {
  const mintPublic = encodeFunctionData({ abi: parseAbi(['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)']), functionName: 'mintPublic', args: [zeroAddress, zeroAddress, zeroAddress, 1n] });
  it('reports median, worst and cap share from real receipts, counting paid mints separately', async () => {
    const txs: Record<string, { value: bigint; gasUsed: bigint; price: bigint; to?: string }> = {
      [H(1)]: { value: 0n, gasUsed: 100_000n, price: 20n }, [H(2)]: { value: 0n, gasUsed: 200_000n, price: 20n }, [H(3)]: { value: 0n, gasUsed: 100_000n, price: 4_000_000_000_000n }, [H(4)]: { value: 7n, gasUsed: 100_000n, price: 20n }, [H(5)]: { value: 0n, gasUsed: 100_000n, price: 20n, to: '0x3333333333333333333333333333333333333333' },
    };
    const client = {
      getBlockNumber: async () => 1_000n,
      getLogs: async () => Object.keys(txs).map((hash) => ({ transactionHash: hash })),
      getTransaction: async ({ hash }: { hash: string }) => ({ to: txs[hash]!.to ?? SEADROP_V1_ADDRESS, input: mintPublic, value: txs[hash]!.value }),
      getTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: 'success', gasUsed: txs[hash]!.gasUsed, effectiveGasPrice: txs[hash]!.price }),
    } as unknown as PublicClient;
    const report = await checkFees(client, { blocks: 100, samples: 10 });
    // Free public mints: H1 (2,000,000 wei), H2 (4,000,000 wei), H3 (4e17 wei, over the 2e14 cap). H4 is paid; H5 is not sent to SeaDrop.
    expect(report).toMatchObject({ mintsSampled: 3, publicMintsLooked: 4, paidPublicMints: 1, underPerWalletCap: 2 });
    expect(report.costEth.median).toBe('0.00000000');
    expect(report.summary).toContain('1 were paid');
  });
});
