import { createHash, randomBytes } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import { keccak256, type Hash, type Hex, type PublicClient } from 'viem';
import { correlateSequencerObservation } from '@mint-bot/engine';

/**
 * Read-only sequencer feed check (Robinhood step E4, D-038). It listens to the public Nitro sequencer feed,
 * decodes the transactions it announces, and checks that the RPC then shows the same transactions. It only
 * receives data: it never sends anything to the feed beyond the connection handshake and keep-alive replies.
 */
export const PUBLIC_ROBINHOOD_FEED = 'wss://feed.mainnet.chain.robinhood.com';
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

// ── a small WebSocket reader (receive-only), so no new dependency is needed ───────────────────────────

/** Splits a byte stream into complete WebSocket messages. Server frames are unmasked; fragments are joined. */
export class WebSocketFrameDecoder {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentCompressed = false;
  private size = 0;

  /** Returns text/binary messages, and replies (pong or close) the caller should send. */
  /** `deflate` must be true only when permessage-deflate was negotiated with no context takeover. */
  constructor(private readonly deflate = false) {}

  push(chunk: Buffer): { messages: Array<{ opcode: number; data: Buffer }>; ping: Buffer[]; closed: boolean } {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Array<{ opcode: number; data: Buffer }> = [];
    const ping: Buffer[] = [];
    let closed = false;
    for (;;) {
      if (this.buffer.length < 2) break;
      const first = this.buffer[0]!; const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0; const rsv1 = (first & 0x40) !== 0; const opcode = first & 0x0f; const masked = (second & 0x80) !== 0;
      let length = second & 0x7f; let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) break; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) break; const big = this.buffer.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('FEED_FRAME_TOO_LARGE'); length = Number(big); offset = 10; }
      if (length > MAX_MESSAGE_BYTES) throw new Error('FEED_FRAME_TOO_LARGE');
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      let data = this.buffer.subarray(offset, offset + length);
      if (masked) { const mask = this.buffer.subarray(offset - 4, offset); data = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]!)); }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) { closed = true; continue; }
      if (opcode === 0x9) { ping.push(Buffer.from(data)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) { this.fragments = [Buffer.from(data)]; this.fragmentOpcode = opcode; this.fragmentCompressed = rsv1 && this.deflate; this.size = data.length; if (rsv1 && !this.deflate) throw new Error('FEED_COMPRESSION_NOT_NEGOTIATED'); }
      else if (opcode === 0x0) { this.fragments.push(Buffer.from(data)); this.size += data.length; if (this.size > MAX_MESSAGE_BYTES) throw new Error('FEED_MESSAGE_TOO_LARGE'); }
      else throw new Error('FEED_FRAME_UNSUPPORTED');
      if (fin) {
        let whole = Buffer.concat(this.fragments);
        if (this.fragmentCompressed) {
          // permessage-deflate: the sender drops the 00 00 FF FF tail; put it back, then inflate within a size limit.
          whole = inflateRawSync(Buffer.concat([whole, Buffer.from([0, 0, 0xff, 0xff])]), { maxOutputLength: MAX_MESSAGE_BYTES, finishFlush: zlibConstants.Z_SYNC_FLUSH });
        }
        messages.push({ opcode: this.fragmentOpcode, data: whole });
        this.fragments = []; this.size = 0; this.fragmentCompressed = false;
      }
    }
    return { messages, ping, closed };
  }
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!))]);
}

