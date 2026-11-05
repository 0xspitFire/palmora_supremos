import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
import * as treasuryVerifier from './treasury-return-verifier.js';
import { alertSinkFor, createChainReader, parseFleetWatchEnv, startFleetWatcher, watcherRpcSecretName } from './fleet-watch-service.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x6AAcC4d916541F99477b2f31EfFf7B08a372A8Df';
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  MINT_BOT_WATCHER_ENABLED: 'true',
  MINT_BOT_WATCH_FLEET: JSON.stringify([{ chainId: 1, addresses: [W1, W2] }]),
  MINT_BOT_TREASURY_ADDRESS: TREASURY,
  ...over,
});

class Store extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }

describe('fleet watcher configuration (D-059)', () => {
  it('is off only when left unset, empty or false, and any other value stops the start instead of silently disabling it', () => {
    expect(parseFleetWatchEnv({})).toBeUndefined();
    expect(parseFleetWatchEnv(env({ MINT_BOT_WATCHER_ENABLED: '' }))).toBeUndefined();
    expect(parseFleetWatchEnv(env({ MINT_BOT_WATCHER_ENABLED: 'false' }))).toBeUndefined();
    for (const typo of ['True', '1', 'yes', 'TRUE', 'on']) expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCHER_ENABLED: typo }))).toThrow('FLEET_WATCH_ENABLED_INVALID');
  });

  it('reads the check intervals within 30 seconds to one hour and refuses anything else', () => {
    const config = parseFleetWatchEnv(env({ MINT_BOT_WATCHER_ACTIVE_INTERVAL_MS: '60000', MINT_BOT_WATCHER_IDLE_INTERVAL_MS: '900000' }))!;
    expect(config).toMatchObject({ activeIntervalMs: 60_000, idleIntervalMs: 900_000 });
    expect(parseFleetWatchEnv(env())!.idleIntervalMs).toBeUndefined();
    for (const bad of ['29999', '3600001', 'abc', '-5', '1.5']) expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCHER_IDLE_INTERVAL_MS: bad }))).toThrow('FLEET_WATCH_INTERVAL_INVALID');
  });

  it('reads the fleet, normalises addresses and uses the D-059 idle ceilings for every integrated chain', () => {
    const config = parseFleetWatchEnv(env())!;
    expect(config.targets).toEqual([{ chainId: 1, address: W1 }, { chainId: 1, address: W2 }]);
    expect(config.treasury).toBe(TREASURY);
    for (const chainId of [1, 8453, 4663]) expect(config.ceilings[chainId]).toMatchObject({ walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n });
  });

  it('once enabled, any mistake stops the start instead of leaving wallets unwatched', () => {
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: undefined }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: 'not json' }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: '[]' }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: JSON.stringify([{ chainId: 137, addresses: [W1] }]) }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: JSON.stringify([{ chainId: 1, addresses: ['nope'] }]) }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_FLEET: JSON.stringify([{ chainId: 1, addresses: [W1, W1.toUpperCase().replace('0X', '0x')] }]) }))).toThrow('FLEET_WATCH_FLEET_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_TREASURY_ADDRESS: undefined }))).toThrow('FLEET_WATCH_TREASURY_INVALID');
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_TREASURY_ADDRESS: 'nope' }))).toThrow('FLEET_WATCH_TREASURY_INVALID');
  });

  it('enables only explicit trusted-return configuration and reuses approved destinations across integrated chains', () => {
    expect(parseFleetWatchEnv(env())!.trustedTreasuryReturns).toBeUndefined();
    const config = parseFleetWatchEnv(env({
      MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS: 'true',
      MINT_BOT_WATCH_TREASURY_DESTINATIONS: JSON.stringify([W1, TREASURY.toLowerCase()]),
      MINT_BOT_WATCH_FLEET: JSON.stringify([1, 8453, 4663].map(chainId => ({ chainId, addresses: [W2] }))),
    }))!;
    expect(config.trustedTreasuryReturns).toEqual([TREASURY.toLowerCase(), W1]);
    expect(config.targets.map(target => target.chainId)).toEqual([1, 8453, 4663]);
    expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS: 'yes' }))).toThrow('FLEET_WATCH_TREASURY_RETURNS_INVALID');
    for (const value of ['{}', 'invalid', '["bad"]', '["0x0000000000000000000000000000000000000000"]']) {
      expect(() => parseFleetWatchEnv(env({ MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS: 'true', MINT_BOT_WATCH_TREASURY_DESTINATIONS: value }))).toThrow('FLEET_WATCH_TREASURY_DESTINATIONS_INVALID');
    }
  });

  it('names the provider secret per chain without ever holding the address itself', () => {
    expect(watcherRpcSecretName(8453)).toBe('WATCHER_RPC_8453');
  });
});

