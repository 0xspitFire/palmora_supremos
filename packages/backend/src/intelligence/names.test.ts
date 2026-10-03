import { describe, expect, it } from 'vitest';
import { CollectionNames } from './names.js';
import type { CollectionNameRead } from './port.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const C = `0x${'c'.repeat(40)}`;

type Step = CollectionNameRead | Error | 'hang';
/** A port whose answers come from a script; the last step repeats. */
function scripted(steps: Step[]) {
  const calls: string[] = [];
  let index = 0;
  const port = {
    readName: async (contract: string): Promise<CollectionNameRead> => {
      calls.push(contract);
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      if (step instanceof Error) throw step;
      if (step === 'hang') return new Promise<never>(() => undefined);
      return step;
    },
  };
  return { calls, port };
}

describe('CollectionNames (T-029)', () => {
  it('reads the name once per contract, ignoring address case, and returns it cleaned', async () => {
    const { calls, port } = scripted([{ status: 'name', name: '  Pudgy   Example ' }]);
    const names = new CollectionNames(port);
    expect(await names.get(A)).toBe('Pudgy Example');
    expect(await names.get(A.toUpperCase().replace('0X', '0x'))).toBe('Pudgy Example');
    expect(calls).toHaveLength(1);
  });

  it('treats "no name" as a final answer and does not ask again', async () => {
    const { calls, port } = scripted([{ status: 'none' }]);
    const names = new CollectionNames(port);
    expect(await names.get(A)).toBeNull();
    expect(await names.get(A)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('retries a network error once at once and uses the name if the second read works', async () => {
    const { calls, port } = scripted([{ status: 'error' }, { status: 'name', name: 'Second Try' }]);
    expect(await new CollectionNames(port).get(A)).toBe('Second Try');
    expect(calls).toHaveLength(2);
  });

  it('does not remember a failure as an answer: it returns null now and asks again on a later alert, up to a limit', async () => {
    const { calls, port } = scripted([{ status: 'error' }]);
    const names = new CollectionNames(port, { maxFailedReads: 3 });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await names.get(A)).toBeNull();
    // Three gets of two reads each, then it stops asking so a dead contract cannot cost a read on every alert.
    expect(calls).toHaveLength(6);
  });

  it('forgets earlier failures once a read succeeds', async () => {
    const { port } = scripted([{ status: 'error' }, { status: 'error' }, { status: 'name', name: 'Back' }]);
    const names = new CollectionNames(port, { maxFailedReads: 3 });
    expect(await names.get(A)).toBeNull();
    expect(await names.get(A)).toBe('Back');
    expect(await names.get(A)).toBe('Back');
  });

  it('treats a thrown exception like a network error', async () => {
    const { calls, port } = scripted([new Error('socket hang up'), { status: 'name', name: 'Recovered' }]);
    expect(await new CollectionNames(port).get(A)).toBe('Recovered');
    expect(calls).toHaveLength(2);
  });

  it('gives up on a read that hangs, without asking again at once, instead of stalling discovery', async () => {
    const { calls, port } = scripted(['hang']);
    const started = Date.now();
    expect(await new CollectionNames(port, { readTimeoutMs: 15 }).get(A)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('counts a timeout as a failed read: asked again on a later alert, then given up on', async () => {
    const { calls, port } = scripted(['hang']);
    const names = new CollectionNames(port, { readTimeoutMs: 10, maxFailedReads: 2 });
    for (let attempt = 0; attempt < 4; attempt += 1) expect(await names.get(A)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('keeps the failure counts bounded too', async () => {
    const { calls, port } = scripted([{ status: 'error' }]);
    const names = new CollectionNames(port, { maxEntries: 2, maxFailedReads: 1 });
    await names.get(A); await names.get(B); await names.get(C);
    expect(calls).toHaveLength(6);
    await names.get(A);
    expect(calls).toHaveLength(8);
  });

  it('shares one read between callers that ask at the same time', async () => {
    const { calls, port } = scripted([{ status: 'name', name: 'Shared' }]);
    const names = new CollectionNames(port);
    expect(await Promise.all([names.get(A), names.get(A), names.get(A)])).toEqual(['Shared', 'Shared', 'Shared']);
    expect(calls).toHaveLength(1);
  });

  it('answers null without error when the port cannot read names', async () => {
    expect(await new CollectionNames({}).get(A)).toBeNull();
  });

  it('only ever returns display text: a hostile name arrives cleaned, and a name with nothing left is "none"', async () => {
    const hostile = scripted([{ status: 'name', name: '@everyone https://evil.example/claim' }]);
    const cleaned = await new CollectionNames(hostile.port).get(A);
    expect(cleaned).not.toContain('://');
    expect(cleaned?.startsWith('@')).toBe(false);
    const blank = scripted([{ status: 'name', name: '   ' }]);
    expect(await new CollectionNames(blank.port).get(A)).toBeNull();
  });

  it('keeps a bounded cache, dropping the oldest contract first', async () => {
    const { calls, port } = scripted([{ status: 'name', name: 'N' }]);
    const names = new CollectionNames(port, { maxEntries: 2 });
    await names.get(A);
    await names.get(B);
    await names.get(C);
    expect(calls).toHaveLength(3);
    await names.get(C);
    expect(calls).toHaveLength(3);
    await names.get(A);
    expect(calls).toHaveLength(4);
  });
});
