-- T-062 (D-064, owner-approved 2026-10-24, "Option B"): an imported proof that one live Ethereum mint worked.
--
-- D-040 item 6 asks for one confirmed live Ethereum mint before Robinhood can be switched on. The proof is read from the
-- database the service uses. A host database that has never run an Ethereum mint (the owner's Ethereum mint of 2026-10-19 is in
-- the PC database) has none. The owner command `ethereum-proof` reads each named transaction from Ethereum, checks it itself
-- (succeeded, finalized, a SeaDrop v1 `mintPublic` call) and records one row per transaction here, after a typed confirmation.
-- Rows are complete when written, can never be changed or deleted, and are only ever added by that command. Nothing here can
-- sign, send or enable anything: the Robinhood enablement still needs its own evidence file and its own typed confirmation.

CREATE TABLE ethereum_live_mint_proof (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 1),
  tx_hash TEXT NOT NULL UNIQUE CHECK (length(tx_hash) = 66 AND tx_hash GLOB '0x*' AND substr(tx_hash, 3) NOT GLOB '*[^0-9a-f]*'),
  block_number TEXT NOT NULL CHECK (length(block_number) BETWEEN 1 AND 20 AND block_number NOT GLOB '*[^0-9]*' AND block_number <> '0'),
  block_hash TEXT NOT NULL CHECK (length(block_hash) = 66 AND block_hash GLOB '0x*' AND substr(block_hash, 3) NOT GLOB '*[^0-9a-f]*'),
  seadrop_address TEXT NOT NULL CHECK (seadrop_address = '0x00005ea00ac477b1030ce78506496e8c2de24bf5'),
  sender TEXT NOT NULL CHECK (length(sender) = 42 AND sender GLOB '0x*' AND substr(sender, 3) NOT GLOB '*[^0-9a-f]*'),
  nft_contract TEXT NOT NULL CHECK (length(nft_contract) = 42 AND nft_contract GLOB '0x*' AND substr(nft_contract, 3) NOT GLOB '*[^0-9a-f]*'),
  call_selector TEXT NOT NULL CHECK (call_selector = '0x161ac21f'),
  evidence_reference TEXT NOT NULL CHECK (length(evidence_reference) BETWEEN 5 AND 300),
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner-cli'),
  approved_at TEXT NOT NULL,
  confirmation_digest TEXT NOT NULL CHECK (length(confirmation_digest) = 64 AND confirmation_digest NOT GLOB '*[^0-9a-f]*')
);

-- Also refuses a row that repeats an existing id or transaction, so an INSERT OR REPLACE can never overwrite a recorded proof.
CREATE TRIGGER ethereum_live_mint_proof_complete BEFORE INSERT ON ethereum_live_mint_proof
WHEN julianday(NEW.approved_at) IS NULL
  OR NEW.approved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  OR EXISTS (SELECT 1 FROM ethereum_live_mint_proof p WHERE p.id = NEW.id OR p.tx_hash = NEW.tx_hash)
BEGIN SELECT RAISE(ABORT, 'ethereum live mint proof is incomplete or already recorded'); END;

CREATE TRIGGER ethereum_live_mint_proof_immutable_update BEFORE UPDATE ON ethereum_live_mint_proof
BEGIN SELECT RAISE(ABORT, 'ethereum live mint proofs are immutable'); END;
CREATE TRIGGER ethereum_live_mint_proof_immutable_delete BEFORE DELETE ON ethereum_live_mint_proof
BEGIN SELECT RAISE(ABORT, 'ethereum live mint proofs are immutable'); END;
