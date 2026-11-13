import type { SqliteDatabase } from './database.js';

/** Dedicated FundingPending parents: no execution_run/Armed identity exists until funded arm passes. */
export const MINT_FUNDING_HOLD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mint_funding_hold (
  id TEXT PRIMARY KEY, hold_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaign(id), chain_id INTEGER NOT NULL CHECK(chain_id IN(1,8453,4663)),
  wallet_id TEXT NOT NULL REFERENCES wallet(id), wallet_address TEXT NOT NULL,
  amount_wei TEXT NOT NULL CHECK(length(amount_wei)>0 AND amount_wei NOT GLOB '*[^0-9]*' AND amount_wei<>'0'),
  mint_class TEXT NOT NULL CHECK(mint_class IN('free','paid')),
  campaign_digest TEXT NOT NULL, hold_digest TEXT NOT NULL, payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('reserved','converted','released')),
  bound_run_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  UNIQUE(hold_id,wallet_id), UNIQUE(idempotency_key,wallet_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS mint_funding_hold_pending_wallet ON mint_funding_hold(campaign_id,wallet_id) WHERE state='reserved';
CREATE TRIGGER IF NOT EXISTS mint_funding_hold_identity_immutable BEFORE UPDATE OF id,hold_id,idempotency_key,campaign_id,chain_id,wallet_id,wallet_address,amount_wei,mint_class,campaign_digest,hold_digest,payload_json,created_at,expires_at ON mint_funding_hold
BEGIN SELECT RAISE(ABORT,'FUNDING_HOLD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mint_funding_hold_no_delete BEFORE DELETE ON mint_funding_hold
BEGIN SELECT RAISE(ABORT,'FUNDING_HOLD_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mint_funding_hold_state_guard BEFORE UPDATE OF state ON mint_funding_hold
WHEN NOT(OLD.state=NEW.state OR OLD.state='reserved' AND NEW.state IN('converted','released'))
BEGIN SELECT RAISE(ABORT,'FUNDING_HOLD_STATE_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS mint_funding_hold_binding_guard BEFORE UPDATE OF bound_run_id ON mint_funding_hold
WHEN OLD.bound_run_id IS NOT NULL AND NEW.bound_run_id IS NOT OLD.bound_run_id
BEGIN SELECT RAISE(ABORT,'FUNDING_HOLD_RUN_IMMUTABLE'); END;
`;
export function initializeMintFundingHolds(db: SqliteDatabase): void {
  if (db.inTransaction) throw new Error('FUNDING_HOLD_TRANSACTION_ACTIVE');
  db.transaction(() => db.exec(MINT_FUNDING_HOLD_SCHEMA_SQL)).immediate();
}
