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

Phase 2 now includes a supervised, outbound-notification-only orchestrator
entrypoint at `packages/cli/dist/orchestrator-service.js` (the source launcher
is `scripts/orchestrator.mjs`). It persists the SQLite database in WAL mode,
persists restartable scheduler state in `MINT_BOT_JOBS_PATH`, reconciles before
scheduled work, and exposes loopback-only `/livez`, `/readyz`, `/health`,
`/status`, and `/metrics` endpoints. The service does not accept HTTP control
commands, handle wallet keys, sign transactions, or broadcast transactions.

The checked-in `ops/systemd/mint-bot.service` is a local WSL/host unit template,
not an installation or a production-readiness claim. It runs as an unprivileged
user, requires a startup kill-switch file, restarts on failure, keeps state and
logs on persistent paths, and leaves all existing Backend safety gates intact.
The dry-run CI configuration is `ops/ci/mint-bot.env`; the non-secret local WSL
template is `ops/wsl/mint-bot.env.example`. Start with
`MINT_BOT_SERVICE_MODE=dry-run`, and do not enable live mode based on a green
health or Telegram result.

### Required human inputs

1. Choose and provision the unprivileged host account, working directory, and
   persistent state/log/backup directories; set ownership and restrictive
   `UMask`/file permissions.
2. Create and keep engaged `KILL_SWITCH_PATH` before starting the service, and
   define the human-controlled procedure for removing it only after the
   applicable safety gates and approvals have passed.
3. Configure the host secret manager to provide `SECRET_STORE_PATH` containing
   the existing `TG_BOT_TOKEN` and `TG_CHAT_ID` names. Values must not be placed
   in repository files, unit files, arguments, CI variables, logs, or backups.
4. Provide the RPC/signer references required by the existing runtime and the
   host-only method for injecting `BACKUP_ENCRYPTION_KEY` into the backup unit.
5. Choose the loopback health port, NTP/time source, encrypted-backup destination,
   retention/restore owner, and incident escalation recipients.
6. Obtain the explicit human approvals and evidence required by the existing
   execution gates before any live-spend request. Phase 2 does not grant that
   approval and is not production/live readiness evidence.

### Observability and recovery

Structured JSON logs are redacted before stdout/file persistence and rotate at
`MINT_BOT_LOG_MAX_BYTES` with `MINT_BOT_LOG_MAX_FILES` bounded files. The
`MINT_BOT_RESTART_COUNTER_PATH` file backs the `mintbot_process_restarts_total`
metric across process restarts. The backup job writes a status-only record to
`BACKUP_STATUS_PATH`; its basename, checksum, encryption state, retention, and
timestamp are observable without exposing the backup key. Metrics include queue
depth, endpoint outcomes/latency classes, notification delivery, disk/log size,
reconciliation, backup, and process state. Alert conditions cover process loss,
stale reconciliation, endpoint degradation, disk pressure, backup failure,
kill-switch/cap blocks, and notification disconnects.

For a local dry-run smoke check, create the kill-switch file, use the CI env
template with temporary paths, run `pnpm ops:service-config`, then run
`pnpm typecheck`, `pnpm test`, and (after a build) `pnpm ops:orchestrator`. The
orchestrator command is a supervised process and should be stopped by SIGTERM;
it is not a live execution test.

## Logs and retention

Use structured JSON logs with run, campaign, wallet, execution, and transaction
identifiers only where those identifiers are safe. Redact calldata, private
material, provider tokens, Telegram credentials, and Telegram payloads. Rotate
watcher logs with a disk bound while retaining durable audit facts and release
metadata (chain profile, strategy, policy schema, and dependency versions).
