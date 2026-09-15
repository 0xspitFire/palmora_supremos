# Operations Runbook

This runbook describes the single-host Phase 1/2 deployment. It does not make a
Telegram notification or a process health result equivalent to transaction
execution.

## Configuration

Provide `SECRET_STORE_PATH`, `RPC_SECRET_NAMES`, `STORE_PATH`, and
`KILL_SWITCH_PATH` through the host secret mechanism or service manager. The
runtime secret store may be `Rets/MINT_BOT_SECRETS.env` or
`Rets/TEST_BOT.env` under an approved host path. The health probe reads only
the named values it needs and never prints them. Archive-backed local fork
tests must use the `ROBINHOOD_ARCHIVE_RPC` key by reference from
`~/W3/Rets/archive-rpc.env`, or the Ethereum archive key by reference from
`~/W3/Rets/eth-archive-rpc.env`. The approved keystore directory is
`./Rets/wallets`; its
Product Owner passphrase must be requested through a hidden interactive prompt
by the host launcher when needed. Do not expose it as an environment variable,
argument, log field, backup artifact, or CI secret.
Never put keys, mnemonics, provider credentials,
or passphrases in environment files committed to the repository, command-line
arguments, logs, or backups.

Builds use Node `20.19.1` and pnpm `9.15.4`; deploy the immutable image built
from the checked-in lockfile. Keep the signer boundary outside the application
process when a KMS/HSM implementation is selected.

The native execution contract is `/home/Junayd/W3/MintBot` (including managed
feature worktrees below that directory). Run `pnpm ops:environment` before any
install, build, test, fork, simulation, backup, or recovery command. It must
report native WSL, Node `20.19.1`, pnpm `9.15.4`, and Foundry/Anvil `1.8.1`.
Windows paths and `/mnt/c` are not valid execution locations.

## Health and safe start

Run `pnpm ops:environment` and then `pnpm ops:health` before enabling live
admission. Health configuration uses `SECRET_STORE_PATH`, `RPC_SECRET_NAMES`,
`STORE_PATH`, `KILL_SWITCH_PATH`, `RUNTIME_PROBE_TTL_MS`,
`SIGNER_HEALTH_URL`, and (outside Phase 1) `NOTIFICATION_HEALTH_URL`. Set
`EXPECTED_CHAIN_ID` when the default for the selected `OPS_HEALTH_MODE` is not
appropriate. A failed RPC, migration, store, signer, or kill-switch check is
unsafe. An unknown check means the host configuration is incomplete.
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
encrypted keystore separately. The backup encryption key is injected by the
approved host secret mechanism and must never appear in a command, shell
history, log, or evidence artifact. Restore into an isolated host, verify
checksum and schema, confirm the kill switch is engaged, and reconcile chain
state before making the host reachable. The reproducible local drill is
`pnpm ops:recovery-drill`; it uses temporary non-production paths and an
ephemeral key. Practice this procedure for disk loss, process kill, RPC outage,
Telegram outage, partial fleet failure, and reorgs.

For an approved host, run `pnpm ops:backup` with explicit `STORE_PATH` and
`BACKUP_DIR`, then run `pnpm ops:restore-check` with `RESTORE_SNAPSHOT`,
`KILL_SWITCH_PATH`, and the secret-manager-injected `BACKUP_ENCRYPTION_KEY`.
Retain only the encrypted snapshot and checksum sidecar for exactly 30 days;
record the redacted snapshot name, checksum, schema version, operation, and
kill-switch state.

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
through the `ROBINHOOD_ARCHIVE_RPC` reference in
`/home/Junayd/W3/Rets/archive-rpc.env`; the value is injected by the secret
manager and never written to logs, artifacts, or workflow files.

The archive replay launcher passes the archive reference only to Anvil. Vitest
receives only the loopback `ANVIL_ROBINHOOD_RPC_URL` plus the non-secret fixture
inputs; fork tests must never read `ROBINHOOD_ARCHIVE_RPC` directly. The genuine
Robinhood fixture verifies local Anvil chain `4663`, historical block state, and
public SeaDrop singleton code. `pnpm ops:fork-replay` rejects skipped or todo
tests. The Ethereum launcher reads its archive endpoint by reference from
`~/W3/Rets/eth-archive-rpc.env` and requires the non-secret fixture names
`ETHEREUM_FORK_BLOCK`, `ETHEREUM_SEADROP_NFT`,
`ETHEREUM_SEADROP_FEE_RECIPIENT`, and
`ETHEREUM_SEADROP_MINT_VALUE_WEI`. It validates those values before starting
Anvil and passes only the fixture metadata plus the local Anvil URL to Vitest.
The CI fork gate must be followed by replay coverage for failed, reverted,
replacement, reorg, restart, kill-switch, and reconciliation scenarios. A
vanilla Anvil run is only a fallback smoke test and is not evidence of archive
fork compatibility.
Product success requires Ethereum finality; Robinhood soft and posted states
must remain retained as intermediate reconciliation states.

Runtime readiness uses `SIGNER_HEALTH_URL` and, after Phase 1,
`NOTIFICATION_HEALTH_URL` service probes rather than operator readiness
booleans. Chain verification comes from the RPC chain-ID probe. The health
probe reports statuses and safe reason codes only; it never reports endpoint
values, secret-store values, private material, or passphrases.

## Service supervision

Phase 1 has no long-running Backend orchestrator entrypoint, so no service may
be enabled for live execution yet. The eventual single-host service must run
as a dedicated unprivileged account with `NoNewPrivileges`, a restrictive
`UMask`, persistent state and encrypted-keystore mounts, UTC/NTP validation,
restart-on-failure, and a startup kill switch. It must expose the health probe
without accepting readiness booleans and must stop admission until startup
reconciliation succeeds. Service evidence is a redacted unit definition,
restart/kill/reconcile drill output, and a rollback record; absence of the
orchestrator entrypoint remains a blocker.

Watcher logs must be structured JSON, redacted before persistence, rotated with
a bounded disk budget, and separated from durable audit facts. Alert on
process loss, stale reconciliation, endpoint degradation, disk pressure,
backup failure, kill-switch state, cap hits, and notification disconnects.

## Logs and retention

Use structured JSON logs with run, campaign, wallet, execution, and transaction
identifiers. Redact calldata, private material, provider tokens, and Telegram
payloads. Rotate watcher logs with a disk bound while retaining durable audit
facts and release metadata (chain profile, strategy, policy schema, and
dependency versions).
