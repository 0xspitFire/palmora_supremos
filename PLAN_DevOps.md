# DevOps Engineering Plan

## Mandate

Operate a small, recoverable system: Windows development box plus one small always-on host for the orchestrator. Prioritize custody, reproducibility, observability, and recovery over hypothetical scale. Do not introduce microservices or orchestration complexity without measured need.

## Environments and topology

- Development: Windows, Node >=20, pnpm 9.15.4, strict TypeScript, local Anvil fork, isolated test secrets.
- CI: reproducible pnpm install with lockfile, lint, typecheck, unit tests, and Anvil fork tests as merge gates. Pin viem/foundry/tool versions.
- Staging/dress rehearsal: isolated chain endpoints, tiny burner budgets, redacted telemetry, and explicit dry-run/live labels.
- Production: one orchestrator/worker process, SQLite WAL store, encrypted keystore or remote signer boundary, configured chain endpoint pool, Telegram notifier, structured logs, and backup target. Separate process roles only when a demonstrated isolation need exists.

## Custody and secrets

- Never place private keys, mnemonics, passphrases, provider keys, or raw secret payloads in source, config, logs, database dumps, Telegram, frontend state, CI artifacts, or process arguments.
- Phase 1 local custody uses independent wallet keys, envelope encryption, bounded decryption lifetime, zeroization, secure input, atomic keystore replacement, and encrypted backups. Windows file permissions are not treated as the security boundary.
- Reject compromised Helius credentials from the source repository and never copy them. Reject the unaudited `SponsoredMintExecutor.sol` and vanity-key tooling.
- Define backup restore, key rotation, loss, and revocation runbooks before real capital. Select cloud KMS, TPM-backed storage, or hardware signing before material budgets; prove `Signer` compatibility first.
- RPC and Telegram credentials come from the host secret mechanism, not versioned files. Rotate and audit access.

## CI/CD gates

Required checks: formatting/lint, strict typecheck, unit tests, custody leak regression, Anvil fork suite, migration tests, package build, and secret scanning. Fork tests must cover happy path, revert, sold-out, price drift, insufficient funds, cap race, kill mid-fleet, replacement, reorg, and restart reconciliation.

Build immutable versioned artifacts from the lockfile. Deploy only after migration dry-run and backup verification. Do not skip hooks or tests for live-fire work. Every release records chain-profile versions, strategy versions, policy schema, and dependency versions.

## Runtime operations

- Health probes cover process liveness, store writability, migration version, chain ID, endpoint latency/error rate, sequencer status, chain verification, signer availability, kill-switch state, and Telegram delivery.
- Logs are structured JSON with run/campaign/wallet/execution/transaction IDs, stage latency, endpoint attribution, and typed redacted errors. Use rotation and disk bounds; retain audit facts separately from prunable watcher noise.
- Metrics include submission-to-inclusion latency by chain/path, endpoint error/latency distributions, queue depth, reconciliation age, reservation exposure, simulation age/failure, notification delivery, and restart count.
- Alert on process down, stale reconciliation, endpoint degradation, disk pressure, backup failure, kill switch, cap hit, and notification disconnect. Telegram alerts link to canonical records and never imply delivery equals execution.

## Recovery procedures

1. Kill switch is the universal first response. It blocks future admission, not already-submitted transactions.
2. On restart, prevent new work until store and chain reconciliation completes for every in-flight intent.
3. Reconcile by wallet/nonce/hash; preserve endpoint attempts, replacements, pending, confirmed, reorged, and dropped outcomes.
4. Restore encrypted store/keystore backups into an isolated environment, verify checksums and schema, then rotate credentials if compromise is suspected.
5. Practice disk-loss, RPC outage, sequencer outage, Telegram outage, partial fleet failure, and reorg drills with post-drill reports.

## Phase sequence

### Phase 1

Make CI gates green, package Anvil, validate Ethereum/Base profiles, keep Robinhood unverified, establish secret scanning, local runbook, logs, process health, and smallest-value rehearsal controls.

### Phase 2

Deploy the persistent orchestrator and SQLite store, add restart recovery, backups/restore, WAL tests, Telegram one-way delivery, endpoint metrics, and disk/log rotation. Exit only after an unattended scheduled run survives a mid-flight process kill.

### Phase 3+

Add operational command authentication and replay protection, calendar/opportunity services, and richer read surfaces only as their roadmap gates open. Do not provision infrastructure for dashboard, ML, or high-scale indexing before usage justifies it.

## Challenges and decisions

- “Near-zero latency” is not an infrastructure SLA. Measure L2 time-to-sequencer and L1 inclusion/orderflow separately.
- A private relay or sequencer is not guaranteed; define blast fallback and its duplicate-send/reconciliation behavior.
- Robinhood must be visibly unverified and blocked until the characterization report proves endpoints, sequencing, gas, EIP-1559, private orderflow, and live SeaDrop behavior.
- SQLite, KMS choice, funding-graph privacy, Flashbots economics, and confirmation depth require written decision records and empirical tests.

## Definition of done

Operations are complete when a clean checkout reproduces CI, no secrets enter artifacts, the host can be rebuilt from documented configuration, backups restore successfully, health/alerts identify stale or unsafe conditions, kill/restart behavior is truthful, and a live run is bounded by durable caps and a tested recovery process.
