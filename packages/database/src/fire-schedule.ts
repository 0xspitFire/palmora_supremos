import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export interface FireScheduleRecord {
  id: string;
  campaignId: string;
  campaignDigest: string;
  wallets: string[];
  maxFeeGwei: string;
  windowFrom: string;
  windowUntil: string;
  confirmationDigest: string;
  createdAt: string;
}
export type FireScheduleOutcome = 'started' | 'expired' | 'cancelled';
export type FireScheduleView = FireScheduleRecord & { outcome?: FireScheduleOutcome; claimedAt?: string };

/** T-067 (D-067): the owner's scheduled mints (migration 036). Complete when written, claimed once, never changed or deleted. */
export class FireScheduleRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  public create(input: Omit<FireScheduleRecord, 'id' | 'createdAt'>): FireScheduleRecord {
    const id = `fire_schedule_${randomUUID()}`;
    const createdAt = this.now().toISOString();
    this.db.prepare("INSERT INTO fire_schedule (id, campaign_id, campaign_digest, wallets_json, max_fee_gwei, window_from, window_until, requested_by, confirmation_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner-telegram', ?, ?)").run(id, input.campaignId, input.campaignDigest, JSON.stringify(input.wallets), input.maxFeeGwei, input.windowFrom, input.windowUntil, input.confirmationDigest, createdAt);
    return { ...input, id, createdAt };
  }

  private map(row: Record<string, string | null>): FireScheduleView {
    return { id: row['id']!, campaignId: row['campaign_id']!, campaignDigest: row['campaign_digest']!, wallets: JSON.parse(row['wallets_json']!) as string[], maxFeeGwei: row['max_fee_gwei']!, windowFrom: row['window_from']!, windowUntil: row['window_until']!, confirmationDigest: row['confirmation_digest']!, createdAt: row['created_at']!, ...(row['outcome'] ? { outcome: row['outcome'] as FireScheduleOutcome, claimedAt: row['claimed_at']! } : {}) };
  }

  /** Schedules nobody has claimed yet (whatever their window), oldest first. */
  public unclaimed(): FireScheduleRecord[] {
    return (this.db.prepare('SELECT s.* FROM fire_schedule s LEFT JOIN fire_schedule_outcome o ON o.schedule_id = s.id WHERE o.schedule_id IS NULL ORDER BY s.rowid').all() as Array<Record<string, string | null>>).map((row) => this.map(row));
  }

  /** Unclaimed schedules whose window has not ended, for one campaign (or all). */
  public open(campaignId?: string): FireScheduleRecord[] {
    const now = this.now().getTime();
    return this.unclaimed().filter((row) => Date.parse(row.windowUntil) > now && (campaignId === undefined || row.campaignId === campaignId));
  }

  /** Claims a schedule exactly once. False when it was already claimed or does not exist. */
  public claim(scheduleId: string, outcome: FireScheduleOutcome): boolean {
    if (!this.db.prepare('SELECT 1 FROM fire_schedule WHERE id = ?').get(scheduleId)) return false;
    return this.db.prepare('INSERT OR IGNORE INTO fire_schedule_outcome (schedule_id, outcome, claimed_at) VALUES (?, ?, ?)').run(scheduleId, outcome, this.now().toISOString()).changes === 1;
  }

  /** Cancels every schedule still open (a kill ends them all). Returns how many were cancelled. */
  public cancelAllOpen(): number {
    let cancelled = 0;
    for (const row of this.open()) if (this.claim(row.id, 'cancelled')) cancelled += 1;
    return cancelled;
  }

  /** Cancels one open schedule by its id or the short form (the last 6 characters). */
  public cancel(idOrShort: string): boolean {
    const matches = this.open().filter((row) => row.id === idOrShort || (idOrShort.length >= 4 && row.id.endsWith(idOrShort)));
    return matches.length === 1 && this.claim(matches[0]!.id, 'cancelled');
  }

  public recent(limit: number): FireScheduleView[] {
    return (this.db.prepare('SELECT s.*, o.outcome AS outcome, o.claimed_at AS claimed_at FROM fire_schedule s LEFT JOIN fire_schedule_outcome o ON o.schedule_id = s.id ORDER BY s.rowid DESC LIMIT ?').all(Math.max(1, Math.min(50, Math.trunc(limit)))) as Array<Record<string, string | null>>).map((row) => this.map(row));
  }
}
