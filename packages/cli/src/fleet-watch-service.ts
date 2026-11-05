import { createPublicClient, http } from 'viem';
import { verifyTrustedTreasuryReturns, type TreasuryReturnClient } from './treasury-return-verifier.js';
import {
  DEFAULT_IDLE_BALANCE_CEILINGS,
  FleetWatcher,
  type AlertManager,
  type BackendStore,
  type BalanceCeilings,
  type WalletReading,
  type TreasuryWatchInput,
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
  trustedTreasuryReturns?: readonly string[];
  activeIntervalMs?: number;
  idleIntervalMs?: number;
}

function intervalFrom(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,9}$/.test(value)) throw new Error('FLEET_WATCH_INTERVAL_INVALID');
  const ms = Number(value);
  if (ms < 30_000 || ms > 3_600_000) throw new Error('FLEET_WATCH_INTERVAL_INVALID');
  return ms;
}

/** Returns undefined when the watcher is not enabled. Throws a plain code when it is enabled but misconfigured. */
export function parseFleetWatchEnv(environment: NodeJS.ProcessEnv): FleetWatchConfig | undefined {
  const flag = environment.MINT_BOT_WATCHER_ENABLED;
  // Only an exact "true" turns it on and only unset, empty or "false" leave it off: a typo such as "True" or "1" stops the start instead of silently disabling the watcher.
  if (flag === undefined || flag === '' || flag === 'false') return undefined;
  if (flag !== 'true') throw new Error('FLEET_WATCH_ENABLED_INVALID');
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
  const returnFlag = environment.MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS;
  if (returnFlag !== undefined && returnFlag !== '' && returnFlag !== 'false' && returnFlag !== 'true') throw new Error('FLEET_WATCH_TREASURY_RETURNS_INVALID');
  let trustedTreasuryReturns: string[] | undefined;
  if (returnFlag === 'true') {
    let extra: unknown;
    try { extra = JSON.parse(environment.MINT_BOT_WATCH_TREASURY_DESTINATIONS ?? '[]'); } catch { throw new Error('FLEET_WATCH_TREASURY_DESTINATIONS_INVALID'); }
    if (!Array.isArray(extra) || extra.length > 16 || !extra.every(item => typeof item === 'string' && ADDRESS.test(item) && BigInt(item) !== 0n) || BigInt(treasury) === 0n) throw new Error('FLEET_WATCH_TREASURY_DESTINATIONS_INVALID');
    trustedTreasuryReturns = [...new Set([treasury, ...extra as string[]].map(item => item.toLowerCase()))];
  }
  const activeIntervalMs = intervalFrom(environment.MINT_BOT_WATCHER_ACTIVE_INTERVAL_MS);
  const idleIntervalMs = intervalFrom(environment.MINT_BOT_WATCHER_IDLE_INTERVAL_MS);
  return { targets, treasury, ceilings: DEFAULT_IDLE_BALANCE_CEILINGS, ...(trustedTreasuryReturns ? { trustedTreasuryReturns } : {}), ...(activeIntervalMs !== undefined ? { activeIntervalMs } : {}), ...(idleIntervalMs !== undefined ? { idleIntervalMs } : {}) };
}

export const watcherRpcSecretName = (chainId: number): string => `WATCHER_RPC_${chainId}`;

interface ReaderClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: `0x${string}`; blockNumber: bigint }): Promise<number>;
  getBalance(args: { address: `0x${string}`; blockNumber: bigint }): Promise<bigint>;
}

