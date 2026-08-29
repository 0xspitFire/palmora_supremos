# Database Architecture Plan

## Mandate

Own the durable model, integrity, migrations, query patterns, retention, and reconstruction boundary. Store facts needed for operations and learning, not an indiscriminate raw blockchain archive. No key material enters ordinary records.

## Storage decision

Use SQLite in WAL mode as the default personal-scale store, subject to explicit validation on the Windows development box and Linux VPS: concurrent reservation behavior, locking, backup/restore, corruption handling, migration safety, and restart reconciliation. If those tests fail, record a decision before selecting another store. Do not build safety on process-local counters.

## Canonical model

Core entities: `chain_profile`, `wallet`, `wallet_group`, `wallet_balance`, `tracked_wallet`, `wallet_stats`, `contract`, `collection`, `drop`, `campaign`, `fire_lane`, `eligibility`, `opportunity`, `signal`, `transaction_intent`, `transaction_attempt`, `simulation`, `execution`, `gas_strategy`, `spend_policy`, `spend_reservation`, `spend_ledger_entry`, `notification`, `portfolio_position`, `portfolio_event`, `performance_metric`, and `audit_event`.

Use tables for durable identity/current state and append-only records for attempts, receipts, evidence, state transitions, notifications, reservations/settlements, and audit. Treat balances, readiness summaries, scores, and metrics as snapshots/derived projections with source timestamps and version references. Do not create a table solely because a conceptual noun exists.

## Required relationships and invariants

- Campaign references exactly one drop; execution references exactly one campaign and wallet.
- Wallet stores address/label/group/key reference only. Encrypted blobs belong to the custody boundary, not analytics or general domain rows.
- Every monetary movement links to an execution or funding transaction; gas, mint value, and refunds remain distinguishable.
- Eligibility is keyed by wallet, campaign/phase, and evidence source, with expiry and reason. `unknown` is not `ineligible`.
- Transaction intent is immutable. Attempts reference intent and preserve endpoint, response class, latency, hash, nonce, replacement relation, and redacted error.
- Simulation stores wallet/campaign/intent class, source block, checked-at, freshness policy, outcome, revert taxonomy, and tool/version.
- State transitions record prior/new state, actor/source, reason, timestamp, policy version, and evidence/policy snapshot where relevant.
- Spend reservations have unique idempotency keys and atomic status transitions (`reserved`, `settled`, `released`, `expired`); pending exposure counts toward caps.

## Indexes by query purpose

- Unique chain ID and wallet address per chain; wallet group and audit timestamp.
- Campaign state/trigger, campaign drop, fire lane state, and readiness by campaign/state.
- Execution by campaign, wallet, state, and created time; transaction attempts by hash, `(from, nonce)`, and intent.
- Opportunity by disposition, chain, score, freshness, and fingerprint; signals by opportunity/source/time.
- Eligibility by campaign, wallet, status, expiry; notifications by event/idempotency/delivery state.
- Portfolio events by position/collection/time and metrics by dimension/version.

Each index must be justified by an observed read path; avoid broad indexing of raw payloads.

## Historical and raw data policy

Retain executions, transaction attempts, simulations, scores, evidence references, audit events, and PnL indefinitely at personal scale. Keep raw watcher/mempool noise only when it supports deduplication, replay, or an audit requirement; prune after 30 days with a documented job. Store block number/hash and source timestamps for chain-derived facts so reorgs and stale records can be identified.

Do not pretend floor prices are sale facts. Portfolio facts distinguish realized transfers/sales, gas and fees, unrealized floor-marked estimates with source/freshness, and unknown coverage.

## Migration and fixtures

- Version every schema change, run migrations deterministically, and never alter production manually.
- Forward migrations are required; rollback is a tested restore/forward strategy where destructive rollback is unsafe.
- Seed only deterministic development/test chain profiles, policies, and fixtures. Never seed real credentials or compromised provider keys.
- Include fixtures for a 3-wallet partial execution, replacement/reorg, stale simulation, cap reservation race, opportunity evidence, and FIFO ground truth.

## Query/read-model contracts

Expose transactionally consistent queries for readiness matrices, attention queues, active runs, wallet detail, opportunity evidence, campaign confirmation snapshots, and execution reports. Read models must include canonical state, next action, timestamps/freshness, gate results, retryability, and source IDs. Derived metrics must be versioned and linked to source facts.

## Tests and definition of done

- Migration apply/reapply, constraint, foreign-key, uniqueness, check-boundary, UTC daily cap, and referential-integrity tests.
- Concurrent reservation and idempotency tests on actual supported platforms.
- Query-plan tests for campaign/wallet/execution/opportunity paths and retention-pruning tests that protect indefinite audit facts.
- Backup restore and restart-reconstruction tests prove no orphaned submission knowledge or double-spend after process failure.

## Challenges and decisions

- The PM domain list is not a mandate for event sourcing. Use current-state tables plus targeted historical events; preserve reconstruction without turning every write into a distributed stream.
- SQLite is appropriate only if WAL/locking and backup tests pass in both environments.
- Store policy/evidence snapshots at arm and approval so later config changes cannot rewrite what was authorized.
- Confidence `N0` is undefined; persist raw sample size and model version, but do not persist a misleading calibrated probability.

## Dependencies and outputs

Consumes canonical blockchain facts, engine outcomes, and backend transitions. Supplies transactional repository interfaces, read models, durable cap ledger, audit/reconstruction records, and analytics facts. Database does not decide mint calldata, sign, broadcast, or design UI behavior.
