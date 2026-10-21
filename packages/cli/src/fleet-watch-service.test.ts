import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
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
  it('is off unless explicitly enabled', () => {
    expect(parseFleetWatchEnv({})).toBeUndefined();
    expect(parseFleetWatchEnv(env({ MINT_BOT_WATCHER_ENABLED: 'yes' }))).toBeUndefined();
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

  it('names the provider secret per chain without ever holding the address itself', () => {
    expect(watcherRpcSecretName(8453)).toBe('WATCHER_RPC_8453');
  });
});

describe('chain reader', () => {
  it('reads the transaction count and the balance at one pinned block', async () => {
    const calls: string[] = [];
    const client = {
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

describe('startFleetWatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const client = (state: { nonce: number; balance: bigint }) => ({ getBlockNumber: async () => 1n, getTransactionCount: async () => state.nonce, getBalance: async () => state.balance });

  it('fails to start without a provider address for a watched chain', () => {
    const config = parseFleetWatchEnv(env())!;
    expect(() => startFleetWatcher({ store: new Store(), config, alerts: { intelligence: async () => true }, kill: async () => undefined, rpcUrl: () => undefined })).toThrow('WATCHER_RPC_SECRET_MISSING');
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
      rpcUrl: () => 'http://unused',
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

  it('maps the watcher messages onto the intelligence alert channel with their dedupe identity', async () => {
    const seen: unknown[] = [];
    await alertSinkFor({ intelligence: async (input) => { seen.push(input); return true; } }).send({ kind: 'funding_request', dedupe: 'funding_request:r1', priority: 'immediate', text: 't', system: { v: 1 } as never, at: '2026-10-22T12:00:00.000Z' });
    expect(seen[0]).toMatchObject({ kind: 'funding_request', dedupe: 'funding_request:r1', priority: 'immediate' });
  });
});
