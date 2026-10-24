import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

export type TelegramRole = 'viewer';
export interface TelegramUserRow { id: string; userId: string; role: TelegramRole; addedAt: string; lastUsedAt: string | null }
export interface TelegramSessionRow { id: string; openedAt: string; expiresAt: string }
export type TelegramSessionCloseReason = 'lock' | 'kill' | 'restart' | 'expired';

const USER_ID = /^\d{1,20}$/;
const codeDigest = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * T-061 (D-063): who may use the Telegram commands besides the owner, the owner's unlocked session, and where polling resumes
 * (migration 033). The owner is never stored here; the database triggers keep every row complete and append-only.
 */
export class TelegramAccessRepository {
  public constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  /** A one-time invite. Only the code's SHA-256 is stored; the caller shows the code to the owner once. */
  public createInvite(code: string, role: TelegramRole, lifetimeMs: number): { id: string; expiresAt: string } {
    const created = this.now();
    const id = `tg_invite_${randomUUID()}`;
    const expiresAt = new Date(created.getTime() + lifetimeMs).toISOString();
    this.db.prepare('INSERT INTO telegram_invite (id, code_sha256, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, codeDigest(code), role, created.toISOString(), expiresAt);
    return { id, expiresAt };
  }

  /** Uses an unexpired, unused invite for this Telegram user and admits them, in one transaction. Undefined when the code is not valid. */
  public join(code: string, userId: string): TelegramUserRow | undefined {
    if (!USER_ID.test(userId)) throw new Error('TELEGRAM_USER_ID_INVALID');
    const at = this.now().toISOString();
    return this.db.transaction((): TelegramUserRow | undefined => {
      if (this.activeUser(userId)) return undefined;
      const invite = this.db.prepare('SELECT id, role FROM telegram_invite WHERE code_sha256 = ? AND used_by IS NULL AND expires_at > ?').get(codeDigest(code), at) as { id: string; role: TelegramRole } | undefined;
      if (!invite) return undefined;
      this.db.prepare('UPDATE telegram_invite SET used_by = ?, used_at = ? WHERE id = ?').run(userId, at, invite.id);
      const id = `tg_user_${randomUUID()}`;
      this.db.prepare('INSERT INTO telegram_user (id, user_id, role, invite_id, added_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, invite.role, invite.id, at);
      return { id, userId, role: invite.role, addedAt: at, lastUsedAt: null };
    }).immediate();
  }

  public activeUser(userId: string): TelegramUserRow | undefined {
    const row = this.db.prepare('SELECT id, user_id, role, added_at, last_used_at FROM telegram_user WHERE user_id = ? AND removed_at IS NULL').get(userId) as { id: string; user_id: string; role: TelegramRole; added_at: string; last_used_at: string | null } | undefined;
    return row ? { id: row.id, userId: row.user_id, role: row.role, addedAt: row.added_at, lastUsedAt: row.last_used_at } : undefined;
  }

  public activeUsers(): TelegramUserRow[] {
    return (this.db.prepare('SELECT id, user_id, role, added_at, last_used_at FROM telegram_user WHERE removed_at IS NULL ORDER BY added_at').all() as Array<{ id: string; user_id: string; role: TelegramRole; added_at: string; last_used_at: string | null }>)
      .map((row) => ({ id: row.id, userId: row.user_id, role: row.role, addedAt: row.added_at, lastUsedAt: row.last_used_at }));
  }

  public touchUser(userId: string): void {
    this.db.prepare('UPDATE telegram_user SET last_used_at = ? WHERE user_id = ? AND removed_at IS NULL').run(this.now().toISOString(), userId);
  }

  /** Ends a user's access at once. False when they had none. */
  public removeUser(userId: string): boolean {
    return this.db.prepare('UPDATE telegram_user SET removed_at = ? WHERE user_id = ? AND removed_at IS NULL').run(this.now().toISOString(), userId).changes === 1;
  }

  public openSession(): TelegramSessionRow | undefined {
    const row = this.db.prepare('SELECT id, opened_at, expires_at FROM telegram_session WHERE closed_at IS NULL').get() as { id: string; opened_at: string; expires_at: string } | undefined;
    return row ? { id: row.id, openedAt: row.opened_at, expiresAt: row.expires_at } : undefined;
  }

  /**
   * Opens a session when the authenticator time step has not been used before; the step and the session are written together.
   * Undefined when the step was already used (a replayed code). Any open session is closed first.
   */
  public startSession(timeStep: number, lifetimeMs: number): TelegramSessionRow | undefined {
    const opened = this.now();
    const at = opened.toISOString();
    return this.db.transaction((): TelegramSessionRow | undefined => {
      if (this.db.prepare('SELECT 1 FROM telegram_totp_use WHERE time_step >= ?').get(timeStep)) return undefined;
      this.db.prepare('INSERT INTO telegram_totp_use (time_step, used_at) VALUES (?, ?)').run(timeStep, at);
      this.db.prepare("UPDATE telegram_session SET closed_at = ?, close_reason = 'lock' WHERE closed_at IS NULL").run(at);
      const id = `tg_session_${randomUUID()}`;
      const expiresAt = new Date(opened.getTime() + lifetimeMs).toISOString();
      this.db.prepare('INSERT INTO telegram_session (id, opened_at, expires_at) VALUES (?, ?, ?)').run(id, at, expiresAt);
      return { id, openedAt: at, expiresAt };
    }).immediate();
  }

  /** Closes the open session, if any. Returns the session it closed. */
  public closeSession(reason: TelegramSessionCloseReason): TelegramSessionRow | undefined {
    const open = this.openSession();
    if (!open) return undefined;
    const changed = this.db.prepare('UPDATE telegram_session SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL').run(this.now().toISOString(), reason, open.id).changes;
    return changed === 1 ? open : undefined;
  }

  public recordUnlockFailure(): void {
    this.db.prepare('INSERT INTO telegram_unlock_failure (failed_at) VALUES (?)').run(this.now().toISOString());
  }

  /** Failed unlocks since `since`, oldest first. */
  public unlockFailuresSince(since: Date): string[] {
    return (this.db.prepare('SELECT failed_at FROM telegram_unlock_failure WHERE failed_at > ? ORDER BY id').all(since.toISOString()) as Array<{ failed_at: string }>).map((row) => row.failed_at);
  }

  public pollOffset(): number {
    const row = this.db.prepare('SELECT next_offset FROM telegram_poll_state WHERE id = 1').get() as { next_offset: number } | undefined;
    return row?.next_offset ?? 0;
  }

  public savePollOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('TELEGRAM_POLL_OFFSET_INVALID');
    this.db.prepare('INSERT INTO telegram_poll_state (id, next_offset, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET next_offset = excluded.next_offset, updated_at = excluded.updated_at WHERE excluded.next_offset >= telegram_poll_state.next_offset').run(offset, this.now().toISOString());
  }
}
