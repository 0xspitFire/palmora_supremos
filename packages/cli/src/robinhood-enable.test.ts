import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ENABLEMENT_DAYS, EVIDENCE_STEPS, assertEnableAllowed, checkEvidenceFile, confirmationDigest, enablePhrase, runRobinhoodEnable } from './robinhood-enable.js';
import { robinhoodGrantFrom } from './engine-adapter.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const entry = (checkedOn = '2026-10-18') => ({ passed: true, checkedOn, reference: 'Docs/robinhood-evidence.md section 3' });
const goodFile = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...Object.fromEntries(EVIDENCE_STEPS.map((step) => [step, entry()])), ...overrides });

describe('evidence file for switching Robinhood on', () => {
  it('accepts a complete, recent file and reports its digest', () => {
    const result = checkEvidenceFile(goodFile(), NOW);
    expect(result.problems).toEqual([]);
    expect(result.ok).toEqual([...EVIDENCE_STEPS]);
    expect(result.fileDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true });
  });

  it('names each missing, failed, old, future, undated or unreferenced step in plain words', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ E3: undefined }, /E3 .*missing/],
      [{ E2: { ...entry(), passed: false } }, /E2 .*not marked passed/],
      [{ E4: { ...entry(), passed: 'yes' } }, /E4 .*not marked passed/],
      [{ E5: entry('2026-08-01') }, /E5 was checked more than 30 days ago/],
      [{ E6: entry('2026-11-30') }, /E6 is dated in the future/],
      [{ E1: { ...entry(), checkedOn: 'last week' } }, /E1 needs a date/],
      [{ E7: { ...entry(), reference: 'ok' } }, /E7 needs a short reference/],
      [{ E7: { ...entry(), reference: 'x'.repeat(301) } }, /E7 needs a short reference/],
      [{ E8: entry() }, /Unknown entries/],
    ];
    for (const [overrides, expected] of cases) {
      const result = checkEvidenceFile(goodFile(overrides), NOW);
      expect(result.evidence, JSON.stringify(overrides)).toBeUndefined();
      expect(result.problems.join(' '), JSON.stringify(overrides)).toMatch(expected);
    }
  });

  it('refuses files that are not a JSON object', () => {
    for (const text of ['', 'nope', '[]', '"E1"', 'null', '5']) {
      const result = checkEvidenceFile(text, NOW);
      expect(result.evidence).toBeUndefined();
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('does not count inherited properties as steps', () => {
    const result = checkEvidenceFile(JSON.stringify(Object.fromEntries(EVIDENCE_STEPS.slice(0, 6).map((step) => [step, entry()]))), NOW);
    expect(result.ok).toHaveLength(6);
    expect(result.problems.join(' ')).toMatch(/E7 .*missing/);
  });
});

describe('assertEnableAllowed: every condition must hold before anything is written', () => {
  const evidence = checkEvidenceFile(goodFile(), NOW);
  const phrase = enablePhrase(evidence.fileDigest ?? '', ENABLEMENT_DAYS);
  const facts = (overrides: Record<string, unknown> = {}) => ({ evidence, ethereumLiveMintProven: true, confirm: phrase, days: ENABLEMENT_DAYS, ...overrides }) as never;

  it('passes with a proven Ethereum mint, complete evidence and the exact phrase, and returns a digest that depends on the phrase and the file', () => {
    const allowed = assertEnableAllowed(facts());
    expect(allowed.phrase).toBe(phrase);
    expect(allowed.digest).toBe(confirmationDigest(phrase, evidence.fileDigest ?? ''));
    expect(allowed.digest).not.toBe(confirmationDigest(phrase, 'f'.repeat(64)));
    expect(allowed.evidence).toEqual({ E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true });
  });

  it('fails closed: no Ethereum live mint, bad evidence, missing or wrong phrase, bad days', () => {
    expect(() => assertEnableAllowed(facts({ ethereumLiveMintProven: false }))).toThrow('ETHEREUM_LIVE_MINT_REQUIRED');
    expect(() => assertEnableAllowed(facts({ evidence: checkEvidenceFile(goodFile({ E3: undefined }), NOW) }))).toThrow('EVIDENCE_INCOMPLETE');
    expect(() => assertEnableAllowed(facts({ evidence: { ok: [], problems: [] } }))).toThrow('EVIDENCE_INCOMPLETE');
    expect(() => assertEnableAllowed(facts({ confirm: undefined }))).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(() => assertEnableAllowed(facts({ confirm: `${phrase} ` }))).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    expect(() => assertEnableAllowed(facts({ confirm: enablePhrase('0'.repeat(64), ENABLEMENT_DAYS) }))).toThrow('CONFIRMATION_PHRASE_MISMATCH');
    for (const days of [0, 8, 1.5, Number.NaN, -1]) expect(() => assertEnableAllowed(facts({ days })), String(days)).toThrow('DAYS_INVALID');
    // The phrase for one length of enablement does not work for another.
    expect(() => assertEnableAllowed(facts({ days: 3 }))).toThrow('CONFIRMATION_PHRASE_MISMATCH');
  });
});

describe('the engine grant is made in one place, from the stored owner record only', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const record = (over: Record<string, unknown> = {}) => ({ recordId: 'rh-1', approvedBy: 'owner-cli', approvedAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-10-27T10:00:00.000Z', paidAllowed: false, evidence: Object.fromEntries(EVIDENCE_STEPS.map((step) => [step, true])), ...over });

  it('gives a frozen grant with only the expiry and the paid flag for a valid record, and none otherwise', () => {
    const grant = robinhoodGrantFrom(record(), now);
    expect(grant).toEqual({ expiresAt: '2026-10-27T10:00:00.000Z', paidAllowed: false });
    expect(Object.isFrozen(grant)).toBe(true);
    for (const bad of [undefined, null, {}, record({ approvedBy: 'session' }), record({ expiresAt: '2026-10-20T12:00:00.000Z' }), record({ evidence: { E1: true } }), 'on', true]) expect(robinhoodGrantFrom(bad, now)).toBeUndefined();
  });

  it('is wired so that only the stored record feeds it, only for chain 4663, and no caller option can replace it', async () => {
    const adapter = await readFile(new URL('./engine-adapter.ts', import.meta.url), 'utf8');
    expect(adapter).toContain('campaign.chainId === 4663 ? robinhoodGrantFrom(options.robinhoodEnablement?.(), new Date()) : undefined');
    const runtime = await readFile(new URL('./runtime.ts', import.meta.url), 'utf8');
    const spread = runtime.indexOf('...configuredAdapterOptions,');
    const source = runtime.indexOf('robinhoodEnablement: () => (store as');
    expect(spread).toBeGreaterThan(0);
    expect(source).toBeGreaterThan(spread);
  });
});

describe('runRobinhoodEnable: the whole command with a stand-in store', () => {
  const NOW2 = new Date('2026-10-20T12:00:00.000Z');
  const file = goodFile();
  const digest = checkEvidenceFile(file, NOW2).fileDigest ?? '';
  const phrase = enablePhrase(digest, 7);
  const makeStore = (over: Partial<{ proven: boolean; record: unknown }> = {}) => {
    const writes: unknown[] = [];
    const store = { ethereumLiveMintProven: () => over.proven ?? true, robinhoodEnablement: () => over.record, enableRobinhood: (input: unknown) => { writes.push(input); } };
    return { store, writes };
  };
  const run = (store: unknown, over: Record<string, unknown> = {}) => runRobinhoodEnable({ action: 'record', evidenceText: file, evidenceFile: 'e.json', days: 7, confirm: phrase, now: NOW2, store: store as never, newId: () => 'rh_enable_test', ...over });

  it('status never writes, says what is missing, and prints the exact command only when everything is ready', () => {
    const ready = makeStore();
    const out = run(ready.store, { action: 'status', confirm: undefined });
    expect(out).toMatchObject({ state: 'ReadyToRecord', ethereumLiveMintConfirmed: true, problems: [], currentlyEnabledUntil: null });
    expect(String(out.copyThisToRecord)).toContain(`--confirm "${phrase}"`);
    expect(ready.writes).toEqual([]);
    const notProven = makeStore({ proven: false });
    const missing = run(notProven.store, { action: 'status', confirm: undefined, evidenceText: goodFile({ E3: undefined }) });
    expect(missing).toMatchObject({ state: 'NotReady', ethereumLiveMintConfirmed: false });
    expect(String((missing.problems as string[]).join(' '))).toMatch(/No confirmed live Ethereum mint.*E3 .*missing/);
    expect(missing.copyThisToRecord).toBeUndefined();
    expect(notProven.writes).toEqual([]);
  });

  it('record writes exactly once, with the evidence, the digest and a 7-day expiry, only after every check passed', () => {
    const { store, writes } = makeStore();
    const out = run(store);
    expect(out).toMatchObject({ state: 'Enabled', expiresAt: '2026-10-27T12:00:00.000Z' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ id: 'rh_enable_test', approvedAt: NOW2.toISOString(), expiresAt: '2026-10-27T12:00:00.000Z', evidence: { E1: true, E2: true, E3: true, E4: true, E5: true, E6: true, E7: true }, confirmationDigest: confirmationDigest(phrase, digest) });
  });

  it('record writes nothing when any condition fails', () => {
    const cases: Array<[string, Record<string, unknown>, Parameters<typeof makeStore>[0]?]> = [
      ['no proof', {}, { proven: false }],
      ['no phrase', { confirm: undefined }],
      ['wrong phrase', { confirm: 'ENABLE-ROBINHOOD-FREE 7-DAYS 00000000' }],
      ['bad evidence', { evidenceText: goodFile({ E5: { ...entry(), passed: false } }) }],
      ['old evidence', { evidenceText: goodFile({ E2: entry('2026-01-01') }) }],
      ['bad days', { days: 30 }],
      ['not json', { evidenceText: 'nope' }],
    ];
    for (const [label, over, storeOver] of cases) {
      const { store, writes } = makeStore(storeOver);
      expect(() => run(store, over), label).toThrow();
      expect(writes, label).toEqual([]);
    }
  });

  it('shows when it is already enabled', () => {
    const record = { recordId: 'x', approvedBy: 'owner-cli', approvedAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-10-27T10:00:00.000Z', paidAllowed: false, evidence: Object.fromEntries(EVIDENCE_STEPS.map((step) => [step, true])) };
    const out = run(makeStore({ record }).store, { action: 'status', confirm: undefined });
    expect(out.currentlyEnabledUntil).toBe('2026-10-27T10:00:00.000Z');
  });
});

describe('robinhood-enable command wiring', () => {
  it('reads a plain file only, never from a link, and starts no coordinator', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf(".command('robinhood-enable <action>'");
    const text = source.slice(start, source.indexOf(".command('chain-evidence <action>'", start));
    expect(start).toBeGreaterThan(0);
    expect(text).toContain('info.isSymbolicLink()');
    expect(text).toContain('{ startCoordinator: false }');
    expect(text).toContain('runRobinhoodEnable({');
    expect(text).not.toContain('enableRobinhood(');
  });
});
