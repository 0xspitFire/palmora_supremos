import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, type Hash, type PublicClient } from 'viem';
import { WebSocketFrameDecoder, checkFeed, decodeFeedMessage, decodeFeedSequences, l2MessageTxHashes } from './feed-check.js';

const frame = (opcode: number, payload: Buffer, options: { fin?: boolean; rsv1?: boolean } = {}): Buffer => {
  const head = [(options.fin === false ? 0 : 0x80) | (options.rsv1 ? 0x40 : 0) | opcode];
  if (payload.length < 126) head.push(payload.length);
  else head.push(126, payload.length >> 8, payload.length & 0xff);
  return Buffer.concat([Buffer.from(head), payload]);
};

async function signedTx(nonce: number): Promise<{ bytes: Buffer; hash: Hash }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const raw = await account.signTransaction({ type: 'eip1559', chainId: 4663, to: '0x00005ea00ac477b1030ce78506496e8c2de24bf5', value: 0n, data: '0x1234', nonce, gas: 100_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n });
  return { bytes: Buffer.from(raw.slice(2), 'hex'), hash: keccak256(raw) };
}
const feedJson = (messages: Array<{ seq: number; l2: Buffer }>): string => JSON.stringify({ version: 1, messages: messages.map((item) => ({ sequenceNumber: item.seq, message: { message: { header: { kind: 3 }, l2Msg: item.l2.toString('base64') } } })) });

describe('WebSocket frame decoder (receive-only)', () => {
  it('reads whole, split and fragmented messages, answers pings, and notices close', () => {
    const decoder = new WebSocketFrameDecoder();
    const whole = frame(1, Buffer.from('hello'));
    expect(decoder.push(whole.subarray(0, 3)).messages).toEqual([]);
    expect(decoder.push(whole.subarray(3)).messages.map((item) => item.data.toString())).toEqual(['hello']);
    const result = decoder.push(Buffer.concat([frame(1, Buffer.from('ab'), { fin: false }), frame(9, Buffer.from('p')), frame(0, Buffer.from('cd')), frame(8, Buffer.alloc(0))]));
    expect(result.messages.map((item) => item.data.toString())).toEqual(['abcd']);
    expect(result.ping.map((item) => item.toString())).toEqual(['p']);
    expect(result.closed).toBe(true);
  });

  it('inflates permessage-deflate messages only when it was negotiated, and refuses oversized or unexpected frames', () => {
    const text = Buffer.from(JSON.stringify({ a: 'x'.repeat(500) }));
    const compressed = deflateRawSync(text, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
    const payload = compressed.subarray(0, compressed.length - 4); // the sender drops the 00 00 FF FF tail
    expect(new WebSocketFrameDecoder(true).push(frame(1, payload, { rsv1: true })).messages[0]!.data.toString()).toBe(text.toString());
    expect(() => new WebSocketFrameDecoder(false).push(frame(1, payload, { rsv1: true }))).toThrow('FEED_COMPRESSION_NOT_NEGOTIATED');
    const huge = Buffer.alloc(10); huge[0] = 0x81; huge[1] = 127; huge.writeBigUInt64BE(1n << 40n, 2);
    expect(() => new WebSocketFrameDecoder().push(huge)).toThrow('FEED_FRAME_TOO_LARGE');
    expect(() => new WebSocketFrameDecoder().push(frame(3, Buffer.from('x')))).toThrow('FEED_FRAME_UNSUPPORTED');
  });
});

describe('frame decoder limits', () => {
  it('rejects bad control frames and compression bombs', () => {
    expect(() => new WebSocketFrameDecoder().push(frame(9, Buffer.alloc(126)))).toThrow('FEED_CONTROL_FRAME_INVALID');
    expect(() => new WebSocketFrameDecoder().push(frame(9, Buffer.from('x'), { fin: false }))).toThrow('FEED_CONTROL_FRAME_INVALID');
    expect(() => new WebSocketFrameDecoder(true).push(frame(9, Buffer.from('x'), { rsv1: true }))).toThrow('FEED_CONTROL_FRAME_INVALID');
    // 9 MB of zeros compresses to a few KB but would inflate past the 8 MB limit.
    const bomb = deflateRawSync(Buffer.alloc(9 * 1024 * 1024), { finishFlush: 2 });
    const payload = bomb.subarray(0, bomb.length - 4);
    const head = Buffer.from([0xc1, 126, payload.length >> 8, payload.length & 0xff]);
    expect(() => new WebSocketFrameDecoder(true).push(Buffer.concat([head, payload]))).toThrow();
  });

  it('refuses a fragmented message that grows past the limit', () => {
    const decoder = new WebSocketFrameDecoder();
    const piece = Buffer.alloc(60_000, 1);
    let thrown: Error | null = null;
    try { decoder.push(frame(2, piece, { fin: false })); for (let index = 0; index < 200; index += 1) decoder.push(frame(0, piece, { fin: false })); } catch (error) { thrown = error as Error; }
    expect(thrown?.message).toBe('FEED_MESSAGE_TOO_LARGE');
  });
});

describe('feed message decoding', () => {
  it('turns kind-4 messages and kind-3 batches into transaction hashes, and ignores everything else', async () => {
    const one = await signedTx(1); const two = await signedTx(2);
    expect(l2MessageTxHashes(Buffer.concat([Buffer.from([4]), one.bytes]))).toEqual([one.hash]);
    const nested = (inner: Buffer): Buffer => { const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(inner.length)); return Buffer.concat([length, inner]); };
    const batch = Buffer.concat([Buffer.from([3]), nested(Buffer.concat([Buffer.from([4]), one.bytes])), nested(Buffer.concat([Buffer.from([4]), two.bytes]))]);
    expect(l2MessageTxHashes(batch)).toEqual([one.hash, two.hash]);
    expect(l2MessageTxHashes(Buffer.from([9, 1, 2, 3]))).toEqual([]);
    expect(l2MessageTxHashes(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 200, 1]))).toEqual([]);
    expect(decodeFeedMessage(feedJson([{ seq: 7, l2: Buffer.concat([Buffer.from([4]), one.bytes]) }]))).toEqual([{ sequenceNumber: 7n, txHash: one.hash }]);
    expect(decodeFeedMessage('not json')).toEqual([]);
    expect(decodeFeedMessage('null')).toEqual([]);
    expect(decodeFeedMessage('{"messages":[{"sequenceNumber":"junk"},{"sequenceNumber":-4}]}')).toEqual([]);
    expect(decodeFeedSequences('{"messages":[{"sequenceNumber":"junk"},{"sequenceNumber":3},{"sequenceNumber":"4"}]}')).toEqual([3n, 4n]);
    // Only header kind 3 carries L2 transactions; a deposit-style message with transaction-looking bytes is ignored.
    const deposit = JSON.stringify({ messages: [{ sequenceNumber: 9, message: { message: { header: { kind: 12 }, l2Msg: Buffer.concat([Buffer.from([4]), one.bytes]).toString('base64') } } }] });
    expect(decodeFeedMessage(deposit)).toEqual([]);
    expect(decodeFeedSequences(deposit)).toEqual([9n]);
    expect(decodeFeedMessage('{"messages":[{"sequenceNumber":1,"message":{}}]}')).toEqual([]);
  });
});

