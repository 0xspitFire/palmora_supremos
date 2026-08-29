# Operations Runbook

This runbook describes the single-host Phase 1/2 deployment. It does not make a
Telegram notification or a process health result equivalent to transaction
execution.

## Configuration

Provide `SECRET_STORE_PATH`, `RPC_SECRET_NAMES`, `STORE_PATH`, and
`KILL_SWITCH_PATH` through the host secret mechanism or service manager. The
secret store path must point to `Rets/MINT_BOT_SECRETS.env` or
`Rets/TEST_BOT.env`. Archive-backed fork tests use the `ANVIL_FORK_RPC` key by
reference only. The approved keystore directory is `./Rets/wallets`; its
Product Owner passphrase must be requested through a hidden interactive prompt
by the host launcher when needed. Do not expose it as an environment variable,
argument, log field, backup artifact, or CI secret.
Never put keys, mnemonics, provider credentials,
or passphrases in environment files committed to the repository, command-line
arguments, logs, or backups.

Builds use Node `20.19.1` and pnpm `9.15.4`; deploy the immutable image built
from the checked-in lockfile. Keep the signer boundary outside the application
process when a KMS/HSM implementation is selected.

## Health and safe start

Run `pnpm ops:health` before enabling live admission. A failed RPC or store
check is unsafe. An unknown check means the host configuration is incomplete.
The process must start with the kill switch engaged and dry-run mode selected;
only an explicit operator action may permit live spend.

## Incident response

1. Engage the kill switch first. It blocks new admission, not transactions
   already submitted to a chain.
2. Stop live execution and preserve structured logs and the SQLite database.
3. On restart, run migration and reconcile every in-flight intent by wallet,
   nonce, and transaction hash before accepting new work.
4. For RPC or sequencer outages, keep admission blocked and retain endpoint
   attempts. Do not blindly rebroadcast without replacement and duplicate-send
   reconciliation.
5. For suspected credential compromise, revoke and rotate RPC, Telegram, and
   signer credentials before restoring service.

## Backups and restore drill

Back up the SQLite database in a consistent snapshot, its checksum, and the
encrypted keystore separately. Restore into an isolated host, verify checksum
and schema, confirm the kill switch is engaged, and reconcile chain state before
making the host reachable. Practice this procedure for disk loss, process kill,
RPC outage, Telegram outage, partial fleet failure, and reorgs.

Robinhood characterization uses `SEQUENCER_URL` and `FEED_URL`, defaulting to
the documented mainnet endpoints. Set `CHECK_ROBINHOOD=true` only for probes;
this never enables execution. FREE mint value exposure is capped at
`2 * configured priority fee component`; L2 execution gas and L1 data gas are
reserved separately as independent worst-case exposures. The
FREE mint value exposure must be `<= 2 * configured priority fee component`;
the L2 gas reserve and L1 data-gas reserve are not summed into that value cap.
The priority-fee component may be zero, provided the FREE mint value exposure
is also zero and both independent gas reserves cover their estimates. Paid
Robinhood mints remain blocked pending an explicit value/exposure policy.
The approved FREE reserve caps are `0.0002 ETH` per wallet and `0.002 ETH` per
active mint period. These caps include the independent L2 and L1 gas reserves
but exclude paid-mint value. Encrypted backups retain for exactly 30 days under
`BACKUP_RETENTION_DAYS`.

Official Robinhood endpoints are chain ID `4663` (`0x1237`), sequencer
`https://sequencer.mainnet.chain.robinhood.com`, and feed
`wss://feed.mainnet.chain.robinhood.com`. CI may use the archive endpoint only
through the `ANVIL_FORK_RPC` secret reference; the value is injected by the
secret manager and never written to logs, artifacts, or workflow files.

The CI fork gate must be followed by replay coverage for failed, reverted,
replacement, reorg, restart, kill-switch, and reconciliation scenarios. A
vanilla Anvil run is only a fallback smoke test and is not evidence of archive
fork compatibility.
Product success requires Ethereum finality; Robinhood soft and posted states
must remain retained as intermediate reconciliation states.

## Logs and retention

Use structured JSON logs with run, campaign, wallet, execution, and transaction
identifiers. Redact calldata, private material, provider tokens, and Telegram
payloads. Rotate watcher logs with a disk bound while retaining durable audit
facts and release metadata (chain profile, strategy, policy schema, and
dependency versions).
