import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ROBINHOOD_EVIDENCE_STEPS, assertRobinhoodLiveAllowed, validRobinhoodEnablement } from './robinhood-enablement.js';

const now = new Date('2026-10-12T12:00:00.000Z');
const good = () => ({
  recordId: 'rh-enable-1',
  approvedBy: 'owner-cli',
  approvedAt: '2026-10-12T10:00:00.000Z',
  expiresAt: '2026-10-19T10:00:00.000Z',
  paidAllowed: false,
  evidence: Object.fromEntries(ROBINHOOD_EVIDENCE_STEPS.map((step) => [step, true])),
});

describe('Robinhood enablement record (Key 2)', () => {
  it('accepts exactly one complete, owner-written, current record', () => {
    expect(validRobinhoodEnablement(good(), now)).toMatchObject({ recordId: 'rh-enable-1', paidAllowed: false });
    expect(() => assertRobinhoodLiveAllowed('free', good(), now)).not.toThrow();
  });

  it('refuses with the old error codes when there is no record', () => {
    for (const nothing of [undefined, null, 'on', 1, true, [], {}]) {
      expect(() => assertRobinhoodLiveAllowed('free', nothing, now)).toThrow('ROBINHOOD_EXECUTION_DISABLED');
      expect(() => assertRobinhoodLiveAllowed('paid', nothing, now)).toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
    }
  });

  it('refuses a record that is expired, not yet approved, backwards, or not written by the owner command', () => {
    for (const bad of [
      { ...good(), expiresAt: '2026-10-12T12:00:00.000Z' },
      { ...good(), expiresAt: '2026-10-12T09:00:00.000Z' },
      { ...good(), approvedAt: '2026-10-12T13:00:00.000Z' },
      { ...good(), approvedBy: 'session' },
      { ...good(), approvedBy: 'owner' },
      { ...good(), recordId: '' },
      { ...good(), approvedAt: 'yesterday' },
      { ...good(), expiresAt: '2026-10-19' },
    ]) expect(validRobinhoodEnablement(bad, now)).toBeUndefined();
  });

  it('refuses a record missing any of E1 to E7, with a step that is not exactly true, or with extra steps or fields', () => {
    for (const step of ROBINHOOD_EVIDENCE_STEPS) {
      const missing = good();
      delete (missing.evidence as Record<string, boolean>)[step];
      expect(validRobinhoodEnablement(missing, now)).toBeUndefined();
      for (const wrong of [false, 'true', 1, null]) expect(validRobinhoodEnablement({ ...good(), evidence: { ...good().evidence, [step]: wrong } }, now)).toBeUndefined();
    }
    expect(validRobinhoodEnablement({ ...good(), evidence: { ...good().evidence, E8: true } }, now)).toBeUndefined();
    expect(validRobinhoodEnablement({ ...good(), extra: 1 }, now)).toBeUndefined();
    expect(validRobinhoodEnablement({ ...good(), paidAllowed: 'yes' }, now)).toBeUndefined();
    expect(validRobinhoodEnablement(good(), new Date('nope'))).toBeUndefined();
  });

  it('allows paid only when the record says so, and never throws from the validator', () => {
    expect(() => assertRobinhoodLiveAllowed('paid', good(), now)).toThrow('ROBINHOOD_PAID_MINTS_DISABLED');
    expect(() => assertRobinhoodLiveAllowed('paid', { ...good(), paidAllowed: true }, now)).not.toThrow();
    expect(() => validRobinhoodEnablement({ get recordId(): string { throw new Error('x'); } }, now)).not.toThrow();
  });

  it('is not turned on by an environment variable or setting', () => {
    process.env.MINT_BOT_ROBINHOOD_ENABLED = 'true';
    process.env.ROBINHOOD_EXECUTION_ENABLED = '1';
    try { expect(() => assertRobinhoodLiveAllowed('free', undefined, now)).toThrow('ROBINHOOD_EXECUTION_DISABLED'); }
    finally { delete process.env.MINT_BOT_ROBINHOOD_ENABLED; delete process.env.ROBINHOOD_EXECUTION_ENABLED; }
  });
});

describe('every Robinhood refusal site goes through the one policy', () => {
  const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

  it('has no raw Robinhood refusal left in the coordinator or the canonical store', async () => {
    for (const name of ['coordinator.ts', 'canonical-store.ts']) {
      const source = await read(name);
      expect(source, name).not.toMatch(/throw new Error\('ROBINHOOD_(EXECUTION|PAID_MINTS)_DISABLED'\)/);
      expect(source, name).toContain('assertRobinhoodLiveAllowed(');
    }
    expect((await read('coordinator.ts')).match(/assertRobinhoodLiveAllowed\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect((await read('canonical-store.ts')).match(/assertRobinhoodLiveAllowed\(/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('has a store that can only answer "no record" until the owner command exists', async () => {
    const source = await read('canonical-store.ts');
    expect(source).toMatch(/public robinhoodEnablement\(\): unknown \{ return undefined; \}/);
    expect(await read('coordinator.ts')).toContain('this.canonicalStore()?.robinhoodEnablement?.()');
  });
});
