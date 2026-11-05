import { describe, expect, it, vi } from 'vitest';
import { verifyTrustedTreasuryReturns, type TreasuryReturnClient, type TreasuryReturnInput } from './treasury-return-verifier.js';

const sender = `0x${'11'.repeat(20)}`;
const treasury = `0x${'22'.repeat(20)}`;
const txHash = `0x${'33'.repeat(32)}`;
const blockHash = (number: bigint) => `0x${number.toString(16).padStart(64, '0')}`;
const timestamp = 1_800_000_000n;
const now = () => new Date(Number(timestamp) * 1000 + 60_000);
const input = (): TreasuryReturnInput => ({
  target: { chainId: 1, address: sender },
  baseline: { nonce: 7, balanceWei: '1000000', observedAt: new Date(Number(timestamp) * 1000 - 60_000).toISOString() },
  reading: { nonce: 8, balanceWei: 879_000n },
  ledger: { knownNextNonce: undefined, allowedFallWei: 0n }, approvedRecipients: [treasury], feeAllowanceWei: 30_000n,
});
const tx = () => ({
  hash: txHash, from: sender, to: treasury, nonce: 7, chainId: 1,
  blockNumber: 90n, blockHash: blockHash(90n), type: 'eip1559',
  input: '0x', value: 100_000n, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
});
const receipt = () => ({
  transactionHash: txHash, from: sender, to: treasury, blockNumber: 90n,
  blockHash: blockHash(90n), status: 'success', contractAddress: null,
  gasUsed: 21_000n, effectiveGasPrice: 1n,
});
function client(options: {
  chainId?: number; transaction?: Record<string, unknown>; receipt?: Record<string, unknown>;
  count?: (block: bigint) => number; balance?: bigint; code?: string; timestamp?: bigint;
  head?: bigint; failArchive?: boolean; omitTx?: boolean; duplicate?: boolean; hashMismatch?: boolean;
} = {}): TreasuryReturnClient {
  return {
    async getChainId() { return options.chainId ?? 1; },
    async getBlockNumber() { return options.head ?? 102n; },
    async getBlock({ blockNumber }) {
      return { number: blockNumber, hash: options.hashMismatch ? blockHash(blockNumber + 1n) : blockHash(blockNumber),
        timestamp: options.timestamp ?? timestamp,
        transactions: blockNumber === 90n && !options.omitTx ? options.duplicate ? [options.transaction ?? tx(), options.transaction ?? tx()] : [options.transaction ?? tx()] : [] };
    },
    async getTransactionCount({ blockNumber }) {
      if (options.failArchive && blockNumber !== 100n) throw new Error('rpc credentials must never escape');
      return options.count?.(blockNumber) ?? (blockNumber < 90n ? 7 : 8);
    },
    async getBalance() { return options.balance ?? 879_000n; },
    async getCode() { return options.code ?? '0x'; },
    async getTransactionReceipt() { return options.receipt ?? receipt(); },
  };
}
const verify = (args = input(), a = client(), b = client()) => verifyTrustedTreasuryReturns(args, [a, b], now);

