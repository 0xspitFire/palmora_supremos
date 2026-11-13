import type { Address, Hex } from 'viem';
import type { SourcedFact } from '@mint-bot/backend';
import type { AdvancedIntelligenceReaders, AdvancedReadContext } from './advanced-intelligence.js';
import { readVerifiedContractCreation, type CreationFactsReader } from './advanced-intelligence-creation.js';

export interface SourcifyRpcClient {
  getChainId(): Promise<number>; getBlockNumber(): Promise<bigint>;
  getCode(input: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: string | null; timestamp: bigint }>;
  getTransaction(input: { hash: Hex }): Promise<{ hash: string; to: string | null; blockNumber: bigint | null; blockHash: string | null }>;
  getTransactionReceipt(input: { hash: Hex }): Promise<{ transactionHash: string; status: string; contractAddress?: string | null; blockNumber: bigint; blockHash: string }>;
}
export interface SourcifyResponse { ok: boolean; status: number; body?: ReadableStream<Uint8Array> | null; text(): Promise<string>; }
const ORIGIN = 'https://sourcify.dev';
const fields = 'runtimeBytecode.onchainBytecode,deployment.transactionHash';
const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Exact Sourcify v2 matches are compared with two approved common-block RPC
 * views. This is source-verification evidence, never transaction authority.
 * Reference: https://docs.sourcify.dev/blog/apiv2-lookup-endpoints/
 */
export function createSourcifyIntelligenceReaders(options: {
  clients(chainId: 1 | 8453 | 4663): Promise<readonly SourcifyRpcClient[]>;
  expectedContractName?: 'Seaport';
  fetcher?: (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<SourcifyResponse>;
}): AdvancedIntelligenceReaders {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  type Metadata = { context: AdvancedReadContext; clients: readonly SourcifyRpcClient[]; creationHash?: string };
  const cached = new Map<string, { at: number; value: Promise<Metadata | undefined> }>();
  const metadata = (context: AdvancedReadContext): Promise<Metadata | undefined> => {
    const key = `${context.chainId}:${context.contract.toLowerCase()}`;
    const existing = cached.get(key);
    if (existing && context.now.getTime() - existing.at >= 0 && context.now.getTime() - existing.at < 60_000) return existing.value;
    const work = (async (): Promise<Metadata | undefined> => {
      try {
        if (![1, 8453, 4663].includes(context.chainId) || !/^0x[0-9a-f]{40}$/i.test(context.contract) || context.signal.aborted) return undefined;
        const response = await fetcher(`${ORIGIN}/server/v2/contract/${context.chainId}/${context.contract.toLowerCase()}?fields=${fields}${options.expectedContractName ? ',compilation.name' : ''}`, { signal: context.signal, redirect: 'error', headers: { accept: 'application/json' } });
        if (!response.ok) return undefined; // missing Sourcify coverage is not a global "unverified" claim
        let body = '';
        if (response.body) {
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 262_144) { await reader.cancel(); return undefined; } chunks.push(chunk.value); } }
          finally { reader.releaseLock(); }
          body = Buffer.concat(chunks).toString('utf8');
        } else body = await response.text();
        if (Buffer.byteLength(body) > 262_144 || context.signal.aborted) return undefined;
        const record = asRecord(JSON.parse(body));
        const runtime = asRecord(record?.runtimeBytecode)?.onchainBytecode;
        if (!record || String(record.chainId) !== String(context.chainId) || typeof record.address !== 'string' || record.address.toLowerCase() !== context.contract.toLowerCase() || record.runtimeMatch !== 'exact_match' || options.expectedContractName !== undefined && asRecord(record.compilation)?.name !== options.expectedContractName || typeof runtime !== 'string' || !/^0x(?:[a-f0-9]{2})+$/i.test(runtime)) return undefined;
        const clients = await options.clients(context.chainId);
        if (clients.length < 2 || clients[0] === clients[1]) return undefined;
        context.consumeRpc(2); const heads = await Promise.all(clients.slice(0, 2).map(client => client.getBlockNumber()));
        if (heads.some(head => typeof head !== 'bigint' || head < 2n)) return undefined;
        const common = (heads[0]! < heads[1]! ? heads[0]! : heads[1]!) - 2n;
        const observations = await Promise.all(clients.slice(0, 2).map(async client => {
          context.consumeRpc(3);
          const [chain, block, code] = await Promise.all([client.getChainId(), client.getBlock({ blockNumber: common }), client.getCode({ address: context.contract as Address, blockNumber: common })]);
          const age = context.now.getTime() - Number(block.timestamp) * 1000;
          if (chain !== context.chainId || !block.hash || !/^0x[a-f0-9]{64}$/i.test(block.hash) || age < -30_000 || age > 300_000 || !Number.isFinite(age) || !code || code.toLowerCase() !== runtime.toLowerCase()) throw new Error('ADVANCED_SOURCE_RPC_MISMATCH');
          return { hash: block.hash.toLowerCase(), code: code.toLowerCase(), timestamp: block.timestamp.toString() };
        }));
        if (JSON.stringify(observations[0]) !== JSON.stringify(observations[1]) || context.signal.aborted) return undefined;
        const creationHash = asRecord(record.deployment)?.transactionHash;
        return { context, clients, ...(typeof creationHash === 'string' && /^0x[a-f0-9]{64}$/i.test(creationHash) ? { creationHash } : {}) };
      } catch { return undefined; }
    })();
    cached.set(key, { at: context.now.getTime(), value: work });
    if (cached.size > 256) cached.delete(cached.keys().next().value!);
    return work;
  };
  return {
    trustedOrigin: ORIGIN,
    async sourceVerified(context): Promise<SourcedFact<boolean> | undefined> {
      const value = await metadata(context); if (!value) return undefined;
      return { chainId: context.chainId, contract: context.contract, observedAt: value.context.now.toISOString(), expiresAt: new Date(value.context.now.getTime() + 60_000).toISOString(), sourceReference: 'sourcify-v2-exact-common-block', value: true };
    },
    async contractCreatedAt(context) {
      const value = await metadata(context); if (!value?.creationHash) return undefined;
      const readers: CreationFactsReader[] = value.clients.slice(0, 2).map(client => ({ chainId: () => client.getChainId(), transaction: hash => client.getTransaction({ hash: hash as Hex }), receipt: async hash => {const receipt=await client.getTransactionReceipt({ hash: hash as Hex });return {...receipt,contractAddress:receipt.contractAddress??null};}, block: number => client.getBlock({ blockNumber: number }) }));
      return readVerifiedContractCreation(context, value.creationHash, readers);
    },
  };
}