/** Connects to a wss:// feed and yields each text message until `seconds` pass or `maxMessages` arrive. */
export async function* readFeed(url: string, options: { seconds: number; maxMessages: number }): AsyncGenerator<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:') throw new Error('FEED_MUST_BE_WSS');
  const socket = tlsConnect({ host: parsed.hostname, port: Number(parsed.port || 443), servername: parsed.hostname });
  const key = randomBytes(16).toString('base64');
  let decoder = new WebSocketFrameDecoder();
  const queue: string[] = [];
  let failure: Error | null = null; let ended = false; let handshake = Buffer.alloc(0); let upgraded = false; let wake: (() => void) | null = null;
  const signal = (): void => { wake?.(); wake = null; };
  socket.on('secureConnect', () => { socket.write(`GET ${parsed.pathname || '/'}${parsed.search} HTTP/1.1\r\nHost: ${parsed.hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover\r\nOrigin: https://${parsed.hostname}\r\n\r\n`); });
  socket.on('data', (chunk: Buffer) => {
    try {
      let body = chunk;
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = handshake.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(header)) throw new Error(`FEED_HANDSHAKE_REFUSED: ${(header.split('\r\n')[0] ?? '').slice(0, 60)}`);
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (!header.includes(accept)) throw new Error('FEED_HANDSHAKE_INVALID');
        const extensions = /sec-websocket-extensions:\s*([^\r\n]*)/i.exec(header)?.[1] ?? '';
        const deflate = /permessage-deflate/i.test(extensions);
        // Only a stateless (no context takeover) stream is supported; anything else would need a shared dictionary.
        if (deflate && !/server_no_context_takeover/i.test(extensions)) throw new Error('FEED_COMPRESSION_UNSUPPORTED');
        decoder = new WebSocketFrameDecoder(deflate);
        upgraded = true;
        body = handshake.subarray(end + 4);
        handshake = Buffer.alloc(0);
      }
      const { messages, ping, closed } = decoder.push(body);
      for (const reply of ping) socket.write(clientFrame(0xa, reply));
      for (const message of messages) if (message.opcode === 0x1) queue.push(message.data.toString('utf8'));
      if (closed) ended = true;
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); ended = true; }
    signal();
  });
  socket.on('error', (error) => { failure = new Error(`FEED_CONNECTION_FAILED: ${(error as NodeJS.ErrnoException).code ?? 'error'}`); ended = true; signal(); });
  socket.on('close', () => { ended = true; signal(); });
  const deadline = Date.now() + options.seconds * 1_000;
  let delivered = 0;
  try {
    while (delivered < options.maxMessages && Date.now() < deadline) {
      if (queue.length > 0) { delivered += 1; yield queue.shift()!; continue; }
      if (failure) throw failure;
      if (ended) break;
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 1_000).unref(); });
    }
    if (failure && delivered === 0) throw failure;
  } finally { socket.destroy(); }
}

// ── decoding ──────────────────────────────────────────────────────────────────────────────────────────

export interface FeedTx { sequenceNumber: bigint; txHash: Hash }

/** Transaction hashes inside one L2 message: kind 4 is one signed transaction, kind 3 is a batch of messages. */
export function l2MessageTxHashes(l2Msg: Uint8Array, depth = 0): Hash[] {
  if (l2Msg.length < 2 || depth > 3) return [];
  const kind = l2Msg[0]!;
  if (kind === 4) return [keccak256(`0x${Buffer.from(l2Msg.subarray(1)).toString('hex')}` as Hex)];
  if (kind !== 3) return [];
  const hashes: Hash[] = [];
  let offset = 1;
  while (offset + 8 <= l2Msg.length) {
    const length = Number(Buffer.from(l2Msg.subarray(offset, offset + 8)).readBigUInt64BE(0));
    offset += 8;
    if (length <= 0 || offset + length > l2Msg.length) break;
    hashes.push(...l2MessageTxHashes(l2Msg.subarray(offset, offset + length), depth + 1));
    offset += length;
  }
  return hashes;
}

