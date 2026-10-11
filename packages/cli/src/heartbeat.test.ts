import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHeartbeat, writeHeartbeat } from './heartbeat.js';

describe('heartbeat file', () => {
  it('saves and reads one timestamp, and treats a missing or damaged file as no heartbeat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-heartbeat-'));
    try {
      const path = join(directory, 'heartbeat');
      expect(await readHeartbeat(path)).toBeUndefined();
      await writeHeartbeat(path, new Date('2026-10-11T10:00:00.000Z'));
      expect((await readHeartbeat(path))?.toISOString()).toBe('2026-10-11T10:00:00.000Z');
      expect(await readFile(path, 'utf8')).toBe('2026-10-11T10:00:00.000Z\n');
      await writeFile(path, 'garbage');
      expect(await readHeartbeat(path)).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('heartbeat file under overlapping writes', () => {
  it('lets many writes at once all succeed and leaves a valid timestamp and no stray temp files', async () => {
    const { readdir } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'mint-heartbeat-'));
    try {
      const path = join(directory, 'heartbeat');
      await Promise.all(Array.from({ length: 25 }, (_, index) => writeHeartbeat(path, new Date(Date.UTC(2026, 9, 11, 12, 0, index)))));
      expect(await readHeartbeat(path)).toBeInstanceOf(Date);
      expect(await readdir(directory)).toEqual(['heartbeat']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
