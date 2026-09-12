import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpendLedger } from './spend-ledger.js';
import { SqliteStateStore } from './sqlite-store.js';

describe('SQLite backend state store', () => {
  it('persists state across store instances and serializes reservations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mint-backend-state-'));
    const filename = join(directory, 'state.sqlite');
    const first = await SqliteStateStore.open(filename);
    const second = await SqliteStateStore.open(filename);
    try {
      await first.transaction((state) => { state.runtime.startupState = 'Ready'; });
      expect(second.snapshot().runtime.startupState).toBe('Ready');

      const ledgerA = new SpendLedger(first);
      const ledgerB = new SpendLedger(second);
      const results = await Promise.allSettled([
        ledgerA.reserve('run-a', 'campaign', 'wallet-a', 60n, 100n, 1, 100n),
        ledgerB.reserve('run-b', 'campaign', 'wallet-b', 60n, 100n, 1, 100n),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(second.snapshot().reservations).toHaveLength(1);
    } finally {
      first.close();
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
