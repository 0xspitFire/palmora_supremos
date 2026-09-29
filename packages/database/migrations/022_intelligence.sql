-- Phase 2 intelligence (T-004, D-026, D-031).
-- observed_address: external addresses the owner watches. Deliberately not a
-- custody wallet: no key reference, never selectable for execution.
-- discovery_cursor: last fully processed block per chain and source, so
-- discovery resumes after restart without gaps or double counting.

CREATE TABLE observed_address (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  address TEXT NOT NULL COLLATE NOCASE CHECK (length(address) = 42 AND substr(address, 1, 2) = '0x' AND substr(address, 3) NOT GLOB '*[^0-9a-fA-F]*'),
  label TEXT CHECK (label IS NULL OR length(label) <= 64),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chain_id, address)
);

-- A watched address can never be a custody wallet on the same chain.
CREATE TRIGGER observed_address_not_custody_insert
BEFORE INSERT ON observed_address
WHEN EXISTS (SELECT 1 FROM wallet w JOIN chain_profile c ON c.id = w.chain_profile_id WHERE c.chain_id = NEW.chain_id AND lower(w.address) = lower(NEW.address))
BEGIN
  SELECT RAISE(ABORT, 'observed address is a custody wallet');
END;

-- The reverse direction: a custody wallet cannot be added while the same address is watched.
CREATE TRIGGER wallet_not_observed_insert
BEFORE INSERT ON wallet
WHEN EXISTS (SELECT 1 FROM observed_address o JOIN chain_profile c ON c.chain_id = o.chain_id WHERE c.id = NEW.chain_profile_id AND lower(o.address) = lower(NEW.address))
BEGIN
  SELECT RAISE(ABORT, 'custody wallet is a watched address');
END;

CREATE TRIGGER observed_address_identity_immutable
BEFORE UPDATE OF chain_id, address ON observed_address
BEGIN
  SELECT RAISE(ABORT, 'observed address identity is immutable');
END;

CREATE TABLE discovery_cursor (
  chain_id INTEGER NOT NULL CHECK (chain_id > 0),
  source TEXT NOT NULL CHECK (length(source) > 0 AND length(source) <= 64),
  last_block TEXT NOT NULL CHECK (length(last_block) > 0 AND last_block NOT GLOB '*[^0-9]*'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, source)
);

CREATE TRIGGER discovery_cursor_forward_only
BEFORE UPDATE OF last_block ON discovery_cursor
WHEN length(NEW.last_block) < length(OLD.last_block) OR (length(NEW.last_block) = length(OLD.last_block) AND NEW.last_block < OLD.last_block)
BEGIN
  SELECT RAISE(ABORT, 'discovery cursor cannot move backwards');
END;
