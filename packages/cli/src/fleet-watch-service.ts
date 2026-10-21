import { createPublicClient, http } from 'viem';
import {
  DEFAULT_IDLE_BALANCE_CEILINGS,
  FleetWatcher,
  type AlertManager,
  type BackendStore,
  type BalanceCeilings,
  type WalletReading,
  type WatchTarget,
  type WatcherAlertSink,
} from '@mint-bot/backend';

/**
 * D-059 item 6 wiring: starts the independent on-chain watcher inside the existing service. Off unless the owner sets
 * MINT_BOT_WATCHER_ENABLED=true; once enabled, a configuration mistake stops the service from starting rather than leaving
 * wallets silently unwatched. It reads two values per wallet (transaction count and balance) at one pinned block through the
 * network provider the owner already uses, and signs and sends nothing.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAINS = [1, 8453, 4663] as const;

export interface FleetWatchConfig {
  targets: WatchTarget[];
  treasury: string;
  ceilings: BalanceCeilings;
}

/** Returns undefined when the watcher is not enabled. Throws a plain code when it is enabled but misconfigured. */
export function parseFleetWatchEnv(environment: NodeJS.ProcessEnv): FleetWatchConfig | undefined {
  if (environment.MINT_BOT_WATCHER_ENABLED !== 'true') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(environment.MINT_BOT_WATCH_FLEET ?? ''); } catch { throw new Error('FLEET_WATCH_FLEET_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('FLEET_WATCH_FLEET_INVALID');
  const targets: WatchTarget[] = [];
  const seen = new Set<string>();
  for (const entry of parsed as Array<{ chainId?: unknown; addresses?: unknown }>) {
    if (!entry || !CHAINS.includes(entry.chainId as never) || !Array.isArray(entry.addresses) || entry.addresses.length === 0) throw new Error('FLEET_WATCH_FLEET_INVALID');
    for (const address of entry.addresses) {
      if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Error('FLEET_WATCH_FLEET_INVALID');
      const key = `${entry.chainId}:${address.toLowerCase()}`;
      if (seen.has(key)) throw new Error('FLEET_WATCH_FLEET_INVALID');
      seen.add(key);
      targets.push({ chainId: entry.chainId as number, address: address.toLowerCase() });
    }
  }
  const treasury = environment.MINT_BOT_TREASURY_ADDRESS ?? '';
  if (!ADDRESS.test(treasury)) throw new Error('FLEET_WATCH_TREASURY_INVALID');
  for (const target of targets) if (!DEFAULT_IDLE_BALANCE_CEILINGS[target.chainId]) throw new Error('FLEET_WATCH_NO_CEILING_FOR_CHAIN');
  return { targets, treasury, ceilings: DEFAULT_IDLE_BALANCE_CEILINGS };
}

export const watcherRpcSecretName = (chainId: number): string => `WATCHER_RPC_${chainId}`;

interface ReaderClient {
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
  getBalance(args: { address: `0x${string}`; blockNumber: bigint }): Promise<bigint>;
}

/** Both values come from the same pinned block, so a transaction landing between two calls cannot look like unexplained activity. */
export function createChainReader(clients: ReadonlyMap<number, ReaderClient>): (target: WatchTarget) => Promise<WalletReading> {
  return async (target) => {
    const client = clients.get(target.chainId);
    if (!client) throw new Error('FLEET_WATCH_CHAIN_UNAVAILABLE');
    const blockNumber = await client.getBlockNumber();
    const address = target.address as `0x${string}`;
    const [nonce, balanceWei] = await Promise.all([client.getTransactionCount({ address, blockNumber }), client.getBalance({ address, blockNumber })]);
    return { nonce, balanceWei };
  };
}

export function alertSinkFor(alerts: Pick<AlertManager, 'intelligence'>): WatcherAlertSink {
  return { send: (input) => alerts.intelligence({ kind: input.kind, dedupe: input.dedupe, text: input.text, priority: input.priority, system: input.system, at: input.at }) };
}

export interface StartFleetWatcherOptions {
  store: BackendStore;
  config: FleetWatchConfig;
  alerts: Pick<AlertManager, 'intelligence'>;
  /** Engages the kill switch for the whole service: the coordinator and the kill file. */
  kill(reason: string): Promise<void>;
  /** The network provider address for a chain, from the host secret store. */
  rpcUrl(chainId: number): string | undefined;
  logger?: { info(data: Record<string, unknown>, message: string): void; warn(data: Record<string, unknown>, message: string): void; registerSecret?(value: string): void };
  clients?: ReadonlyMap<number, ReaderClient>;
  intervalMs?: number;
}

export function startFleetWatcher(options: StartFleetWatcherOptions): { stop(): void; watcher: FleetWatcher; tick(): Promise<void> } {
  const clients = options.clients ?? new Map<number, ReaderClient>();
  if (!options.clients) {
    for (const chainId of new Set(options.config.targets.map((target) => target.chainId))) {
      const url = options.rpcUrl(chainId);
      if (!url) throw new Error('WATCHER_RPC_SECRET_MISSING');
      options.logger?.registerSecret?.(url);
      (clients as Map<number, ReaderClient>).set(chainId, createPublicClient({ transport: http(url) }) as unknown as ReaderClient);
    }
  }
  const watcher = new FleetWatcher({
    store: options.store,
    targets: options.config.targets,
    ceilings: options.config.ceilings,
    treasury: options.config.treasury,
    read: createChainReader(clients),
    alerts: alertSinkFor(options.alerts),
    kill: options.kill,
  });
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const result = await watcher.tick();
      if (result.ran && (result.findings.length > 0 || result.failed > 0)) options.logger?.warn({ event: 'fleet_watch', checked: result.checked, failed: result.failed, findings: result.findings.map((finding) => finding.kind), killed: result.killed }, 'fleet watcher findings');
    } catch (error) {
      options.logger?.warn({ event: 'fleet_watch_error', error: error instanceof Error ? error.message : 'unknown' }, 'fleet watcher check failed');
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 30_000);
  timer.unref?.();
  void tick();
  options.logger?.info({ event: 'fleet_watch_started', wallets: options.config.targets.length }, 'independent wallet watcher started');
  return { watcher, stop: () => clearInterval(timer), tick };
}
