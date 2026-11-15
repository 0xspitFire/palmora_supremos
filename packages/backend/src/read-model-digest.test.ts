import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Phase2ReadModelService } from './read-model-v1.js';
import { DurableStore } from './store.js';

const now = '2026-11-14T12:00:00.000Z';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('snapshot digest memory', () => {
  it('retains the exact whole-JSON digest for bigint, omitted values, array holes and Unicode', () => {
    const state = Object.assign(new DurableStore().snapshot(), {
      omitted: undefined,
      diagnostics: [undefined, , 7n, NaN, Infinity, -0, '🐾', '\ud800', { omitted: undefined, quantity: 2n }],
      metadata: { text: 'é', flag: false, empty: null },
    });
    const encoded = JSON.stringify(state, (_, value) => typeof value === 'bigint' ? `${value}n` : value);
    const expected = `snapshot_${createHash('sha256').update(encoded).digest('hex').slice(0, 24)}`;
    const service = new Phase2ReadModelService(() => new Date(now));
    expect(service.home(state).snapshot.id).toBe(expected);
    expect(service.dashboard(state).snapshot.id).toBe(expected);
    expect(service.dashboard(state).data?.health.snapshot.id).toBe(expected);
  });

  it('projects retained payloads larger than its heap without allocating a whole-history JSON string', () => {
    const readModelUrl = pathToFileURL(join(root, 'packages/backend/dist/read-model-v1.js')).href;
    const storeUrl = pathToFileURL(join(root, 'packages/backend/dist/store.js')).href;
    const script = `
      import { Phase2ReadModelService } from ${JSON.stringify(readModelUrl)};
      import { DurableStore } from ${JSON.stringify(storeUrl)};
      const state = new DurableStore().snapshot();
      const padding = 'x'.repeat(2048);
      state.events = Array.from({ length: 80000 }, (_, n) => ({ id: 'memory-' + n, type: 'digest-memory-probe', at: ${JSON.stringify(now)}, data: { padding, index: n } }));
      const result = new Phase2ReadModelService(() => new Date(${JSON.stringify(now)})).home(state);
      console.log(JSON.stringify({ snapshotId: result.snapshot.id, events: state.events.length }));
    `;
    const result = spawnSync('bash', ['-c', 'ulimit -c 0\nexec "$@"', '_', process.execPath, '--max-old-space-size=128', '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 25_000, env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024,
    });
    expect(result.status, result.stderr.slice(-2000)).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ snapshotId: expect.stringMatching(/^snapshot_[a-f0-9]{24}$/), events: 80_000 });
  });
});
