import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCliRuntime } from './runtime.js';

describe('CLI integration boundary', () => {
  it('does not retain the direct engine execution bypass', async () => {
    const source = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('new MintEngine');
    expect(source).not.toContain('unavailableEngine');
  });

  it('creates a durable SQLite backend runtime', async () => {
    const statePath = `${process.cwd()}/.tmp-cli-runtime-${process.pid}.sqlite`;
    const runtime = await createCliRuntime(process.cwd(), {
      prepare: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Prepared' as const }),
      execute: async () => ({ executionIds: [], attempts: [], receipts: [], state: 'Confirmed' as const }),
      reconcile: async () => ({ result: 'unknown' as const, attempts: [], receipts: [] }),
    }, statePath);
    try {
      expect(runtime.store.capabilities()).toEqual({ durable: true, atomicAcrossProcesses: true });
    } finally {
      if ('close' in runtime.store && typeof runtime.store.close === 'function') runtime.store.close();
      await import('node:fs/promises').then(({ rm }) => rm(statePath, { force: true }));
    }
  });
});
