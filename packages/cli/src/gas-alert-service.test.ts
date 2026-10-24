import { describe, expect, it } from 'vitest';
import type { GasAlertRow } from '@mint-bot/database';
import { createGasAlertChecker, gasAlertSentence, startGasAlerts } from './gas-alert-service.js';

/** T-066: a fee alert fires once when the price crosses, and again only after it has gone back. */
const alert = (id: string, chainId: GasAlertRow['chainId'], direction: GasAlertRow['direction'], thresholdGwei: string): GasAlertRow => ({ id, chainId, direction, thresholdGwei, createdAt: '2026-10-24T12:00:00.000Z' });

function setup(initial: GasAlertRow[]) {
  const state = { alerts: initial, prices: new Map<number, number | undefined>(), sent: [] as string[], failDelivery: false };
  const checker = createGasAlertChecker({ alerts: () => state.alerts, gasGwei: async (chainId) => { if (state.prices.get(chainId) === Number.NEGATIVE_INFINITY) throw new Error('rpc down'); return state.prices.get(chainId); }, alert: async (text) => { if (state.failDelivery) throw new Error('telegram down'); state.sent.push(text); }, now: () => new Date('2026-10-24T12:00:00.000Z'), minGapMs: 0 });
  return { state, checker };
}

describe('fee alert checker', () => {
  it('fires once when the price goes below the line, stays quiet while it stays there, and fires again after a reset', async () => {
    const { state, checker } = setup([alert('a1', 1, 'below', '1')]);
    state.prices.set(1, 2);
    expect(await checker.tick()).toBe(0);
    state.prices.set(1, 0.5);
    expect(await checker.tick()).toBe(1);
    expect(state.sent[0]).toContain('Ethereum fees below 1 gwei');
    expect(await checker.tick()).toBe(0);
    state.prices.set(1, 3);
    await checker.tick();
    state.prices.set(1, 0.4);
    expect(await checker.tick()).toBe(1);
  });

  it('"above" works the other way, and an equal price is not a crossing', async () => {
    const { state, checker } = setup([alert('a1', 4663, 'above', '0.2')]);
    state.prices.set(4663, 0.2);
    expect(await checker.tick()).toBe(0);
    state.prices.set(4663, 0.21);
    expect(await checker.tick()).toBe(1);
  });

  it('a price that cannot be read changes nothing: no alert and no reset', async () => {
    const { state, checker } = setup([alert('a1', 1, 'below', '1')]);
    state.prices.set(1, 0.5);
    await checker.tick();
    state.prices.set(1, undefined);
    expect(await checker.tick()).toBe(0);
    state.prices.set(1, Number.NEGATIVE_INFINITY);
    expect(await checker.tick()).toBe(0);
    state.prices.set(1, 0.4);
    expect(await checker.tick()).toBe(0);
  });

  it('reads each chain once per pass, keeps alerts apart, and forgets a removed alert', async () => {
    const reads: number[] = [];
    const prices = new Map<number, number>([[1, 0.5], [8453, 9]]);
    const rows = [alert('a1', 1, 'below', '1'), alert('a2', 1, 'below', '0.6'), alert('a3', 8453, 'above', '5')];
    const sent: string[] = [];
    const checker = createGasAlertChecker({ alerts: () => rows, gasGwei: async (chainId) => { reads.push(chainId); return prices.get(chainId); }, alert: async (text) => { sent.push(text); }, minGapMs: 0 });
    expect(await checker.tick()).toBe(3);
    expect(reads).toEqual([1, 8453]);
    rows.splice(0, 1);
    prices.set(1, 5);
    await checker.tick();
    prices.set(1, 0.5);
    expect(await checker.tick()).toBe(1);
  });

  it('a failed delivery never stops the others, and the sentence names chain, direction and number', async () => {
    const { state, checker } = setup([alert('a1', 1, 'below', '1')]);
    state.prices.set(1, 0.5);
    state.failDelivery = true;
    expect(await checker.tick()).toBe(0);
    expect(gasAlertSentence(alert('x', 8453, 'above', '3'))).toBe('Base fees above 3 gwei');
  });

  it('a failed delivery is tried again on the next pass, and a flapping price is told at most once per gap', async () => {
    let clock = new Date('2026-10-24T12:00:00.000Z').getTime();
    const sent: Array<{ text: string; dedupe: string }> = [];
    let failing = true;
    let price = 0.5;
    const checker = createGasAlertChecker({ alerts: () => [alert('a1', 1, 'below', '1')], gasGwei: async () => price, alert: async (text, dedupe) => { if (failing) throw new Error('down'); sent.push({ text, dedupe }); }, now: () => new Date(clock) });
    expect(await checker.tick()).toBe(0);
    failing = false;
    expect(await checker.tick()).toBe(1);
    // It flaps: back above, below again a minute later. Inside the gap nothing more is sent; after the gap it is.
    price = 3; clock += 60_000; await checker.tick();
    price = 0.4; clock += 60_000;
    expect(await checker.tick()).toBe(0);
    price = 3; clock += 60_000; await checker.tick();
    price = 0.4; clock += 11 * 60_000;
    expect(await checker.tick()).toBe(1);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((item) => item.dedupe)).size).toBe(2);
  });

  it('a price read that never answers does not hold up the pass', async () => {
    const checker = createGasAlertChecker({ alerts: () => [alert('a1', 1, 'below', '1')], gasGwei: () => new Promise<number>(() => undefined), alert: async () => undefined, readTimeoutMs: 20 });
    expect(await checker.tick()).toBe(0);
  });

  it('the timer runs one pass at a time and stops', async () => {
    let calls = 0;
    const service = startGasAlerts({ alerts: () => { calls += 1; return []; }, gasGwei: async () => undefined, alert: async () => undefined }, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.stop();
    const seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(seen);
    expect(seen).toBeGreaterThan(0);
  });
});
