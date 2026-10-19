import type { SqliteDatabase } from './database.js';

export const ROLLING_SPEND_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const ADMISSION_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function rollingSpendCutoff(at: Date): string {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new Error('ADMISSION_TIME_INVALID');
  return new Date(time - ROLLING_SPEND_WINDOW_MS).toISOString();
}

export function assertNoStalePendingReservations(db: SqliteDatabase, at: Date): void {
  const cutoff = rollingSpendCutoff(at);
  const stale = db.prepare("SELECT id FROM spend_reservation WHERE status = 'reserved' AND (julianday(created_at) IS NULL OR julianday(created_at) <= julianday(?)) LIMIT 1").get(cutoff) as { id: string } | undefined;
  if (stale) throw new Error('STALE_PENDING_RESERVATION_REQUIRES_RECONCILIATION');
}

/** Must run inside the same write transaction as admission. The watermark never moves backwards. */
export function assertAndAdvanceAdmissionClock(db: SqliteDatabase, at: Date): void {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new Error('ADMISSION_TIME_INVALID');
  const row = db.prepare("SELECT last_admission_at FROM admission_clock_watermark WHERE id = 'global'").get() as { last_admission_at: string } | undefined;
  const previous = row ? Date.parse(row.last_admission_at) : undefined;
  if (row && !Number.isFinite(previous)) throw new Error('ADMISSION_CLOCK_WATERMARK_INVALID');
  if (previous !== undefined && time + ADMISSION_CLOCK_SKEW_TOLERANCE_MS < previous) throw new Error('ADMISSION_CLOCK_ROLLBACK');
  const next = new Date(Math.max(time, previous ?? time)).toISOString();
  db.prepare("INSERT INTO admission_clock_watermark (id, last_admission_at) VALUES ('global', ?) ON CONFLICT(id) DO UPDATE SET last_admission_at = excluded.last_admission_at").run(next);
}
