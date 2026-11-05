import { describe, expect, it } from 'vitest';
import { DurableStore } from './store.js';
import { FleetWatcher, type TreasuryWatchInput, type TreasuryWatchProof, type WalletReading } from './fleet-watcher.js';
import type { BackendState } from './types.js';
import type { SystemCard } from './system-card.js';

const address = '0x1111111111111111111111111111111111111111';
const treasury = '0x2222222222222222222222222222222222222222';
const at = '2026-11-05T09:00:00.000Z';
const hash = `0x${'ab'.repeat(32)}`;
const proofFor = (input: TreasuryWatchInput): TreasuryWatchProof => ({
  chainId: input.target.chainId, address, fromNonce: input.baseline.nonce, toNonce: input.reading.nonce,
  nonce: input.reading.nonce, balanceWei: input.reading.balanceWei,
  baselineNonce: input.baseline.nonce, baselineBalanceWei: input.baseline.balanceWei, baselineObservedAt: input.baseline.observedAt,
  hashes: [hash], blockNumber: 10n, blockHash: hash, totalValueWei: 90n, totalFeeWei: 10n,
});
function setup(verify?: (input: TreasuryWatchInput) => Promise<TreasuryWatchProof | undefined>, store = new DurableStore()) {
  const readings = new Map<number, WalletReading>([[1, { nonce: 7, balanceWei: 300n }], [8453, { nonce: 7, balanceWei: 300n }]]);
  const cards: SystemCard[] = [];
  const identities = new Set<string>();
  const make = () => new FleetWatcher({
    store, targets: [1, 8453].map(chainId => ({ chainId, address })),
    treasury, ceilings: { 1: { walletMaxWei: 400n, fleetMaxWei: 2_000n }, 8453: { walletMaxWei: 400n, fleetMaxWei: 2_000n } },
    read: async target => readings.get(target.chainId)!,
    ...(verify ? { verifyTreasuryReturn: verify } : {}),
    alerts: { send: async input => { if (identities.has(input.dedupe)) return false; identities.add(input.dedupe); cards.push(input.system); return true; } },
    kill: async () => { await store.transaction(state => { state.killed = true; }); },
    now: () => new Date(at),
  });
  return { store, readings, cards, make, watcher: make() };
}

