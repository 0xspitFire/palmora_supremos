-- D-092: funding commitments and mint exposure holds; neither table enables funding.
CREATE TABLE IF NOT EXISTS native_funding (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id IN (1,8453,4663)), hub TEXT NOT NULL, recipient TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK(nonce >= 0), parent_hold_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','signing','signed','unknown','submitted','settled','released')),
  principal_wei TEXT NOT NULL, fee_budget_wei TEXT NOT NULL, payload_json TEXT NOT NULL,
  transaction_hash TEXT, actual_principal_wei TEXT, actual_fee_wei TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT, receipt_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS native_funding_live_nonce ON native_funding(chain_id,hub,nonce) WHERE state <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS native_funding_parent_recipient ON native_funding(parent_hold_id,chain_id,recipient) WHERE state <> 'released';
CREATE TABLE IF NOT EXISTS native_funding_clock (id INTEGER PRIMARY KEY CHECK(id=1), admitted_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS native_funding_identity_immutable BEFORE UPDATE OF id,idempotency_key,request_digest,chain_id,hub,recipient,nonce,parent_hold_id,principal_wei,fee_budget_wei,payload_json,created_at ON native_funding
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_no_delete BEFORE DELETE ON native_funding
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_hash_immutable BEFORE UPDATE OF transaction_hash ON native_funding
WHEN OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS NOT OLD.transaction_hash
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_HASH_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS native_funding_state_guard BEFORE UPDATE OF state ON native_funding
WHEN NOT (OLD.state=NEW.state OR OLD.state='reserved' AND NEW.state IN ('signing','released') OR OLD.state='signing' AND NEW.state IN ('signed','unknown') OR OLD.state='signed' AND NEW.state IN ('unknown','settled') OR OLD.state='unknown' AND NEW.state IN ('submitted','settled') OR OLD.state='submitted' AND NEW.state IN ('unknown','settled') OR OLD.state='settled' AND NEW.state='unknown')
BEGIN SELECT RAISE(ABORT,'NATIVE_FUNDING_STATE_INVALID'); END;

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
