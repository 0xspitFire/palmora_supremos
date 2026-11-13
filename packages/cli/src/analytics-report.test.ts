import { expect, it } from 'vitest';
import { DurableStore } from '@mint-bot/backend';
import { describeAnalytics } from './analytics-report.js';
it('keeps an empty retained history explicitly unknown rather than inventing a profit or permitting execution', async () => {
  const store = new DurableStore(); await store.open();
  const before = store.snapshot();
  const text = describeAnalytics(before, new Date('2026-11-13T00:00:00Z'));
  expect(text).toContain('shadow only'); expect(text).toContain('Realized PnL: unknown');
  expect(text).toContain('Unrealized PnL: unknown'); expect(text).toContain('does not change live scores or authorize minting');
  expect(store.snapshot()).toEqual(before);
});
