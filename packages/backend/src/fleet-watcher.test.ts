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

  it('reports a wallet it cannot read several times in a row, once a day per wallet, and never counts blindness as safe', async () => {
    const { watcher, sent, kills, advance, fail } = setup();
    await watcher.tick();
    fail(true);
    for (let index = 0; index < WATCH_BLIND_AFTER_FAILURES + 2; index += 1) { advance(WATCH_IDLE_INTERVAL_MS); const result = await watcher.tick(); expect(result.failed).toBe(2); }
    const blind = sent.filter((item) => item.dedupe.startsWith('fleet_watch:watcher_blind'));
    expect(blind).toHaveLength(2); // one per wallet, not repeated on later failures the same day
    expect(kills).toEqual([]);
    fail(false);
    advance(WATCH_IDLE_INTERVAL_MS);
    expect((await watcher.tick()).checked).toBe(2);
  });

  it('reports a single wallet that keeps failing even while the others read fine', async () => {
    const { reads, sent, store } = setup();
    let clock = new Date(T0);
    const watcher = new FleetWatcher({
      store,
      targets: [{ chainId: 1, address: W1 }, { chainId: 1, address: W2 }],
      ceilings: CEILINGS,
      treasury: TREASURY,
      read: async (target) => { if (target.address === W2) throw new Error('rpc'); return reads.get(target.address)!; },
      alerts: { send: async (input) => { sent.push({ kind: input.kind, dedupe: input.dedupe, priority: input.priority, text: input.text }); return true; } },
      kill: async () => undefined,
      now: () => clock,
    });
    for (let index = 0; index < WATCH_BLIND_AFTER_FAILURES; index += 1) { await watcher.tick(true); clock = new Date(clock.getTime() + WATCH_IDLE_INTERVAL_MS); }
    const blind = sent.filter((item) => item.dedupe.includes('watcher_blind'));
    expect(blind).toHaveLength(1);
    expect(blind[0]!.dedupe).toContain(W2);
    expect(watcher.isHealthy(clock)).toBe(false); // a partial check never counts as a healthy watcher
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
    await record({ requestId: 'req4', chainId: 1, items: [{ wallet: '0x9999999999999999999999999999999999999999', topUpWei: '1000000000000' }] }); // not a watched wallet: a forged request cannot name its own address
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick(); // a second pass must not send it again
    const requests = sent.filter((item) => item.kind === 'funding_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ dedupe: 'funding_request:req1', priority: 'immediate' });
    expect(requests[0]!.text).toContain('Funding needed: 0.0005 ETH');
    // a request older than a week is no longer delivered
    const later = setup();
    await later.store.transaction((state: BackendState) => { state.events.push({ id: 'evt_old', type: 'fleet_funding_requested', at: new Date(T0.getTime() - 8 * 24 * HOUR).toISOString(), data: { requestId: 'old', chainId: 1, items: [{ wallet: W1, topUpWei: '1000000000000' }] } } as never); });
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

describe('FleetWatcher review fixes (T-044)', () => {
  function build(options: { kill?: (reason: string) => Promise<void>; send?: (input: { kind: string; dedupe: string; priority: string; text: string }) => Promise<boolean>; reads?: Map<string, WalletReading>; onRead?: (target: string) => Promise<void> | void } = {}) {
    const store = new Store();
    const reads = options.reads ?? new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 300_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    const sent: Array<{ kind: string; dedupe: string; priority: string; text: string }> = [];
    const kills: string[] = [];
    let clock = new Date(T0);
    let readCount = 0;
    const watcher = new FleetWatcher({
      store,
      targets: [{ chainId: 1, address: W1 }, { chainId: 1, address: W2 }],
      ceilings: CEILINGS,
      treasury: TREASURY,
      read: async (target) => { readCount += 1; await options.onRead?.(target.address); return reads.get(target.address)!; },
      alerts: { send: async (input) => { if (sent.some((item) => item.dedupe === input.dedupe)) return false; if (options.send) await options.send(input); /* a delivery that throws records nothing, like the real sink failing before it stores the alert */ sent.push({ kind: input.kind, dedupe: input.dedupe, priority: input.priority, text: input.text }); return true; } },
      kill: options.kill ?? (async (reason) => { kills.push(reason); }),
      now: () => clock,
    });
    return { store, reads, sent, kills, watcher, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, readCount: () => readCount };
  }

  it('tells the owner plainly when the kill switch could not be engaged, and tries again at the next check', async () => {
    let fail = true;
    const attempts: string[] = [];
    const { watcher, reads, sent, advance } = build({ kill: async (reason) => { attempts.push(reason); if (fail) throw new Error('disk'); } });
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 9, balanceWei: 300_000_000_000_000n });
    const result = await watcher.tick();
    expect(result).toMatchObject({ killed: false, killFailed: true });
    const alert = sent.find((item) => item.kind === 'fleet_watch');
    expect(alert!.text).toContain('the kill switch could not be engaged');
    expect(alert!.dedupe).toContain('kill-failed');
    fail = false;
    advance(WATCH_IDLE_INTERVAL_MS);
    expect(await watcher.tick()).toMatchObject({ killed: true, killFailed: false });
    expect(attempts).toHaveLength(2);
  });

  it('confirms with a second read and then kills when the finding is real', async () => {
    const { watcher, reads, kills, advance, readCount } = build();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 6, balanceWei: 300_000_000_000_000n });
    const before = readCount();
    const result = await watcher.tick();
    expect(result.killed).toBe(true);
    expect(readCount() - before).toBe(3); // two wallets plus the confirming second read
    expect(kills).toHaveLength(1);
  });

  it('turns an anomaly that disappears on the second read into an inconsistent-answer note, with no kill', async () => {
    const reads = new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 300_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    let w1Reads = 0;
    const { watcher, sent, kills, advance } = build({ reads, onRead: (address) => { if (address === W1) { w1Reads += 1; if (w1Reads === 3) reads.set(W1, { nonce: 5, balanceWei: 300_000_000_000_000n }); } } });
    await watcher.tick(); // w1Reads = 1
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 6, balanceWei: 300_000_000_000_000n });
    const result = await watcher.tick(); // second W1 read of this check is w1Reads = 3 and shows the true state
    expect(result.killed).toBe(false);
    expect(result.findings).toEqual([{ wallet: W1, chainId: 1, kind: 'rpc_inconsistent' }]);
    expect(kills).toEqual([]);
    expect(sent.some((item) => item.dedupe.includes('rpc_inconsistent'))).toBe(true);
  });

  it('does not kill a live run when MintBot records its own transaction while the reads are in flight', async () => {
    const { watcher, reads, kills, advance, store } = build({
      onRead: async () => undefined,
    });
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    reads.set(W1, { nonce: 6, balanceWei: 100_000_000_000_000n });
    // the engine records the attempt and the reservation after the check started but before the records are looked at
    const original = reads.get.bind(reads);
    let recorded = false;
    reads.get = ((key: string) => {
      if (!recorded && key === W2) {
        recorded = true;
        void store.transaction((state: BackendState) => {
          state.intents.push({ id: 'i', runId: 'r', campaignSnapshot: { chainId: 1 } } as never);
          state.runs.push({ id: 'r', state: 'Active' } as never);
          state.attempts.push({ id: 'a', executionId: 'e', runId: 'r', wallet: W1, nonce: 5, state: 'Submitted', createdAt: T0.toISOString(), updatedAt: T0.toISOString() } as never);
          state.reservations.push({ id: 'res', runId: 'r', campaignId: 'c', chainId: 1, wallet: W1, amountWei: 250_000_000_000_000n, accountingDate: '2026-10-22', status: 'reserved', createdAt: T0.toISOString(), updatedAt: T0.toISOString() });
        });
      }
      return original(key);
    }) as never;
    const result = await watcher.tick();
    expect(result.killed).toBe(false);
    expect(kills).toEqual([]);
  });

  it('counts an attempt whose run has no recorded intent for every chain, so it never causes a false kill', async () => {
    const { watcher, reads, kills, advance, store } = build();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    await store.transaction((state: BackendState) => { state.attempts.push({ id: 'a', executionId: 'e', runId: 'ghost', wallet: W1, nonce: 5, state: 'Submitted', createdAt: T0.toISOString(), updatedAt: T0.toISOString() } as never); });
    reads.set(W1, { nonce: 6, balanceWei: 300_000_000_000_000n });
    expect((await watcher.tick()).killed).toBe(false);
    expect(kills).toEqual([]);
  });

  it('writes the finding record once per distinct state, not on every check', async () => {
    const { watcher, reads, advance, store } = build();
    await watcher.tick();
    reads.set(W1, { nonce: 6, balanceWei: 300_000_000_000_000n });
    for (let index = 0; index < 4; index += 1) { advance(WATCH_IDLE_INTERVAL_MS); await watcher.tick(); }
    expect(store.snapshot().events.filter((event) => event.type === 'fleet_watch_finding')).toHaveLength(1);
  });

  it('lets the same unresolved finding alert again the next day, but not within the day', async () => {
    const { watcher, reads, sent, advance } = build();
    await watcher.tick();
    reads.set(W1, { nonce: 6, balanceWei: 300_000_000_000_000n });
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick();
    expect(sent.filter((item) => item.dedupe.includes('unknown_activity'))).toHaveLength(1);
    advance(24 * HOUR);
    await watcher.tick();
    expect(sent.filter((item) => item.dedupe.includes('unknown_activity'))).toHaveLength(2);
  });

  it('escalates a provider that keeps reporting a lower transaction count to an immediate alert, still without a kill', async () => {
    const { watcher, reads, sent, kills, advance } = build();
    await watcher.tick();
    reads.set(W1, { nonce: 3, balanceWei: 300_000_000_000_000n });
    for (let index = 0; index < WATCH_BLIND_AFTER_FAILURES; index += 1) { advance(WATCH_IDLE_INTERVAL_MS); await watcher.tick(); }
    const blind = sent.filter((item) => item.dedupe.includes('watcher_blind'));
    expect(blind).toHaveLength(1);
    expect(blind[0]!.priority).toBe('immediate');
    expect(kills).toEqual([]);
  });

  describe('accepting a wallet state recorded by the owner command', () => {
    const accept = (store: Store, at: Date, nonce: number, address = W1) => store.transaction((state: BackendState) => { state.events.push({ id: `evt_${state.events.length}`, type: 'fleet_watch_accept', at: at.toISOString(), data: { chainId: 1, address, nonce, balanceWei: '300000000000000' } } as never); });

    it('is reported to the owner when adopted', async () => {
      const { watcher, reads, sent, advance, store } = build();
      await watcher.tick();
      reads.set(W1, { nonce: 7, balanceWei: 300_000_000_000_000n });
      advance(WATCH_IDLE_INTERVAL_MS);
      await watcher.tick();
      await accept(store, new Date(T0.getTime() + WATCH_IDLE_INTERVAL_MS + MIN), 7);
      advance(WATCH_IDLE_INTERVAL_MS);
      await watcher.tick();
      expect(sent.some((item) => item.dedupe.includes('baseline_accepted'))).toBe(true);
    });

    it('is rejected when it claims a transaction count above the chain, and the watcher keeps its baseline and keeps killing', async () => {
      const { watcher, reads, sent, kills, advance, store } = build();
      await watcher.tick();
      reads.set(W1, { nonce: 7, balanceWei: 300_000_000_000_000n });
      advance(WATCH_IDLE_INTERVAL_MS);
      await watcher.tick();
      await accept(store, new Date(T0.getTime() + WATCH_IDLE_INTERVAL_MS + MIN), 99);
      advance(WATCH_IDLE_INTERVAL_MS);
      const result = await watcher.tick();
      expect(sent.some((item) => item.dedupe.includes('accept_rejected'))).toBe(true);
      expect(result.findings).toEqual([{ wallet: W1, chainId: 1, kind: 'unknown_activity' }]);
      expect(kills.length).toBeGreaterThan(0);
    });

    it('is rejected when it is dated in the future, and does not block later real accepts', async () => {
      const { watcher, reads, sent, advance, store } = build();
      await watcher.tick();
      reads.set(W1, { nonce: 7, balanceWei: 300_000_000_000_000n });
      advance(WATCH_IDLE_INTERVAL_MS);
      await watcher.tick();
      await accept(store, new Date(T0.getTime() + 400 * 24 * HOUR), 7);
      advance(WATCH_IDLE_INTERVAL_MS);
      await watcher.tick();
      expect(sent.some((item) => item.dedupe.includes('accept_rejected'))).toBe(true);
      await accept(store, new Date(T0.getTime() + 2 * WATCH_IDLE_INTERVAL_MS + MIN), 7);
      advance(WATCH_IDLE_INTERVAL_MS);
      expect((await watcher.tick()).killed).toBe(false);
      expect(sent.some((item) => item.dedupe.includes('baseline_accepted'))).toBe(true);
    });
  });

  it('does not call a normal funding a surprise: a rise the owner was asked for raises no alert', async () => {
    const { watcher, reads, sent, advance, store } = build();
    await watcher.tick();
    advance(WATCH_IDLE_INTERVAL_MS);
    await store.transaction((state: BackendState) => { state.events.push({ id: 'evt_req', type: 'fleet_funding_requested', at: new Date(T0.getTime() + WATCH_IDLE_INTERVAL_MS - MIN).toISOString(), data: { requestId: 'r1', chainId: 1, items: [{ wallet: W2, topUpWei: '700000000000000' }] } } as never); });
    reads.set(W2, { nonce: 2, balanceWei: 700_000_000_000_000n });
    await watcher.tick();
    expect(sent.some((item) => item.dedupe.includes('rise_above_limit'))).toBe(false);
  });

  it('keeps the reminder due when its delivery failed, so it is retried instead of waiting another day', async () => {
    let failing = true;
    const reads = new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 700_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    const { watcher, sent, advance } = build({ reads, send: async (input) => { if (input.kind === 'excess_balance' && failing) throw new Error('telegram down'); return true; } });
    await watcher.tick();
    advance(25 * HOUR);
    await watcher.tick();
    failing = false;
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick();
    // the failed attempt recorded nothing, and ten minutes later (not a day later) the reminder went out
    expect(sent.filter((item) => item.kind === 'excess_balance')).toHaveLength(1);
  });

  it('reminds each wallet that needs it, even when two wallets come due on different days', async () => {
    const reads = new Map<string, WalletReading>([[W1, { nonce: 5, balanceWei: 700_000_000_000_000n }], [W2, { nonce: 2, balanceWei: 0n }]]);
    const { watcher, sent, advance } = build({ reads });
    await watcher.tick();
    advance(25 * HOUR);
    await watcher.tick();
    reads.set(W2, { nonce: 2, balanceWei: 800_000_000_000_000n });
    advance(WATCH_IDLE_INTERVAL_MS);
    await watcher.tick();
    advance(25 * HOUR);
    await watcher.tick();
    const reminders = sent.filter((item) => item.kind === 'excess_balance');
    expect(reminders.some((item) => item.dedupe.includes(W2))).toBe(true);
  });

  it('says which wallets it watches and whether it is alive, for the arm gate', async () => {
    const { watcher, advance } = build();
    expect(watcher.covers(1, [W1, W2])).toBe(true);
    expect(watcher.covers(1, [W1, '0x9999999999999999999999999999999999999999'])).toBe(false);
    expect(watcher.covers(8453, [W1])).toBe(false);
    expect(watcher.covers(1, [])).toBe(false);
    expect(watcher.isHealthy()).toBe(false); // never checked yet
    await watcher.tick();
    expect(watcher.isHealthy()).toBe(true);
    advance(31 * MIN);
    expect(watcher.isHealthy()).toBe(false); // quiet for more than three idle intervals
  });

  it('reports a watcher that the service itself sees failing', async () => {
    const { watcher, sent } = build();
    await watcher.reportBlind();
    expect(sent.some((item) => item.dedupe.includes('watcher_blind') && item.dedupe.includes('service'))).toBe(true);
  });
});
