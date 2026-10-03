import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFacts, codeVersion, diskFacts } from './host-facts.js';
import { ScanTracker, scanProblemCode } from './scan-tracker.js';

const T0 = new Date('2026-10-03T08:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe('scan tracker (T-030)', () => {
  it('remembers the last good scan and its block, and clears the problem when one works', () => {
    const tracker = new ScanTracker(T0);
    tracker.record({ status: 'unavailable', reason: 'HEAD_UNAVAILABLE' }, at(1));
    expect(tracker.lastProblem).toBe('HEAD_UNAVAILABLE');
    expect(tracker.lastOkAt).toBeUndefined();
    tracker.record({ status: 'ok' }, at(2), '123');
    expect(tracker).toMatchObject({ lastOkBlock: '123', lastProblem: undefined });
    expect(tracker.lastOkAt).toEqual(at(2));
    tracker.record({ status: 'idle' }, at(3));
    expect(tracker.lastOkAt).toEqual(at(3));
    expect(tracker.lastOkBlock).toBe('123');
  });

  it('stores only a class of failure, never the provider text', () => {
    expect(scanProblemCode('RATE_LIMITED: https://user:pw@node.example/KEY')).toBe('RATE_LIMITED');
    expect(scanProblemCode('LOGS_UNAVAILABLE')).toBe('LOGS_UNAVAILABLE');
    expect(scanProblemCode('HTTP 500 https://node.example/KEY')).toBe('SCAN_FAILED');
    expect(scanProblemCode(undefined)).toBe('SCAN_FAILED');
    const tracker = new ScanTracker(T0);
    tracker.record({ status: 'unavailable', reason: 'boom https://node.example/KEY' }, at(1));
    expect(JSON.stringify(tracker)).not.toContain('node.example');
    tracker.recordFailure(at(2));
    expect(tracker.lastProblem).toBe('SCAN_FAILED');
  });

  it('counts the attempts and failures of the last hour only, and stays bounded', () => {
    const tracker = new ScanTracker(T0);
    tracker.record({ status: 'unavailable' }, at(0));
    tracker.record({ status: 'ok' }, at(30));
    tracker.recordFailure(at(40));
    expect(tracker.lastHour(at(50))).toEqual({ total: 3, failed: 2 });
    expect(tracker.lastHour(at(75))).toEqual({ total: 2, failed: 1 });
    for (let index = 0; index < 2_000; index += 1) tracker.record({ status: 'ok' }, new Date(at(80).getTime() + index));
    expect(tracker.lastHour(at(81)).total).toBeLessThanOrEqual(500);
  });
});

describe('host facts (T-030)', () => {
  it('reads the backup status file, and returns nothing for a missing, malformed or unknown one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mintbot-host-'));
    try {
      const good = join(dir, 'status.json');
      await writeFile(good, JSON.stringify({ status: 'failed', recordedAt: '2026-10-03T07:00:00.000Z' }));
      expect(await backupFacts(good)).toEqual({ status: 'failed', recordedAt: new Date('2026-10-03T07:00:00.000Z') });
      expect(await backupFacts(join(dir, 'missing.json'))).toBeUndefined();
      for (const [name, body] of [['bad.json', '{not json'], ['odd.json', JSON.stringify({ status: 'fine', recordedAt: '2026-10-03T07:00:00.000Z' })], ['date.json', JSON.stringify({ status: 'ok', recordedAt: 'yesterday' })]] as const) {
        await writeFile(join(dir, name), body);
        expect(await backupFacts(join(dir, name)), name).toBeUndefined();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads free disk space as numbers, and nothing for a directory that does not exist', async () => {
    const facts = await diskFacts(tmpdir());
    expect(facts?.totalBytes).toBeGreaterThan(0);
    expect(facts!.freeBytes).toBeLessThanOrEqual(facts!.totalBytes);
    expect(await diskFacts(join(tmpdir(), 'mintbot-no-such-directory'))).toBeUndefined();
  });

  it('gives a short hex commit, or "unknown" outside a repository, and never throws', async () => {
    expect(await codeVersion(process.cwd())).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
    expect(await codeVersion(join(tmpdir(), 'mintbot-no-such-directory'))).toBe('unknown');
  });
});
