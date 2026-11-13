import { ingestCanonicalAnalytics, type BackendStore, type CanonicalAnalyticsPort, type AnalyticsChainReceipt, type AnalyticsChainTransaction } from '@mint-bot/backend';
import { SEADROP_V1_ADDRESS } from '@mint-bot/engine';
import type { Hex, PublicClient } from 'viem';

/** Compare the same selected public facts from independently configured readers. */
export function canonicalAnalyticsPort(chainId: 1 | 8453 | 4663, clients: readonly PublicClient[]): CanonicalAnalyticsPort {
  if (clients.length < 2 || clients[0] === clients[1]) throw new Error('ANALYTICS_INDEPENDENT_READERS_REQUIRED');
  const agree = async <T,>(read: (client: PublicClient) => Promise<T>): Promise<T> => {
    try {
      const rows = await Promise.all(clients.slice(0, 2).map(read));
      const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
      if (json(rows[0]) !== json(rows[1])) throw new Error('ANALYTICS_RPC_DISAGREEMENT');
      return rows[0]!;
    } catch (error) { throw new Error(error instanceof Error && error.message === 'ANALYTICS_RPC_DISAGREEMENT' ? error.message : 'ANALYTICS_CHAIN_UNAVAILABLE'); }
  };
  return {
    expectedTarget: SEADROP_V1_ADDRESS,
    chainId: async () => { const actual = await agree(client => client.getChainId()); if (actual !== chainId) throw new Error('ANALYTICS_CHAIN_MISMATCH'); return actual; },
    transaction: hash => agree(async client => {
      const row = await client.getTransaction({ hash: hash as Hex });
      return { hash: row.hash, from: row.from.toLowerCase(), to: row.to?.toLowerCase() ?? null, value: row.value, blockNumber: row.blockNumber, blockHash: row.blockHash } satisfies AnalyticsChainTransaction;
    }),
    receipt: hash => agree(async client => {
      const row = await client.getTransactionReceipt({ hash: hash as Hex });
      return { transactionHash: row.transactionHash, from: row.from.toLowerCase(), to: row.to?.toLowerCase() ?? null, status: row.status, blockNumber: row.blockNumber, blockHash: row.blockHash, transactionIndex: row.transactionIndex, logs: row.logs.map(log => ({ address: log.address.toLowerCase(), topics: log.topics, data: log.data, logIndex: log.logIndex, transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, removed: log.removed ?? false })) } as AnalyticsChainReceipt;
    }),
    block: number => agree(async client => { const row = await client.getBlock({ blockNumber: number }); return { number: row.number, hash: row.hash, timestamp: row.timestamp }; }),
  };
}

/** Low-priority read-only chain work, isolated from mint/discovery/Telegram loops. */
export function startAnalyticsIngestion(options: { store: BackendStore; port(chainId: 1 | 8453 | 4663): Promise<CanonicalAnalyticsPort>; intervalMs?: number; record?(code: string): void }): { stop(): Promise<void>; tick(): Promise<void> } {
  const interval = options.intervalMs ?? 300_000;
  if (!Number.isSafeInteger(interval) || interval < 60_000) throw new Error('ANALYTICS_INTERVAL_INVALID');
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = (async () => {
      try { await ingestCanonicalAnalytics({ store: options.store, port: options.port, maxReceipts: 5 }); }
      catch { try { options.record?.('ANALYTICS_INGESTION_UNAVAILABLE'); } catch { /* diagnostics cannot stop scheduling */ } }
    })();
    try { await running; } finally { running = undefined; }
  };
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void tick().finally(() => schedule(interval)); }, delay);
    timer.unref();
  };
  schedule(0);
  return { tick, async stop() { stopped = true; if (timer !== undefined) clearTimeout(timer); await running; } };
}