/** Reads one feed JSON message into its sequence numbers and transaction hashes. */
export function decodeFeedMessage(text: string): FeedTx[] {
  let parsed: { messages?: Array<{ sequenceNumber?: number | string; message?: { message?: { l2Msg?: string } } }> };
  try { parsed = JSON.parse(text); } catch { return []; }
  const out: FeedTx[] = [];
  for (const item of parsed.messages ?? []) {
    const sequence = BigInt(item.sequenceNumber ?? -1);
    const l2 = item.message?.message?.l2Msg;
    if (sequence < 0n || typeof l2 !== 'string') continue;
    for (const txHash of l2MessageTxHashes(Buffer.from(l2, 'base64'))) out.push({ sequenceNumber: sequence, txHash });
  }
  return out;
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────────

export interface FeedCheckReport {
  feedMessages: number;
  sequenceGaps: number;
  transactionsSeen: number;
  correlated: number;
  pendingAtEnd: number;
  mismatches: number;
  medianSecondsUntilRpcShowsIt: number | null;
  maxSecondsUntilRpcShowsIt: number | null;
  summary: string;
}

export async function checkFeed(client: PublicClient, feed: AsyncIterable<string>, options: { maxTransactions?: number; rpcWaitSeconds?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<FeedCheckReport> {
  const maxTransactions = options.maxTransactions ?? 30;
  const waitMs = (options.rpcWaitSeconds ?? 20) * 1_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 200 || waitMs < 1_000 || waitMs > 120_000) throw new Error('FEED_CHECK_OPTIONS_INVALID');
  let feedMessages = 0; let gaps = 0; let last: bigint | null = null;
  const seen: Array<FeedTx & { at: number }> = [];
  for await (const text of feed) {
    feedMessages += 1;
    for (const tx of decodeFeedMessage(text)) {
      if (last !== null && tx.sequenceNumber > last + 1n) gaps += 1;
      if (last === null || tx.sequenceNumber > last) last = tx.sequenceNumber;
      if (seen.length < maxTransactions) seen.push({ ...tx, at: now() });
    }
    if (seen.length >= maxTransactions) break;
  }
  const delays: number[] = []; let correlated = 0; let pending = 0; let mismatches = 0;
  for (const item of seen) {
    let outcome = correlateSequencerObservation({ txHash: item.txHash, sequence: item.sequenceNumber }, { receiptVisible: false });
    for (;;) {
      let rpc: { txHash?: Hash; blockNumber?: bigint; receiptVisible: boolean } = { receiptVisible: false };
      try {
        const tx = await client.getTransaction({ hash: item.txHash });
        const receipt = await client.getTransactionReceipt({ hash: item.txHash }).catch(() => null);
        rpc = { txHash: tx.hash, ...(tx.blockNumber !== null && tx.blockNumber !== undefined ? { blockNumber: tx.blockNumber } : {}), receiptVisible: receipt !== null };
      } catch { /* not visible yet */ }
      outcome = correlateSequencerObservation({ txHash: item.txHash, sequence: item.sequenceNumber }, rpc);
      if (outcome.status !== 'pending' || now() - item.at >= waitMs) break;
      await sleep(1_000);
    }
    if (outcome.status === 'correlated') { correlated += 1; delays.push(Math.max(0, Math.round((now() - item.at) / 1_000))); }
    else if (outcome.status === 'mismatch') mismatches += 1;
    else pending += 1;
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const medianDelay = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  const summary = seen.length === 0
    ? 'The feed delivered no transactions in the time allowed, so nothing could be compared.'
    : `Feed announced ${seen.length} transaction(s): ${correlated} also appeared on the RPC with the same hash (median ${medianDelay} s after first seen on the feed; an upper bound, since the checks run one after another), ${pending} had not appeared after ${waitMs / 1_000} s, ${mismatches} mismatched. ${gaps === 0 ? 'No gaps in the feed sequence.' : `${gaps} gap(s) in the feed sequence.`} (A transaction that stays "pending" means RPC lag, not a mismatch.)`;
  return { feedMessages, sequenceGaps: gaps, transactionsSeen: seen.length, correlated, pendingAtEnd: pending, mismatches, medianSecondsUntilRpcShowsIt: medianDelay, maxSecondsUntilRpcShowsIt: sorted.length ? sorted.at(-1)! : null, summary };
}
