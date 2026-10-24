import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export type GasAlertChain = 1 | 8453 | 4663;
export type GasAlertDirection = 'below' | 'above';
export interface GasAlertRow { id: string; chainId: GasAlertChain; direction: GasAlertDirection; thresholdGwei: string; createdAt: string }

/** T-066: the owner's fee alerts (migration 035). Never custody data; an alert can only be read, added and removed. */
export class GasAlertRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  public add(chainId: number, direction: GasAlertDirection, thresholdGwei: string): GasAlertRow {
    const id = `gas_alert_${randomUUID()}`;
    const createdAt = this.now().toISOString();
    this.db.prepare('INSERT INTO gas_alert (id, chain_id, direction, threshold_gwei, created_at) VALUES (?, ?, ?, ?, ?)').run(id, chainId, direction, thresholdGwei, createdAt);
    return { id, chainId: chainId as GasAlertChain, direction, thresholdGwei, createdAt };
  }

  public active(): GasAlertRow[] {
    return (this.db.prepare('SELECT id, chain_id, direction, threshold_gwei, created_at FROM gas_alert WHERE removed_at IS NULL ORDER BY created_at, rowid').all() as Array<{ id: string; chain_id: number; direction: GasAlertDirection; threshold_gwei: string; created_at: string }>)
      .map((row) => ({ id: row.id, chainId: row.chain_id as GasAlertChain, direction: row.direction, thresholdGwei: row.threshold_gwei, createdAt: row.created_at }));
  }

  /** Removes an alert by the id shown to the owner, or by the short form (the last 6 characters of the id). False when none matches. */
  public remove(idOrShort: string): boolean {
    const matches = this.active().filter((row) => row.id === idOrShort || (idOrShort.length >= 4 && row.id.endsWith(idOrShort)));
    if (matches.length !== 1) return false;
    return this.db.prepare('UPDATE gas_alert SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(this.now().toISOString(), matches[0]!.id).changes === 1;
  }
}
