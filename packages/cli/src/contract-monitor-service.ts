import type { ContractMonitor, ContractMonitorTick } from '@mint-bot/backend';
import type { NFTDiscoveryReader, NFTObservedBlock, NFTObservedLog, NFTObservedReceipt, NFTObservedTransaction } from '@mint-bot/engine';

export interface ContractMonitorService {
  stop(): void; drain(): Promise<void>;
}
/** Opt-in composition only. One selected chain every ten seconds after completion; three chains get fair thirty-second rounds plus work duration. */
export function startContractMonitorService(options: {
  enabled: boolean; chains: readonly { chainId: number; monitor: Pick<ContractMonitor, 'tick'> }[];
  intervalMs?: number; tickTimeoutMs?: number;
  report?: (chainId: number, result: ContractMonitorTick) => void;
}): ContractMonitorService {
  const interval = options.intervalMs ?? 10_000; const timeout = options.tickTimeoutMs ?? 45_000;
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3_600_000 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 || new Set(options.chains.map(chain => chain.chainId)).size !== options.chains.length) throw new Error('CONTRACT_MONITOR_SERVICE_CONFIG_INVALID');
  let stopped = !options.enabled; let cursor = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined; let active: Promise<void> = Promise.resolve();
  const report = (chainId: number, result: ContractMonitorTick) => { try { options.report?.(chainId, result); } catch { /* reporting cannot stop monitoring or expose provider errors */ } };
  const schedule = () => { if (!stopped && options.chains.length) timer = setTimeout(run, interval); };
  const run = () => {
    if (stopped) return;
    const chain = options.chains[cursor++ % options.chains.length]!;
    controller = new AbortController(); const selected = controller;
    const deadline = setTimeout(() => selected.abort(), timeout);
    active = (async () => {
      try { const result = await chain.monitor.tick(selected.signal); report(chain.chainId, result); }
      catch { report(chain.chainId, { status: 'partial', pending: 0, captured: 0, published: 0, reason: 'NFT_MONITOR_UNAVAILABLE' }); }
      finally { clearTimeout(deadline); controller = undefined; schedule(); }
    })();
  };
  schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); controller?.abort(); }, async drain() { await active; } };
}