describe('chain reader', () => {
  it('reads the transaction count and the balance at one pinned block', async () => {
    const calls: string[] = [];
    const client = {
      getChainId: async () => 1,
      getBlockNumber: async () => { calls.push('block'); return 123n; },
      getTransactionCount: async (args: { blockNumber: bigint }) => { calls.push(`nonce@${args.blockNumber}`); return 7; },
      getBalance: async (args: { blockNumber: bigint }) => { calls.push(`balance@${args.blockNumber}`); return 9n; },
    };
    const read = createChainReader(new Map([[1, client]]));
    expect(await read({ chainId: 1, address: W1 })).toEqual({ nonce: 7, balanceWei: 9n });
    expect(calls).toEqual(['block', 'nonce@123', 'balance@123']);
    await expect(read({ chainId: 8453, address: W1 })).rejects.toThrow('FLEET_WATCH_CHAIN_UNAVAILABLE');
  });
});

describe('chain identity isolation', () => {
  it.each([1, 8453, 4663])('rejects a provider from another chain for chain %s without adopting its nonce', async chainId => {
    const getTransactionCount = vi.fn(async () => 999);
    const read = createChainReader(new Map([[chainId, {
      getChainId: async () => chainId === 1 ? 8453 : 1,
      getBlockNumber: async () => 123n,
      getTransactionCount,
      getBalance: async () => 0n,
    }]]));
    await expect(read({ chainId, address: W1 })).rejects.toThrow('FLEET_WATCH_RPC_CHAIN_MISMATCH');
    expect(getTransactionCount).not.toHaveBeenCalled();
  });

  it('refuses a chain identity that changes during the pinned read', async () => {
    const read = createChainReader(new Map([[1, {
      getChainId: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(8453),
      getBlockNumber: async () => 123n, getTransactionCount: async () => 999, getBalance: async () => 0n,
    }]]));
    await expect(read({ chainId: 1, address: W1 })).rejects.toThrow('FLEET_WATCH_RPC_CHAIN_MISMATCH');
  });
});

