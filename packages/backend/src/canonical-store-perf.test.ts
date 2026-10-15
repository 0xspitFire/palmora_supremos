import { describe, expect, it } from 'vitest';
import { CanonicalStoreBridge } from './canonical-store.js';
import { ETHEREUM, NOW, fixture, close } from './canonical-fixtures.js';

/**
 * The trial's service burned a whole CPU core because every store transaction re-read and re-compared every event
 * (2026-10-15). These tests pin that the faster reads and writes give exactly the same answers as a fresh full read.
 */
describe('canonical store: event cache and transaction speed-ups keep the same answers', () => {
  const push = (id: string, at: string, data: Record<string, unknown> = {}, runId?: string) => ({ id, ...(runId ? { runId } : {}), type: 'perf_test', at, data });

  it('shows appended events in time-then-id order, the same as a store that reads everything fresh', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.store.transaction((state) => { state.events.push(push('evt_b', '2026-10-15T10:00:00.000Z'), push('evt_a', '2026-10-15T10:00:00.000Z'), push('evt_c', '2026-10-15T09:00:00.000Z')); });
      await value.store.transaction((state) => { state.events.push(push('evt_d', '2026-10-15T11:00:00.000Z'), push('evt_older', '2026-10-15T08:00:00.000Z')); });
      const cached = value.store.snapshot().events.filter((event) => event.type === 'perf_test').map((event) => event.id);
      expect(cached).toEqual(['evt_older', 'evt_c', 'evt_a', 'evt_b', 'evt_d']);
      const fresh = new CanonicalStoreBridge(value.db, { now: () => new Date(NOW) });
      await fresh.open();
      expect(fresh.snapshot().events).toEqual(value.store.snapshot().events);
    } finally { await close(value); }
  });

  it('reads bigint-looking text the same way as before, from the cache and from a fresh read', async () => {
    const value = await fixture(ETHEREUM);
    try {
      // Bigints are stored as plain digits; only text shaped like 7n is turned back into a bigint (unchanged behaviour).
      await value.store.transaction((state) => { state.events.push(push('evt_big', '2026-10-15T10:00:00.000Z', { amountWei: 123456789012345678901n, marker: '7n', note: 'plain 5n text', list: [1n, 'x', '-3n'] })); });
      const first = value.store.snapshot().events.find((event) => event.id === 'evt_big');
      expect(first?.data).toEqual({ amountWei: '123456789012345678901', marker: 7n, note: 'plain 5n text', list: ['1', 'x', -3n] });
      const fresh = new CanonicalStoreBridge(value.db, { now: () => new Date(NOW) });
      await fresh.open();
      expect(fresh.snapshot().events.find((event) => event.id === 'evt_big')).toEqual(first);
    } finally { await close(value); }
  });

  it('does not let a changed snapshot change what the next snapshot shows', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.store.transaction((state) => { state.events.push(push('evt_keep', '2026-10-15T10:00:00.000Z', { value: 1 })); });
      const first = value.store.snapshot();
      const event = first.events.find((item) => item.id === 'evt_keep');
      if (!event) throw new Error('missing');
      event.type = 'tampered';
      event.data.value = 99;
      first.events.length = 0;
      const second = value.store.snapshot().events.find((item) => item.id === 'evt_keep');
      expect(second).toMatchObject({ type: 'perf_test', data: { value: 1 } });
    } finally { await close(value); }
  });

  it('persists only new events, ignores a rewrite of an old one, and still saves other changes made in the same transaction', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.store.transaction((state) => { state.events.push(push('evt_once', '2026-10-15T10:00:00.000Z', { n: 1 })); });
      await value.store.transaction((state) => {
        const old = state.events.find((item) => item.id === 'evt_once');
        if (old) old.data = { n: 2 };
        state.events.push(push('evt_two', '2026-10-15T10:01:00.000Z'));
        state.runtime = { ...state.runtime, blockingReasons: [...state.runtime.blockingReasons, 'PERF_TEST_REASON'] };
      });
      const fresh = new CanonicalStoreBridge(value.db, { now: () => new Date(NOW) });
      await fresh.open();
      const events = fresh.snapshot().events.filter((item) => item.type === 'perf_test');
      expect(events.map((item) => item.id)).toEqual(['evt_once', 'evt_two']);
      expect(events[0]?.data).toEqual({ n: 1 });
      expect(fresh.snapshot().runtime.blockingReasons).toContain('PERF_TEST_REASON');
    } finally { await close(value); }
  });

  it('stays fast with thousands of events: 30 transactions over 4,000 events finish quickly', async () => {
    const value = await fixture(ETHEREUM);
    try {
      await value.store.transaction((state) => { for (let index = 0; index < 4000; index += 1) state.events.push(push(`evt_bulk_${String(index).padStart(5, '0')}`, new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), { index, payload: 'x'.repeat(200) })); });
      const started = Date.now();
      for (let index = 0; index < 30; index += 1) await value.store.transaction((state) => { state.events.push(push(`evt_tick_${index}`, new Date(Date.UTC(2026, 9, 2, 0, 0, index)).toISOString())); });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(value.store.snapshot().events.filter((item) => item.type === 'perf_test')).toHaveLength(4030);
    } finally { await close(value); }
  });
});