const hex = (number: bigint) => `0x${number.toString(16)}`;
const quantity = (value: unknown): bigint => { if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][a-f0-9]*)$/i.test(value)) throw new Error('NFT_MONITOR_RPC_INVALID'); return BigInt(value); };
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NFT_MONITOR_RPC_INVALID'); return value as Record<string, unknown>; };
const text = (value: unknown): string => { if (typeof value !== 'string') throw new Error('NFT_MONITOR_RPC_INVALID'); return value.toLowerCase(); };
const number = (value: unknown): number => { const result = Number(quantity(value)); if (!Number.isSafeInteger(result)) throw new Error('NFT_MONITOR_RPC_INVALID'); return result; };
const transaction = (value: unknown): NFTObservedTransaction => { const row = object(value); return { hash: text(row.hash), from: text(row.from), to: row.to === null ? null : text(row.to), nonce: number(row.nonce), blockNumber: row.blockNumber === null ? null : quantity(row.blockNumber), blockHash: row.blockHash === null ? null : text(row.blockHash) }; };
const log = (value: unknown): NFTObservedLog => {
  const row = object(value); if (!Array.isArray(row.topics) || row.topics.length > 4 || row.removed !== undefined && typeof row.removed !== 'boolean') throw new Error('NFT_MONITOR_RPC_INVALID');
  return { address: text(row.address), topics: row.topics.map(text), data: text(row.data), logIndex: number(row.logIndex), transactionHash: text(row.transactionHash), blockNumber: quantity(row.blockNumber), blockHash: text(row.blockHash), removed: row.removed === true };
};
/** Explicit already-approved endpoint only. No endpoint discovery, retries, redirects, credentials in errors, or signing methods. */
export function createNFTDiscoveryReader(endpoint: string, fetcher: typeof fetch = fetch): NFTDiscoveryReader {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('NFT_MONITOR_RPC_ENDPOINT_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('NFT_MONITOR_RPC_ENDPOINT_INVALID');
  let id = 0;
  const rpc = async (method: string, params: unknown[], signal: AbortSignal): Promise<unknown> => {
    try {
      const requestId = ++id;
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (!response.ok || !response.body) throw new Error('NFT_MONITOR_RPC_UNAVAILABLE');
      if (Number(response.headers.get('content-length') ?? 0) > 2_097_152) { await response.body.cancel().catch(() => undefined); throw new Error(method === 'eth_getLogs' ? 'NFT_MONITOR_RANGE_LIMIT' : 'NFT_MONITOR_RPC_UNAVAILABLE'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 2_097_152) throw new Error(method === 'eth_getLogs' ? 'NFT_MONITOR_RANGE_LIMIT' : 'NFT_MONITOR_RESPONSE_LIMIT'); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      const result = object(JSON.parse(new TextDecoder().decode(body)));
      if (result.id !== requestId || result.jsonrpc !== '2.0') throw new Error('NFT_MONITOR_RPC_INVALID');
      if (result.error) { const error = object(result.error); if (method === 'eth_getLogs' && error.code === -32005) throw new Error('NFT_MONITOR_RANGE_LIMIT'); if (method === 'eth_call' && error.code === 3) return '0x' + '0'.repeat(64); throw new Error('NFT_MONITOR_RPC_UNAVAILABLE'); }
      return result.result;
    } catch (error) { throw new Error(error instanceof Error && /^NFT_MONITOR_[A-Z_]+$/.test(error.message) ? error.message : 'NFT_MONITOR_RPC_UNAVAILABLE'); }
  };
  return {
    chainId: async signal => number(await rpc('eth_chainId', [], signal)),
    head: async signal => quantity(await rpc('eth_blockNumber', [], signal)),
    block: async (block, full, signal): Promise<NFTObservedBlock> => { const row = object(await rpc('eth_getBlockByNumber', [hex(block), full], signal)); if (full && (!Array.isArray(row.transactions) || row.transactions.length > 2000)) throw new Error('NFT_MONITOR_RESPONSE_LIMIT'); return { number: quantity(row.number), hash: text(row.hash), timestamp: quantity(row.timestamp), ...(full ? { transactions: (row.transactions as unknown[]).map(transaction) } : {}) }; },
    logs: async (input, signal) => { const rows = await rpc('eth_getLogs', [{ fromBlock: hex(input.fromBlock), toBlock: hex(input.toBlock), topics: input.topics }], signal); if (!Array.isArray(rows)) throw new Error('NFT_MONITOR_RPC_INVALID'); if (rows.length > 2000) throw new Error('NFT_MONITOR_RANGE_LIMIT'); return rows.map(log); },
    transaction: async (hash, signal) => transaction(await rpc('eth_getTransactionByHash', [hash], signal)),
    receipt: async (hash, signal): Promise<NFTObservedReceipt> => { const row = object(await rpc('eth_getTransactionReceipt', [hash], signal)); if (!Array.isArray(row.logs) || row.logs.length > 2000 || row.status !== '0x1' && row.status !== '0x0') throw new Error('NFT_MONITOR_RPC_INVALID'); return { transactionHash: text(row.transactionHash), from: text(row.from), to: row.to === null ? null : text(row.to), contractAddress: row.contractAddress === null ? null : text(row.contractAddress), status: row.status === '0x1' ? 'success' : 'reverted', blockNumber: quantity(row.blockNumber), blockHash: text(row.blockHash), logs: row.logs.map(log) }; },
    code: async (address, block, signal) => text(await rpc('eth_getCode', [address, hex(block)], signal)),
    supportsInterface: async (address, interfaceId, block, signal) => { if (!/^0x[0-9a-f]{8}$/i.test(interfaceId)) throw new Error('NFT_MONITOR_RPC_INVALID'); const result = await rpc('eth_call', [{ to: address, data: `0x01ffc9a7${interfaceId.slice(2).padEnd(64, '0')}` }, hex(block)], signal); if (result !== `0x${'0'.repeat(64)}` && result !== `0x${'0'.repeat(63)}1`) throw new Error('NFT_MONITOR_RPC_INVALID'); return result.endsWith('1'); },
  };
}
