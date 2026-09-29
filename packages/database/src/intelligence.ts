import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export interface ObservedAddressRow { id: string; chainId: number; address: string; label: string | null; enabled: boolean; createdAt: string; updatedAt: string; }

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Watched external addresses and discovery cursors (migration 022). Never custody data. */
export class IntelligenceRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  public addObservedAddress(chainId: number, address: string, label?: string): ObservedAddressRow {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('OBSERVED_ADDRESS_CHAIN_INVALID');
    if (!ADDRESS.test(address)) throw new Error('OBSERVED_ADDRESS_INVALID');
    if (label !== undefined && (label.length > 64 || /[\u0000-\u001f]/.test(label))) throw new Error('OBSERVED_ADDRESS_LABEL_INVALID');
    const at = this.now().toISOString();
    const existing = this.db.prepare('SELECT id FROM observed_address WHERE chain_id = ? AND address = ?').get(chainId, address) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE observed_address SET enabled = 1, label = COALESCE(?, label), updated_at = ? WHERE id = ?').run(label ?? null, at, existing.id);
      return this.observedAddress(existing.id)!;
    }
    const id = `observed_${randomUUID()}`;
    this.db.prepare('INSERT INTO observed_address (id, chain_id, address, label, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, chainId, address.toLowerCase(), label ?? null, at, at);
    return this.observedAddress(id)!;
  }

  /** Disables rather than deletes, so past evidence keeps its meaning. */
  public disableObservedAddress(chainId: number, address: string): boolean {
    const result = this.db.prepare('UPDATE observed_address SET enabled = 0, updated_at = ? WHERE chain_id = ? AND address = ? AND enabled = 1').run(this.now().toISOString(), chainId, address);
    return result.changes > 0;
  }

  public observedAddresses(chainId: number, enabledOnly = true): ObservedAddressRow[] {
    const rows = this.db.prepare(`SELECT id, chain_id, address, label, enabled, created_at, updated_at FROM observed_address WHERE chain_id = ?${enabledOnly ? ' AND enabled = 1' : ''} ORDER BY created_at, id`).all(chainId) as Array<{ id: string; chain_id: number; address: string; label: string | null; enabled: number; created_at: string; updated_at: string }>;
    return rows.map(mapObserved);
  }

  public cursor(chainId: number, source: string): bigint | undefined {
    const row = this.db.prepare('SELECT last_block FROM discovery_cursor WHERE chain_id = ? AND source = ?').get(chainId, source) as { last_block: string } | undefined;
    return row ? BigInt(row.last_block) : undefined;
  }

  /** Cursors only move forward; a lower block is refused so a replay cannot rewind state silently. */
  public advanceCursor(chainId: number, source: string, lastBlock: bigint): void {
    if (lastBlock < 0n) throw new Error('DISCOVERY_CURSOR_INVALID');
    const current = this.cursor(chainId, source);
    if (current !== undefined && lastBlock < current) throw new Error('DISCOVERY_CURSOR_REWIND');
    this.db.prepare('INSERT INTO discovery_cursor (chain_id, source, last_block, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(chain_id, source) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at').run(chainId, source, lastBlock.toString(), this.now().toISOString());
  }

  private observedAddress(id: string): ObservedAddressRow | undefined {
    const row = this.db.prepare('SELECT id, chain_id, address, label, enabled, created_at, updated_at FROM observed_address WHERE id = ?').get(id) as { id: string; chain_id: number; address: string; label: string | null; enabled: number; created_at: string; updated_at: string } | undefined;
    return row ? mapObserved(row) : undefined;
  }
}

function mapObserved(row: { id: string; chain_id: number; address: string; label: string | null; enabled: number; created_at: string; updated_at: string }): ObservedAddressRow {
  return { id: row.id, chainId: row.chain_id, address: row.address, label: row.label, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
