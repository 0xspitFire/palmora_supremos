import type { SqliteDatabase } from './database.js';

const STATE_ID = 'global';

function encode(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item);
  if (encoded !== undefined && /"(?:private[_-]?key|mnemonic|seed(?:[_-]?phrase)?|passphrase|password|api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token)"\s*:/i.test(encoded)) throw new Error('secret-like values must remain in the approved secret store');
  return encoded;
}

function decode<T>(value: string): T {
  return JSON.parse(value, (_key, item) => typeof item === 'string' && /^\d+n$/.test(item) ? BigInt(item.slice(0, -1)) : item) as T;
}

/**
 * SQLite transaction boundary for the backend's durable state machine.
 * The callback runs while BEGIN IMMEDIATE holds the writer lock, so cap and
 * admission decisions are serialized across independent processes.
 */
export class BackendStateRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backend_state (
        id TEXT PRIMARY KEY CHECK (id = '${STATE_ID}'),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  public read<T>(): T | undefined {
    const row = this.db.prepare('SELECT state_json FROM backend_state WHERE id = ?').get(STATE_ID) as { state_json: string } | undefined;
    return row ? decode<T>(row.state_json) : undefined;
  }

  public write<T>(state: T): void {
    const encoded = encode(state);
    this.db.prepare(`
      INSERT INTO backend_state (id, state_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(STATE_ID, encoded, new Date().toISOString());
  }

  public transaction<TState, TResult>(initial: TState, mutate: (state: TState) => TResult): TResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read<TState>() ?? initial;
      const next = structuredClone(current);
      const result = mutate(next);
      this.write(next);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