/** Both values come from the same pinned block, so a transaction landing between two calls cannot look like unexplained activity. */
export function createChainReader(clients: ReadonlyMap<number, ReaderClient>): (target: WatchTarget) => Promise<WalletReading> {
  return async (target) => {
    const client = clients.get(target.chainId);
    if (!client) throw new Error('FLEET_WATCH_CHAIN_UNAVAILABLE');
    if (await client.getChainId() !== target.chainId) throw new Error('FLEET_WATCH_RPC_CHAIN_MISMATCH');
    const blockNumber = await client.getBlockNumber();
    const address = target.address as `0x${string}`;
    const [nonce, balanceWei] = await Promise.all([client.getTransactionCount({ address, blockNumber }), client.getBalance({ address, blockNumber })]);
    if (await client.getChainId() !== target.chainId) throw new Error('FLEET_WATCH_RPC_CHAIN_MISMATCH');
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
  /** The provider addresses for a chain from the host secret store, the watcher's own first; reads move on when one fails. */
  rpcUrls(chainId: number): string[];
  logger?: { info(data: Record<string, unknown>, message: string): void; warn(data: Record<string, unknown>, message: string): void; registerSecret?(value: string): void };
  clients?: ReadonlyMap<number, ReaderClient>;
  intervalMs?: number;
}

export function startFleetWatcher(options: StartFleetWatcherOptions): { stop(): void; watcher: FleetWatcher; tick(): Promise<void> } {
  let read: (target: WatchTarget) => Promise<WalletReading>;
  if (options.clients) read = createChainReader(options.clients);
  else {
    const endpointReaders = new Map<number, Array<(target: WatchTarget) => Promise<WalletReading>>>();
    for (const chainId of new Set(options.config.targets.map(target => target.chainId))) {
      const urls = options.rpcUrls(chainId);
      if (urls.length === 0) throw new Error('WATCHER_RPC_SECRET_MISSING');
      const readers = urls.map(url => {
        options.logger?.registerSecret?.(url);
        const client = createPublicClient({ transport: http(url, { timeout: 5_000, retryCount: 0 }) }) as unknown as ReaderClient;
        return createChainReader(new Map([[chainId, client]]));
      });
      endpointReaders.set(chainId, readers);
    }
    // A complete reading comes from one concrete endpoint. Never mix nonce or
    // balance from a failed-over, possibly misconfigured different-chain URL.
    read = async target => {
      for (const reader of endpointReaders.get(target.chainId) ?? []) {
        try { return await reader(target); } catch { /* retry the whole pinned reading */ }
      }
      throw new Error('FLEET_WATCH_CHAIN_UNAVAILABLE');
    };
  }
  const returnClients = new Map<number, TreasuryReturnClient[]>();
  if (options.config.trustedTreasuryReturns) {
    for (const chainId of new Set(options.config.targets.map(target => target.chainId))) {
      const hosts = new Set<string>();
      const independent: TreasuryReturnClient[] = [];
      for (const url of options.rpcUrls(chainId)) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { continue; }
        if (parsed.protocol !== 'https:' || hosts.has(parsed.hostname.toLowerCase())) continue;
        hosts.add(parsed.hostname.toLowerCase());
        options.logger?.registerSecret?.(url);
        independent.push(createPublicClient({ transport: http(url, { timeout: 5_000, retryCount: 0 }) }) as unknown as TreasuryReturnClient);
        if (independent.length === 2) break;
      }
      // Missing independent authority never turns a treasury destination into an exemption.
      returnClients.set(chainId, independent);
    }
  }
  const watcher = new FleetWatcher({
    store: options.store,
    targets: options.config.targets,
    ceilings: options.config.ceilings,
    treasury: options.config.treasury,
    read,
    alerts: alertSinkFor(options.alerts),
    ...(options.config.trustedTreasuryReturns ? { verifyTreasuryReturn: async (input: TreasuryWatchInput) => verifyTrustedTreasuryReturns({
      ...input,
      approvedRecipients: options.config.trustedTreasuryReturns!,
      feeAllowanceWei: options.config.ceilings[input.target.chainId]?.walletMaxWei ?? 0n,
    }, returnClients.get(input.target.chainId) ?? []) } : {}),
    kill: options.kill,
    ...(options.config.activeIntervalMs !== undefined ? { activeIntervalMs: options.config.activeIntervalMs } : {}),
    ...(options.config.idleIntervalMs !== undefined ? { idleIntervalMs: options.config.idleIntervalMs } : {}),
  });
  let busy = false;
  let thrown = 0;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const result = await watcher.tick();
      thrown = 0;
      if (result.ran && (result.findings.length > 0 || result.failed > 0)) options.logger?.warn({ event: 'fleet_watch', checked: result.checked, failed: result.failed, findings: result.findings.map((finding) => finding.kind), killed: result.killed }, 'fleet watcher findings');
    } catch (error) {
      options.logger?.warn({ event: 'fleet_watch_error', error: error instanceof Error ? error.message : 'unknown' }, 'fleet watcher check failed');
      // A check that keeps failing is a watcher that is not watching: tell the owner (once a day), do not just log it.
      thrown += 1;
      if (thrown >= 3) await watcher.reportBlind().catch(() => undefined);
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 30_000);
  timer.unref?.();
  void tick();
  options.logger?.info({ event: 'fleet_watch_started', wallets: options.config.targets.length }, 'independent wallet watcher started');
  return { watcher, stop: () => clearInterval(timer), tick };
}