describe('verified treasury native returns', () => {
  it('binds the complete successful transfer to baseline, observed state and common block', async () => {
    expect(await verify()).toEqual({
      chainId: 1, address: sender, fromNonce: 7, toNonce: 8, nonce: 8, balanceWei: 879_000n,
      baselineNonce: 7, baselineBalanceWei: '1000000', baselineObservedAt: input().baseline.observedAt,
      hashes: [txHash], blockNumber: 100n, blockHash: blockHash(100n), totalValueWei: 100_000n, totalFeeWei: 21_000n,
    });
  });
  it('proves every nonce in a multi-transfer interval and refuses an omitted middle transfer', async () => {
    const args = input(); args.reading = { nonce: 9, balanceWei: 758_000n }; args.feeAllowanceWei = 50_000n;
    const firstHash = `0x${'44'.repeat(32)}`;
    const multi = (omitFirst = false): TreasuryReturnClient => {
      const rpc = client({ balance: args.reading.balanceWei });
      rpc.getTransactionCount = async ({ blockNumber }) => blockNumber < 80n ? 7 : blockNumber < 90n ? 8 : 9;
      rpc.getBlock = async ({ blockNumber }) => ({
        number: blockNumber, hash: blockHash(blockNumber), timestamp,
        transactions: blockNumber === 80n && !omitFirst ? [{ ...tx(), hash: firstHash, blockNumber: 80n, blockHash: blockHash(80n) }]
          : blockNumber === 90n ? [{ ...tx(), nonce: 8 }] : [],
      });
      rpc.getTransactionReceipt = async ({ hash }) => hash === firstHash
        ? { ...receipt(), transactionHash: firstHash, blockNumber: 80n, blockHash: blockHash(80n) } : receipt();
      return rpc;
    };
    expect((await verify(args, multi(), multi()))?.hashes).toEqual([firstHash, txHash]);
    expect(await verify(args, multi(true), multi(true))).toBeUndefined();
  });
  it('allows incoming funds without pretending they are an outgoing action', async () => {
    const args = input(); args.reading.balanceWei = 1_100_000n;
    expect(await verify(args, client({ balance: args.reading.balanceWei }), client({ balance: args.reading.balanceWei }))).toBeDefined();
  });
  it('allows a watched treasury sender to return to another trusted treasury, but never exempts a self-send', async () => {
    const args = input(); args.approvedRecipients = [sender, treasury];
    expect(await verify(args)).toBeDefined();
    expect(await verify(args, client({ transaction: { ...tx(), to: sender } }), client({ transaction: { ...tx(), to: sender } }))).toBeUndefined();
  });
  it('requires two independent client objects', async () => {
    const same = client(); expect(await verify(input(), same, same)).toBeUndefined();
    expect(await verifyTrustedTreasuryReturns(input(), [same], now)).toBeUndefined();
  });
  it.each([
    ['wrong chain', { chainId: 8453 }], ['provider balance mismatch', { balance: 879_001n }],
    ['provider hash mismatch', { hashMismatch: true }], ['missing archive history', { failArchive: true }],
    ['missing transaction', { omitTx: true }], ['ambiguous matching nonce', { duplicate: true }],
    ['contract or delegated EOA', { code: '0xef0100' }], ['stale common block', { timestamp: timestamp - 300n }],
    ['future common block', { timestamp: timestamp + 100n }],
  ] as const)('refuses %s', async (_, options) => {
    expect(await verify(input(), client(), client(options))).toBeUndefined();
  });
  it.each([
    ['calldata', { input: '0x1234' }], ['zero value', { value: 0n }],
    ['unapproved recipient', { to: `0x${'44'.repeat(20)}` }],
    ['authorization list', { authorizationList: [] }], ['blob list', { blobVersionedHashes: [] }],
    ['custom type', { type: 'deposit' }], ['wrong tx chain', { chainId: 8453 }],
    ['wrong tx block', { blockHash: blockHash(91n) }], ['access list', { accessList: [{}] }],
    ['fee exceeds signed ceiling', { maxFeePerGas: 0n }],
  ])('refuses transaction %s', async (_, patch) => {
    const transaction = { ...tx(), ...patch }; expect(await verify(input(), client({ transaction }), client({ transaction }))).toBeUndefined();
  });
  it.each([
    ['revert', { status: 'reverted' }], ['different tx hash', { transactionHash: blockHash(12n) }],
    ['wrong block', { blockHash: blockHash(91n) }], ['wrong recipient', { to: sender }],
    ['extra gas', { gasUsed: 21_001n }], ['unknown charge', { customFee: 1n }],
    ['blob charge', { blobGasPrice: 2n, blobGasUsed: 1n }],
  ])('refuses receipt %s', async (_, patch) => {
    const data = { ...receipt(), ...patch }; expect(await verify(input(), client({ receipt: data }), client({ receipt: data }))).toBeUndefined();
  });
  it('refuses fee disagreement even when each endpoint remains within the allowance', async () => {
    expect(await verify(input(), client(), client({ receipt: { ...receipt(), effectiveGasPrice: 0n } }))).toBeUndefined();
  });
  it('refuses complete transaction and receipt metadata disagreement', async () => {
    expect(await verify(input(), client(), client({ transaction: { ...tx(), transactionIndex: 2 } }))).toBeUndefined();
    expect(await verify(input(), client(), client({ receipt: { ...receipt(), transactionIndex: 2 } }))).toBeUndefined();
  });
  it('refuses a reorg during the proof', async () => {
    const rpc = client(); const original = rpc.getBlock.bind(rpc); let commonReads = 0;
    rpc.getBlock = async args => {
      const block = await original(args) as Record<string, unknown>;
      if (args.blockNumber === 100n && ++commonReads > 1) return { ...block, hash: blockHash(101n) };
      return block;
    };
    expect(await verify(input(), rpc, client())).toBeUndefined();
  });
  it('does not explain unrelated balance loss or excess fees', async () => {
    const args = input(); args.baseline.balanceWei = '1000001'; expect(await verify(args)).toBeUndefined();
    args.ledger.allowedFallWei = 1n; expect(await verify(args)).toBeDefined();
    args.feeAllowanceWei = 20_999n; expect(await verify(args)).toBeUndefined();
  });
  it('bounds nonce gaps and requires complete history before the oldest nonce', async () => {
    const args = input(); args.reading.nonce = 16; expect(await verify(args)).toBeUndefined();
    expect(await verify(input(), client({ count: () => 8 }), client({ count: () => 8 }))).toBeUndefined();
  });
  it('only searches the unexplained interval after the known ledger nonce', async () => {
    const args = input(); args.baseline.nonce = 6; args.ledger.knownNextNonce = 7;
    expect((await verify(args))?.fromNonce).toBe(7);
    args.ledger.knownNextNonce = 8; expect(await verify(args)).toBeUndefined();
  });
  it.each([8453, 4663])('includes complete explicit L2 fees for chain %i', async chainId => {
    const args = input(); args.target.chainId = chainId; args.reading.balanceWei -= 12n;
    const options = { chainId, balance: args.reading.balanceWei,
      transaction: { ...tx(), chainId }, receipt: { ...receipt(), l1Fee: 10n, operatorFee: 2n } };
    expect((await verify(args, client(options), client(options)))?.totalFeeWei).toBe(21_012n);
    expect(await verify(args, client({ ...options, receipt: receipt() }), client({ ...options, receipt: receipt() }))).toBeUndefined();
  });
  it('refuses Base receipts without explicit operator costs', async () => {
    const args = input(); args.target.chainId = 8453;
    const options = { chainId: 8453, transaction: { ...tx(), chainId: 8453 }, receipt: { ...receipt(), l1Fee: 0n } };
    expect(await verify(args, client(options), client(options))).toBeUndefined();
  });
  it('evaluates freshness after the RPC calls complete', async () => {
    expect(await verifyTrustedTreasuryReturns(input(), [client(), client()], () => new Date(Number(timestamp) * 1000 + 301_000))).toBeUndefined();
  });
  it('stops historical verification when its independent wall-clock budget expires', async () => {
    let elapsed = 0;
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    const rpc = client();
    const original = rpc.getTransactionCount.bind(rpc);
    rpc.getTransactionCount = async args => { elapsed = 20_001; return original(args); };
    try { expect(await verify(input(), rpc, client())).toBeUndefined(); }
    finally { wallClock.mockRestore(); }
  });
  it('contains provider errors without leaking raw diagnostic content', async () => {
    const broken = client(); broken.getChainId = async () => { throw new Error('https://secret-provider/API-key'); };
    expect(await verify(input(), client(), broken)).toBeUndefined();
  });
});