describe('chain-isolated watcher explanations and verified treasury returns', () => {
  it.each([1, 8453])('uses only chain %s records to explain that chain and never another chain nonce', async chainId => {
    const h = setup(); await h.watcher.tick(true);
    await h.store.transaction(state => {
      state.intents.push({ runId: 'run', campaignSnapshot: { chainId } } as never);
      state.attempts.push({ runId: 'run', wallet: address, nonce: 7 } as never);
      state.reservations.push({ runId: 'run', wallet: address, chainId, amountWei: 100n, status: 'settled', updatedAt: at } as never);
    });
    h.readings.set(1, { nonce: 8, balanceWei: 200n });
    h.readings.set(8453, { nonce: 8, balanceWei: 200n });
    const result = await h.watcher.tick(true);
    expect(result.findings).toEqual([{ wallet: address, chainId: chainId === 1 ? 8453 : 1, kind: 'unknown_activity' }]);
  });

  it('records the proof and advances only the proven chain baseline; later activity is still guarded', async () => {
    let verify = true;
    const h = setup(async input => verify ? proofFor(input) : undefined);
    await h.watcher.tick(true);
    h.readings.set(1, { nonce: 8, balanceWei: 200n });
    expect((await h.watcher.tick(true)).killed).toBe(false);
    const events = h.store.snapshot().events;
    expect(events.filter(event => event.type === 'fleet_watch_treasury_return_verified')).toHaveLength(1);
    expect(events.filter(event => event.type === 'fleet_watch_baseline' && event.data.chainId === 1).at(-1)?.data.nonce).toBe(8);
    expect(events.filter(event => event.type === 'fleet_watch_baseline' && event.data.chainId === 8453).at(-1)?.data.nonce).toBe(7);
    verify = false;
    h.readings.set(1, { nonce: 9, balanceWei: 190n });
    expect((await h.watcher.tick(true)).killed).toBe(true);
  });

  it.each(['wrong-chain', 'wrong-nonce', 'wrong-baseline', 'high-fee', 'shortfall', 'unknown', 'throws'])('keeps the guard for %s proof', async kind => {
    const h = setup(async input => {
      const proof = proofFor(input);
      if (kind === 'wrong-chain') proof.chainId = 4663;
      if (kind === 'wrong-nonce') proof.toNonce++;
      if (kind === 'wrong-baseline') proof.baselineNonce++;
      if (kind === 'high-fee') proof.totalFeeWei = 401n;
      if (kind === 'shortfall') proof.totalValueWei = 1n;
      if (kind === 'unknown') return undefined;
      if (kind === 'throws') throw new Error('private provider error');
      return proof;
    });
    await h.watcher.tick(true); h.readings.set(1, { nonce: 8, balanceWei: 200n });
    expect((await h.watcher.tick(true)).killed).toBe(true);
    expect(h.store.snapshot().events.some(event => event.type === 'fleet_watch_treasury_return_verified')).toBe(false);
  });

  it.each(['active', 'reserved', 'unknown-chain', 'new-active'])('does not exempt while %s exposure exists or appears during verification', async kind => {
    let called = false;
    const h = setup(async input => {
      called = true;
      if (kind === 'new-active') await h.store.transaction(state => { state.runs.push({ state: 'Active' } as never); });
      return proofFor(input);
    });
    await h.watcher.tick(true);
    await h.store.transaction(state => {
      if (kind === 'active') state.runs.push({ state: 'Armed' } as never);
      if (kind === 'reserved' || kind === 'unknown-chain') state.reservations.push({ wallet: address, status: 'reserved', amountWei: 0n, ...(kind === 'reserved' ? { chainId: 1 } : {}) } as never);
    });
    h.readings.set(1, { nonce: 8, balanceWei: 200n });
    expect((await h.watcher.tick(true)).killed).toBe(true);
    expect(called).toBe(kind === 'new-active');
  });

  it.each(['active', 'reservation', 'owner-accept', 'ledger-change'])('rechecks %s atomically when committing the verified return', async kind => {
    class RacingStore extends DurableStore {
      beforeNext?: (state: BackendState) => void;
      override transaction<T>(mutate: (state: BackendState) => T): Promise<T> {
        return super.transaction(state => {
          const before = this.beforeNext; this.beforeNext = undefined; before?.(state);
          return mutate(state);
        });
      }
    }
    const store = new RacingStore();
    let inserted = false;
    const h = setup(async input => {
      store.beforeNext = state => {
        inserted = true;
        if (kind === 'active') state.runs.push({ state: 'Active' } as never);
        if (kind === 'reservation') state.reservations.push({ wallet: address, status: 'reserved', chainId: 1, amountWei: 0n } as never);
        if (kind === 'owner-accept') state.events.push({ id: 'owner', type: 'fleet_watch_accept', at,
          data: { chainId: 1, address, nonce: 8, balanceWei: '199', observedAt: at } });
        if (kind === 'ledger-change') {
          state.intents.push({ runId: 'other', campaignSnapshot: { chainId: 1 } } as never);
          state.attempts.push({ runId: 'other', wallet: address, nonce: 8 } as never);
        }
      };
      return proofFor(input);
    }, store);
    await h.watcher.tick(true); h.readings.set(1, { nonce: 8, balanceWei: 200n });
    expect((await h.watcher.tick(true)).killed).toBe(true);
    expect(inserted).toBe(true);
    expect(store.snapshot().events.some(event => event.type === 'fleet_watch_treasury_return_verified')).toBe(false);
    expect(store.snapshot().events.filter(event => event.type === 'fleet_watch_baseline' && event.data.chainId === 1).at(-1)?.data.nonce).toBe(7);
  });

  it('offers fresh owner review only on repeat, survives restart, and resets after acceptance', async () => {
    const h = setup(); await h.watcher.tick(true);
    h.readings.set(1, { nonce: 8, balanceWei: 200n });
    await h.watcher.tick(true);
    expect(h.cards[0]?.watchReview).toBeUndefined();
    await h.make().tick(true);
    expect(h.cards[1]?.watchReview).toEqual({ chainId: 1, address });
    await h.make().tick(true);
    expect(h.cards).toHaveLength(2);
    await h.watcher.acceptCurrent({ chainId: 1, address }, { nonce: 8, balanceWei: 200n });
    await h.watcher.tick(true);
    h.readings.set(1, { nonce: 9, balanceWei: 190n });
    await h.watcher.tick(true);
    expect(h.cards.at(-1)?.watchReview).toBeUndefined();
  });
});