describe('feed check against the RPC', () => {
  async function* feed(...messages: string[]): AsyncGenerator<string> { for (const message of messages) yield message; }
  const clientFor = (visible: Set<string>): PublicClient => ({
    getTransaction: async ({ hash }: { hash: Hash }) => { if (!visible.has(hash)) throw new Error('not found'); return { hash, blockNumber: 100n }; },
    getTransactionReceipt: async ({ hash }: { hash: Hash }) => { if (!visible.has(hash)) throw new Error('not found'); return { status: 'success' }; },
  }) as unknown as PublicClient;

  it('counts correlated, pending (RPC lag) and gaps, without calling lag a mismatch', async () => {
    const [a, b, c] = [await signedTx(1), await signedTx(2), await signedTx(3)];
    const l2 = (item: { bytes: Buffer }): Buffer => Buffer.concat([Buffer.from([4]), item.bytes]);
    let clock = 0;
    const report = await checkFeed(clientFor(new Set([a.hash, c.hash])), feed(feedJson([{ seq: 1, l2: l2(a) }, { seq: 2, l2: l2(b) }]), feedJson([{ seq: 5, l2: l2(c) }])), { rpcWaitSeconds: 2, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(report).toMatchObject({ feedMessages: 2, transactionsSeen: 3, correlated: 2, pendingAtEnd: 1, mismatches: 0, sequenceGaps: 1 });
    expect(report.summary).toContain('RPC lag');
  });

  it('counts sequence gaps over every message, so non-transaction messages do not look like gaps', async () => {
    const a = await signedTx(1); const c = await signedTx(3);
    const l2 = (item: { bytes: Buffer }): Buffer => Buffer.concat([Buffer.from([4]), item.bytes]);
    const deposit = JSON.stringify({ messages: [{ sequenceNumber: 2, message: { message: { header: { kind: 12 }, l2Msg: '' } } }] });
    const report = await checkFeed(clientFor(new Set([a.hash, c.hash])), feed(feedJson([{ seq: 1, l2: l2(a) }]), deposit, feedJson([{ seq: 3, l2: l2(c) }])), { rpcWaitSeconds: 2, now: () => 0, sleep: async () => undefined });
    expect(report).toMatchObject({ sequenceGaps: 0, transactionsSeen: 2, correlated: 2 });
  });

  it('refuses invalid options and reports an empty feed plainly', async () => {
    await expect(checkFeed(clientFor(new Set()), feed(), { maxTransactions: 0 })).rejects.toThrow('FEED_CHECK_OPTIONS_INVALID');
    expect((await checkFeed(clientFor(new Set()), feed())).summary).toContain('no transactions');
  });
});
