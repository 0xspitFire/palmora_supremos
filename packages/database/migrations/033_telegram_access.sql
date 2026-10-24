-- T-061 (D-063): owner commands over Telegram.
--
-- The owner is named only in the host secret store (TG_OWNER_USER_ID), never here, so nothing in this database can make someone
-- the owner. These tables hold the people the owner admitted (viewers), the one-time invites that admitted them, the owner's
-- unlocked sessions, the authenticator time steps already used, failed unlock attempts and where polling resumes. Rows are
-- complete when written; only the fields that record a later fact (an invite used, a user removed, a session closed) can be set,
-- once, and nothing can be deleted.

CREATE TABLE telegram_invite (
  id TEXT PRIMARY KEY,
  code_sha256 TEXT NOT NULL UNIQUE CHECK (length(code_sha256) = 64 AND code_sha256 NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL CHECK (role = 'viewer'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT
);

CREATE TRIGGER telegram_invite_complete BEFORE INSERT ON telegram_invite
WHEN julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.created_at)
  OR (julianday(NEW.expires_at) - julianday(NEW.created_at)) * 24 > 24.001
  OR NEW.used_by IS NOT NULL OR NEW.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'telegram invite is incomplete'); END;

-- An invite is used once, by one user, before it expires; nothing else about it changes.
CREATE TRIGGER telegram_invite_use_once BEFORE UPDATE ON telegram_invite
WHEN OLD.used_by IS NOT NULL OR NEW.used_by IS NULL OR NEW.used_at IS NULL
  OR julianday(NEW.used_at) IS NULL OR julianday(NEW.used_at) >= julianday(OLD.expires_at)
  OR NEW.id IS NOT OLD.id OR NEW.code_sha256 IS NOT OLD.code_sha256 OR NEW.role IS NOT OLD.role
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'telegram invites are used once'); END;
CREATE TRIGGER telegram_invite_immutable_delete BEFORE DELETE ON telegram_invite
BEGIN SELECT RAISE(ABORT, 'telegram invites cannot be deleted'); END;

CREATE TABLE telegram_user (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 20 AND user_id NOT GLOB '*[^0-9]*'),
  role TEXT NOT NULL CHECK (role = 'viewer'),
  invite_id TEXT NOT NULL UNIQUE REFERENCES telegram_invite(id),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  last_used_at TEXT
);

-- One active admission per Telegram user; a removed user can be invited again (a new row).
CREATE UNIQUE INDEX telegram_user_active ON telegram_user(user_id) WHERE removed_at IS NULL;

CREATE TRIGGER telegram_user_complete BEFORE INSERT ON telegram_user
WHEN julianday(NEW.added_at) IS NULL OR NEW.removed_at IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM telegram_invite i WHERE i.id = NEW.invite_id AND i.used_by = NEW.user_id AND i.role = NEW.role)
BEGIN SELECT RAISE(ABORT, 'telegram user needs the invite it used'); END;

-- Only the last-use time changes freely; removal happens once; who and what role never change.
CREATE TRIGGER telegram_user_update BEFORE UPDATE ON telegram_user
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.role IS NOT OLD.role OR NEW.invite_id IS NOT OLD.invite_id OR NEW.added_at IS NOT OLD.added_at
  OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
  OR (NEW.removed_at IS NOT NULL AND julianday(NEW.removed_at) IS NULL)
BEGIN SELECT RAISE(ABORT, 'telegram users can only be marked used or removed'); END;
CREATE TRIGGER telegram_user_immutable_delete BEFORE DELETE ON telegram_user
BEGIN SELECT RAISE(ABORT, 'telegram users cannot be deleted'); END;

CREATE TABLE telegram_session (
  id TEXT PRIMARY KEY,
  opened_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('lock', 'kill', 'restart', 'expired'))
);

-- At most one open session.
CREATE UNIQUE INDEX telegram_session_one_open ON telegram_session((1)) WHERE closed_at IS NULL;

CREATE TRIGGER telegram_session_complete BEFORE INSERT ON telegram_session
WHEN julianday(NEW.opened_at) IS NULL OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday(NEW.opened_at)
  OR (julianday(NEW.expires_at) - julianday(NEW.opened_at)) * 24 > 12.001
  OR NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'telegram session is incomplete'); END;

CREATE TRIGGER telegram_session_close_once BEFORE UPDATE ON telegram_session
WHEN OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.close_reason IS NULL OR julianday(NEW.closed_at) IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.opened_at IS NOT OLD.opened_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'telegram sessions are closed once'); END;
CREATE TRIGGER telegram_session_immutable_delete BEFORE DELETE ON telegram_session
BEGIN SELECT RAISE(ABORT, 'telegram sessions cannot be deleted'); END;

-- Each authenticator time step opens at most one session (a code cannot be replayed).
CREATE TABLE telegram_totp_use (
  time_step INTEGER PRIMARY KEY CHECK (time_step > 0),
  used_at TEXT NOT NULL
);
CREATE TRIGGER telegram_totp_use_immutable_update BEFORE UPDATE ON telegram_totp_use
BEGIN SELECT RAISE(ABORT, 'telegram code uses are immutable'); END;
CREATE TRIGGER telegram_totp_use_immutable_delete BEFORE DELETE ON telegram_totp_use
BEGIN SELECT RAISE(ABORT, 'telegram code uses are immutable'); END;

CREATE TABLE telegram_unlock_failure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  failed_at TEXT NOT NULL CHECK (julianday(failed_at) IS NOT NULL)
);
CREATE TRIGGER telegram_unlock_failure_immutable_update BEFORE UPDATE ON telegram_unlock_failure
BEGIN SELECT RAISE(ABORT, 'telegram unlock failures are immutable'); END;
CREATE TRIGGER telegram_unlock_failure_immutable_delete BEFORE DELETE ON telegram_unlock_failure
BEGIN SELECT RAISE(ABORT, 'telegram unlock failures are immutable'); END;

-- Where polling resumes. It only moves forward.
CREATE TABLE telegram_poll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_offset INTEGER NOT NULL CHECK (next_offset >= 0),
  updated_at TEXT NOT NULL
);
CREATE TRIGGER telegram_poll_state_forward BEFORE UPDATE ON telegram_poll_state
WHEN NEW.next_offset < OLD.next_offset OR NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'telegram polling only moves forward'); END;

-- D-063 item 3: the owner can cancel a live request the service has not started. The outcome table is rebuilt to allow it
-- (SQLite cannot widen a CHECK in place); every existing row and both immutability triggers are kept.
CREATE TABLE live_run_request_outcome_next (
  request_id TEXT PRIMARY KEY REFERENCES live_run_request(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'expired', 'cancelled')),
  claimed_at TEXT NOT NULL
);
INSERT INTO live_run_request_outcome_next (request_id, outcome, claimed_at) SELECT request_id, outcome, claimed_at FROM live_run_request_outcome;
DROP TABLE live_run_request_outcome;
ALTER TABLE live_run_request_outcome_next RENAME TO live_run_request_outcome;

CREATE TRIGGER live_run_request_outcome_once BEFORE INSERT ON live_run_request_outcome
WHEN EXISTS (SELECT 1 FROM live_run_request_outcome o WHERE o.request_id = NEW.request_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER live_run_request_outcome_immutable_update BEFORE UPDATE ON live_run_request_outcome
BEGIN SELECT RAISE(ABORT, 'live run request outcomes are immutable'); END;
CREATE TRIGGER live_run_request_outcome_immutable_delete BEFORE DELETE ON live_run_request_outcome
BEGIN SELECT RAISE(ABORT, 'live run request outcomes are immutable'); END;
