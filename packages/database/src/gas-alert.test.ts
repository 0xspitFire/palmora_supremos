import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { GasAlertRepository } from './gas-alert.js';

/** T-066: the owner's fee alerts (migration 035): complete when written, removed once, never changed or deleted. */
const repo = () => { const db = openDatabase(); return { db, repository: new GasAlertRepository(db, () => new Date('2026-10-24T12:00:00.000Z')) }; };

describe('fee alerts', () => {
  it('adds, lists and removes by the full id or its short form', () => {
    const { repository } = repo();
    const first = repository.add(1, 'below', '1.5');
    const second = repository.add(4663, 'above', '0.2');
    expect(repository.active().map((row) => [row.chainId, row.direction, row.thresholdGwei])).toEqual([[1, 'below', '1.5'], [4663, 'above', '0.2']]);
    expect(repository.remove(second.id.slice(-6))).toBe(true);
    expect(repository.remove(second.id)).toBe(false);
    expect(repository.remove('nope')).toBe(false);
    expect(repository.active().map((row) => row.id)).toEqual([first.id]);
  });

  it('refuses a bad chain, direction or threshold, and more than 20 at once (fail closed)', () => {
    const { repository } = repo();
    expect(() => repository.add(5, 'below', '1')).toThrow();
    expect(() => repository.add(1, 'sideways' as never, '1')).toThrow();
    for (const bad of ['0', '-1', 'abc', '1.2.3', '1.', '', '1e3', '100001', '1'.repeat(17)]) expect(() => repository.add(1, 'below', bad), bad).toThrow();
    for (let index = 0; index < 20; index += 1) repository.add(1, 'below', String(index + 1));
    expect(() => repository.add(1, 'below', '99')).toThrow(/too many/);
  });

  it('a removed alert frees its place; an alert never changes or disappears otherwise', () => {
    const { db, repository } = repo();
    const row = repository.add(8453, 'above', '5');
    expect(() => db.prepare("UPDATE gas_alert SET threshold_gwei = '9'").run()).toThrow(/removed, once/);
    expect(() => db.prepare('DELETE FROM gas_alert').run()).toThrow(/cannot be deleted/);
    expect(repository.remove(row.id)).toBe(true);
    expect(() => db.prepare("UPDATE gas_alert SET removed_at = '2026-10-25T00:00:00.000Z'").run()).toThrow(/removed, once/);
    expect(repository.active()).toEqual([]);
  });
});
