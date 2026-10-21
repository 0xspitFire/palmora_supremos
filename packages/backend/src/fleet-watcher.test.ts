import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';
import { FleetWatcher, WATCH_ACTIVE_INTERVAL_MS, WATCH_BLIND_AFTER_FAILURES, WATCH_IDLE_INTERVAL_MS, judgeWallet, type WalletBaseline, type WalletReading, type WatcherAlertSink } from './fleet-watcher.js';
import type { BackendState } from './types.js';

const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x6AAcC4d916541F99477b2f31EfFf7B08a372A8Df';
const T0 = new Date('2026-10-22T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const CEILINGS = { 1: { walletMaxWei: 400_000_000_000_000n, fleetMaxWei: 2_000_000_000_000_000n } };

class Store extends DurableStore { override capabilities() { return { durable: true, atomicAcrossProcesses: true }; } }

describe('judgeWallet (pure)', () => {
  const baseline: WalletBaseline = { nonce: 5, balanceWei: '300000000000000', observedAt: T0.toISOString() };
  const ledger = (over: Partial<{ knownNextNonce: number | undefined; allowedFallWei: bigint }> = {}) => ({ knownNextNonce: undefined, allowedFallWei: 0n, ...over });

  it('records a baseline first and then judges against it', () => {
    expect(judgeWallet({ nonce: 5, balanceWei: 1n }, undefined, ledger()).kind).toBe('baseline');
    expect(judgeWallet({ nonce: 5, balanceWei: 300_000_000_000_000n }, baseline, ledger()).kind).toBe('ok');
  });

  it('flags a transaction count above anything MintBot sent, and accepts one MintBot explains', () => {
    expect(judgeWallet({ nonce: 6, balanceWei: 300_000_000_000_000n }, baseline, ledger())).toEqual({ kind: 'unknown_activity', observedNonce: 6, expectedNonce: 5 });
    expect(judgeWallet({ nonce: 6, balanceWei: 300_000_000_000_000n }, baseline, ledger({ knownNextNonce: 6 })).kind).toBe('ok');
    expect(judgeWallet({ nonce: 7, balanceWei: 300_000_000_000_000n }, baseline, ledger({ knownNextNonce: 6 })).kind).toBe('unknown_activity');
  });

  it('flags a balance fall larger than the reservations can explain, and accepts one they explain', () => {
    expect(judgeWallet({ nonce: 5, balanceWei: 299_999_999_999_999n }, baseline, ledger()).kind).toBe('unexplained_fall');
    expect(judgeWallet({ nonce: 5, balanceWei: 100_000_000_000_000n }, baseline, ledger({ allowedFallWei: 200_000_000_000_000n })).kind).toBe('ok');
    expect(judgeWallet({ nonce: 5, balanceWei: 99_999_999_999_999n }, baseline, ledger({ allowedFallWei: 200_000_000_000_000n })).kind).toBe('unexplained_fall');
  });

  it('treats a rise as a rise, and a lower transaction count as an inconsistent answer (never as safety)', () => {
    expect(judgeWallet({ nonce: 5, balanceWei: 400_000_000_000_000n }, baseline, ledger()).kind).toBe('rise');
    expect(judgeWallet({ nonce: 4, balanceWei: 300_000_000_000_000n }, baseline, ledger()).kind).toBe('rpc_inconsistent');
  });
});

describe('FleetWatcher (D-059 item 6)', () => {
  function setup(options: { reads?: Map<string, WalletReading>; failing?: boolean; ceilings?: typeof CEILINGS | Record<number, never> } = {}) {
    const store = new Store();
    const reads = options.reads ?? new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 300_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    const sent: Array<{ kind: string; dedupe: string; priority: string; text: string }> = [];
    const kills: string[] = [];
    let clock = new Date(T0);
    let failing = options.failing ?? false;
    const sink: WatcherAlertSink = { send: async (input) => { if (sent.some((item) => item.dedupe === input.dedupe)) return false; sent.push({ kind: input.kind, dedupe: input.dedupe, priority: input.priority, text: input.text }); return true; } };
    const make = () => new FleetWatcher({
      store,
      targets: [{ chainId: 1, address: W1 }, { chainId: 1, address: W2 }],
      ceilings: (options.ceilings ?? CEILINGS) as never,
      treasury: TREASURY,
      read: async (target) => { if (failing) throw new Error('rpc down'); return reads.get(target.address)!; },
      alerts: sink,
      kill: async (reason) => { kills.push(reason); },
      now: () => clock,
    });
    return { store, reads, sent, kills, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, fail: (value: boolean) => { failing = value; }, make, watcher: make() };
  }

  it('records a baseline on the first check and raises nothing', async () => {
    const { watcher, sent, kills, store } = setup();
    const result = await watcher.tick();
    expect(result).toMatchObject({ ran: true, checked: 2, failed: 0, findings: [], killed: false });
    expect(sent).toEqual([]);
    expect(kills).toEqual([]);
    expect(store.snapshot().events.filter((event) => event.type === 'fleet_watch_baseline')).toHaveLength(2);
  });

  it('engages the kill switch and alerts at once on a transaction MintBot did not make, and keeps reporting until the owner accepts', async () => {
    const { watcher, reads, sent, kills, advance, store } = setup();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 6, balanceWei: 250_000_000_000_000n });
    const result = await watcher.tick();
    expect(result.killed).toBe(true);
    expect(result.findings).toEqual([{ wallet: W1, chainId: 1, kind: 'unknown_activity' }]);
    expect(kills).toEqual(['fleet-watch-unknown_activity']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'fleet_watch', priority: 'immediate' });
    expect(store.snapshot().events.some((event) => event.type === 'fleet_watch_finding')).toBe(true);
    // the baseline did not move: the next check reports (and kills) again, but the alert is not repeated
    advance(WATCH_IDLE_INTERVAL_MS);
    const again = await watcher.tick();
    expect(again.killed).toBe(true);
    expect(sent).toHaveLength(1);
    // the owner accepts the wallet's current state after investigating; then it is quiet again
    await watcher.acceptCurrent({ chainId: 1, address: W1 }, { nonce: 6, balanceWei: 250_000_000_000_000n });
    advance(WATCH_IDLE_INTERVAL_MS);
    expect((await watcher.tick()).killed).toBe(false);
  });

  it('adopts an accept recorded by the owner command in another process, without a restart, and only for a watched wallet', async () => {
    const { watcher, reads, kills, advance, store } = setup();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 8, balanceWei: 300_000_000_000_000n });
    expect((await watcher.tick()).killed).toBe(true);
    advance(MIN);
    await store.transaction((state: BackendState) => {
      state.events.push({ id: 'evt_x', type: 'fleet_watch_accept', at: new Date(T0.getTime() + WATCH_IDLE_INTERVAL_MS + MIN).toISOString(), data: { chainId: 1, address: W1, nonce: 8, balanceWei: '300000000000000' } } as never);
      state.events.push({ id: 'evt_y', type: 'fleet_watch_accept', at: new Date(T0.getTime() + WATCH_IDLE_INTERVAL_MS + MIN).toISOString(), data: { chainId: 1, address: '0x9999999999999999999999999999999999999999', nonce: 1, balanceWei: '1' } } as never);
    });
    kills.length = 0;
    advance(WATCH_IDLE_INTERVAL_MS);
    expect((await watcher.tick()).killed).toBe(false);
    expect(kills).toEqual([]);
  });

  it('flags an unexplained balance fall and kills; flags nothing when a recorded reservation explains it', async () => {
    const unexplained = setup();
    await unexplained.watcher.tick();
    unexplained.advance(WATCH_IDLE_INTERVAL_MS);
    unexplained.reads.set(W1, { nonce: 5, balanceWei: 100_000_000_000_000n });
    expect((await unexplained.watcher.tick()).findings).toEqual([{ wallet: W1, chainId: 1, kind: 'unexplained_fall' }]);
    expect(unexplained.kills).toEqual(['fleet-watch-unexplained_fall']);

    const explained = setup();
    await explained.watcher.tick();
    explained.advance(WATCH_IDLE_INTERVAL_MS);
    await explained.store.transaction((state: BackendState) => {
      state.intents.push({ id: 'int1', runId: 'run1', campaignSnapshot: { chainId: 1 } } as never);
      state.runs.push({ id: 'run1', state: 'Completed' } as never);
      state.attempts.push({ id: 'att1', executionId: 'exe1', runId: 'run1', wallet: W1, nonce: 5, state: 'Confirmed', createdAt: T0.toISOString(), updatedAt: T0.toISOString() } as never);
      state.reservations.push({ id: 'res1', runId: 'run1', campaignId: 'c1', chainId: 1, wallet: W1, amountWei: 250_000_000_000_000n, accountingDate: '2026-10-22', status: 'settled', createdAt: '', updatedAt: new Date(T0.getTime() + HOUR).toISOString() });
    });
    explained.reads.set(W1, { nonce: 6, balanceWei: 100_000_000_000_000n });
    const result = await explained.watcher.tick();
    expect(result.findings).toEqual([]);
    expect(explained.kills).toEqual([]);
  });

  it('alerts (without a kill) when a wallet receives funds above its limit outside a run, and not for a rise within the limit', async () => {
    const { watcher, reads, sent, kills, advance } = setup();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W2, { nonce: 2, balanceWei: 100_000_000_000_000n });
    await watcher.tick();
    expect(sent).toEqual([]);
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W2, { nonce: 2, balanceWei: 700_000_000_000_000n });
    await watcher.tick();
    expect(kills).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'fleet_watch', priority: 'grouped' });
  });

  it('respects the check interval: slower when idle, faster while a run is armed or active', async () => {
    const { watcher, advance, store } = setup();
    await watcher.tick();
    advance(WATCH_ACTIVE_INTERVAL_MS);
    expect((await watcher.tick()).ran).toBe(false);
    advance(WATCH_IDLE_INTERVAL_MS - WATCH_ACTIVE_INTERVAL_MS);
    expect((await watcher.tick()).ran).toBe(true);
    await store.transaction((state: BackendState) => { state.runs.push({ id: 'run9', state: 'Active' } as never); });
    advance(WATCH_ACTIVE_INTERVAL_MS);
    expect((await watcher.tick()).ran).toBe(true);
  });

  it('survives a restart: the stored baseline is reloaded and a change while it was down is still caught', async () => {
    const first = setup();
    await first.watcher.tick();
    const restarted = first.make();
    first.advance(WATCH_IDLE_INTERVAL_MS);
    first.reads.set(W1, { nonce: 9, balanceWei: 300_000_000_000_000n });
    const result = await restarted.tick();
    expect(result.findings).toEqual([{ wallet: W1, chainId: 1, kind: 'unknown_activity' }]);
  });

  it('reports when it cannot read the chain several times in a row, once, and never counts blindness as safe', async () => {
    const { watcher, sent, kills, advance, fail } = setup();
    await watcher.tick();
    fail(true);
    for (let index = 0; index < WATCH_BLIND_AFTER_FAILURES + 2; index += 1) { advance(WATCH_IDLE_INTERVAL_MS); const result = await watcher.tick(); expect(result.failed).toBe(2); }
    expect(sent.filter((item) => item.dedupe.startsWith('fleet_watch:blind'))).toHaveLength(1);
    expect(kills).toEqual([]);
    fail(false);
    advance(WATCH_IDLE_INTERVAL_MS);
    expect((await watcher.tick()).checked).toBe(2);
  });

  it('reminds about left-over balance after 24 idle hours, repeats daily, and stays quiet while a run is active', async () => {
    const reads = new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 700_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    const { watcher, sent, advance, store } = setup({ reads });
    await watcher.tick(); // first sight: baseline and the clock starts
    advance(23 * HOUR);
    await watcher.tick();
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(0);
    advance(HOUR + MIN);
    await watcher.tick();
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(1);
    advance(12 * HOUR);
    await watcher.tick();
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(1);
    advance(13 * HOUR);
    await watcher.tick();
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(2);
    await store.transaction((state: BackendState) => { state.runs.push({ id: 'run1', state: 'Armed' } as never); });
    advance(30 * HOUR);
    await watcher.tick();
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(2);
  });

  it('turns a recorded funding request into one owner message, and ignores old, foreign or malformed requests', async () => {
    const { watcher, sent, store, advance } = setup();
    const record = async (data: Record<string, unknown>, at = T0.toISOString()) => store.transaction((state: BackendState) => { state.events.push({ id: `evt_${state.events.length}`, type: 'fleet_funding_requested', at, data } as never); });
    await record({ requestId: 'req1', chainId: 1, items: [{ wallet: W1, topUpWei: '500000000000000' }] });
    await record({ requestId: 'req2', chainId: 8453, items: [{ wallet: W1, topUpWei: '1' }] }); // chain not watched
    await record({ requestId: 'req3', chainId: 1, items: [{ wallet: 'nope', topUpWei: '1' }] }); // malformed
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick(); // a second pass must not send it again
    const requests = sent.filter((item) => item.kind === 'funding_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ dedupe: 'funding_request:req1', priority: 'immediate' });
    expect(requests[0]!.text).toContain('Funding needed: 0.0005 ETH');
    // a request older than a day is no longer delivered
    const later = setup();
    await later.store.transaction((state: BackendState) => { state.events.push({ id: 'evt_old', type: 'fleet_funding_requested', at: new Date(T0.getTime() - 25 * HOUR).toISOString(), data: { requestId: 'old', chainId: 1, items: [{ wallet: W1, topUpWei: '1000000000000' }] } } as never); });
    await later.watcher.tick();
    expect(later.sent.filter((item) => item.kind === 'funding_request')).toHaveLength(0);
  });

  it('refuses invalid configuration and never signs or sends anything', () => {
    const { store } = setup();
    const base = { store, ceilings: CEILINGS, treasury: TREASURY, read: async () => ({ nonce: 0, balanceWei: 0n }), alerts: { send: async () => true }, kill: async () => undefined };
    expect(() => new FleetWatcher({ ...base, targets: [] } as never)).toThrow('FLEET_WATCH_TARGETS_REQUIRED');
    expect(() => new FleetWatcher({ ...base, targets: [{ chainId: 1, address: 'nope' }] } as never)).toThrow('FLEET_WATCH_ADDRESS_INVALID');
    expect(() => new FleetWatcher({ ...base, targets: [{ chainId: 1, address: W1 }], treasury: 'nope' } as never)).toThrow('FLEET_WATCH_TREASURY_INVALID');
  });
});