describe('startFleetWatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const client = (state: { nonce: number; balance: bigint }) => ({ getChainId: async () => 1, getBlockNumber: async () => 1n, getTransactionCount: async () => state.nonce, getBalance: async () => state.balance });

  it('fails to start without a provider address for a watched chain', () => {
    const config = parseFleetWatchEnv(env())!;
    expect(() => startFleetWatcher({ store: new Store(), config, alerts: { intelligence: async () => true }, kill: async () => undefined, rpcUrls: () => [] })).toThrow('WATCHER_RPC_SECRET_MISSING');
  });

  it('checks on start, engages the kill switch and alerts on unknown activity, and stops cleanly', async () => {
    const config = parseFleetWatchEnv(env())!;
    const state = { nonce: 5, balance: 300_000_000_000_000n };
    const kills: string[] = [];
    const alerts: Array<{ kind: string; priority: string }> = [];
    const running = startFleetWatcher({
      store: new Store(),
      config,
      alerts: { intelligence: async (input) => { alerts.push({ kind: input.kind, priority: input.priority }); return true; } },
      kill: async (reason) => { kills.push(reason); },
      rpcUrls: () => ['http://unused'],
      clients: new Map([[1, client(state)]]),
      intervalMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(kills).toEqual([]);
    state.nonce = 6; // a transaction MintBot never made
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(kills).toContain('fleet-watch-unknown_activity');
    expect(alerts.some((alert) => alert.kind === 'fleet_watch' && alert.priority === 'immediate')).toBe(true);
    running.stop();
    const before = kills.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(kills.length).toBe(before);
  });

  it('tells the owner when the watcher keeps failing to run, instead of only logging it', async () => {
    const config = parseFleetWatchEnv(env())!;
    const alerts: string[] = [];
    const broken = { getChainId: async () => 1, getBlockNumber: async () => { throw new Error('rpc'); }, getTransactionCount: async () => 0, getBalance: async () => 0n };
    const running = startFleetWatcher({ store: new Store(), config, alerts: { intelligence: async (input) => { alerts.push(input.dedupe); return true; } }, kill: async () => undefined, rpcUrls: () => ['http://unused'], clients: new Map([[1, broken]]), intervalMs: 30_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    running.stop();
    expect(alerts.some((dedupe) => dedupe.includes('watcher_blind'))).toBe(true);
  });

  it('retries the complete pinned reading on the next endpoint after rejecting the first endpoint chain', async () => {
    const calls: Array<{ host: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as { id: number; method: string };
      const host = new URL(url).hostname;
      calls.push({ host, method: request.method });
      const result = request.method === 'eth_chainId' ? host === 'wrong.invalid' ? '0x2105' : '0x1'
        : request.method === 'eth_blockNumber' ? '0x7b' : request.method === 'eth_getTransactionCount' ? '0x5' : '0x12c';
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const store = new Store();
    const running = startFleetWatcher({ store, config: parseFleetWatchEnv(env())!, alerts: { intelligence: async () => true }, kill: async () => undefined,
      rpcUrls: () => ['https://wrong.invalid', 'https://correct.invalid'] });
    await vi.advanceTimersByTimeAsync(0);
    running.stop();
    expect(store.snapshot().events.filter(event => event.type === 'fleet_watch_baseline')).toHaveLength(2);
    expect(calls.filter(call => call.host === 'wrong.invalid').every(call => call.method === 'eth_chainId')).toBe(true);
    expect(calls.some(call => call.host === 'correct.invalid' && call.method === 'eth_getTransactionCount')).toBe(true);
  });

  it.each([
    { urls: ['https://rpc.example/a', 'https://rpc.example:443/b'], expected: 1 },
    { urls: ['http://insecure.example', 'https://secure.example'], expected: 1 },
    { urls: ['https://rpc.example/a', 'https://RPC.example:8443/b', 'https://independent.example'], expected: 2 },
  ])('uses at most two distinct RPC hosts for treasury proof: $expected', async ({ urls, expected }) => {
    const verify = vi.spyOn(treasuryVerifier, 'verifyTrustedTreasuryReturns').mockResolvedValue(undefined);
    const config = parseFleetWatchEnv(env({ MINT_BOT_WATCH_TRUSTED_TREASURY_RETURNS: 'true', MINT_BOT_WATCH_TREASURY_DESTINATIONS: JSON.stringify([W2]) }))!;
    const state = { nonce: 5, balance: 300n };
    const running = startFleetWatcher({ store: new Store(), config, alerts: { intelligence: async () => true }, kill: async () => undefined,
      clients: new Map([[1, client(state)]]), rpcUrls: () => urls });
    await vi.advanceTimersByTimeAsync(0);
    state.nonce++;
    await running.watcher.tick(true);
    running.stop();
    expect(verify).toHaveBeenCalled();
    const [input, clients] = verify.mock.calls[0]!;
    expect(input.approvedRecipients).toEqual([TREASURY.toLowerCase(), W2]);
    expect(clients).toHaveLength(expected);
    expect(input.feeAllowanceWei).toBe(config.ceilings[1]!.walletMaxWei);
  });

  it('maps the watcher messages onto the intelligence alert channel with their dedupe identity', async () => {
    const seen: unknown[] = [];
    await alertSinkFor({ intelligence: async (input) => { seen.push(input); return true; } }).send({ kind: 'funding_request', dedupe: 'funding_request:r1', priority: 'immediate', text: 't', system: { v: 1 } as never, at: '2026-10-22T12:00:00.000Z' });
    expect(seen[0]).toMatchObject({ kind: 'funding_request', dedupe: 'funding_request:r1', priority: 'immediate' });
  });
});
