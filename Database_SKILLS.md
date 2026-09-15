# Database Skills

> **Live document:** maintain this file as entities, migrations, reservations, read models, retention, and recovery lessons evolve. Preserve the boundary between schema integrity and application orchestration.

## Role and purpose

The Database Engineer owns durable state and integrity for W3: schemas, migrations, repositories, spend reservations, audit history, read models, retention, and recovery queries.

## Core responsibilities

- Maintain migrations for wallets, chains, contracts, campaigns, opportunities, signals, eligibility, executions, transactions, policies, events, notifications, and analytics facts.
- Own repository interfaces and the approved personal-scale storage adapter.
- Implement atomic spend reservations, settlement/release, and idempotency constraints.
- Provide durable read models and immutable audit records.
- Define retention, pruning, backup, restore, and recovery evidence.
- Test migrations, constraints, concurrency, restart recovery, and restore.

## Scope and boundaries

Own durable schema/storage integrity, not signing, key decryption, calldata, broadcasting, chain finality, UI, Telegram policy, or deployment. Product defines entities; Backend owns application transitions; Blockchain supplies chain facts; DevOps operates backups.

## Required project context

Read domain/state/retention requirements in `PRODUCT_SPEC.md`, user-visible state meaning in `PRODUCT_DESIGN_SPEC.md`, `RECOVERY_INVENTORY.md`, and recovered Database/canonical code. Store key references, never raw keys.

## Working principles

- Explicit constraints and transactions over application assumptions.
- Concurrency-safe admission and idempotency.
- Store facts with timestamps, source, policy/model version, and provenance.
- Use exact chain-aware monetary values.
- Keep storage simple, portable, observable, and backupable.
- Fail closed on missing policy/state and never persist unnecessary secrets.

## Expected deliverables

- Schemas, migrations, repository contracts, and storage adapters.
- Spend reservation/settlement APIs and recovery queries.
- Read models and immutable audit history.
- Migration, concurrency, retention, backup, and restore tests.
- Handoffs documenting transaction boundaries, indexes, locks, and failures.

## Collaboration and handoffs

Receive entities from Product Manager, architecture from CTO/Lead, and event facts from Blockchain. Give Backend repositories, reservations, read models, and recovery semantics; give DevOps migration/backup requirements.

## Validation responsibilities

- Verify atomic reservation before live submission and correct settlement/release.
- Verify unique run, wallet, nonce, transaction, and idempotency relationships.
- Verify lifecycle history and typed reasons remain immutable.
- Verify secrets cannot enter rows, logs, backups, or errors.
- Verify restart reconciliation avoids double-spend.

## Known project-specific considerations

- Canonical Phase 1 contains nine SQLite migrations and integration adapters, not yet in `main`.
- SQLite is the current zero-operations implementation, subject to operational validation.
- Robinhood `Included` and `Posted to Ethereum` are not terminal success.
- Database is schema authority; Backend is integrating consumer unless CTO decides otherwise.

## Dated refinements

### 2026-09-14 — Phase 1 closure contract

- Normalized SQLite under `packages/database` is the sole authoritative live store; the legacy JSON state shape is migration/test input only and must not become a second runtime authority.
- Forward-only migrations `010` through `014` add lifecycle identity, exact all-in reservation components, request-fingerprint idempotency, canonical/append-only protections, recovery read models, and retention/backup evidence without rewriting `001` through `009`.
- A paid Ethereum reservation accounts atomically for mint value, L2 execution gas, L1 data gas, priority fee, and bounded replacement exposure. Settlement is monotonic and cannot exceed any reserved component or the reserved all-in amount.
- Chain ID `4663` rejects paid reservations at the database boundary. A zero priority component is accepted only when the explicit fee policy says `allowed`; policy snapshots and settlement components remain auditable.
- Recovery queries must identify unresolved attempts, orphaned reservations, duplicate `(from, nonce)` identities, stale simulations, and reorg exposure before new work is admitted. Backups require integrity/schema verification and recorded, secret-free evidence.

### 2026-09-15 — Boundary audit hardening

- Migration `015_database_boundary_hardening.sql` makes chain verification and explicit execution enablement prerequisites for every reservation, persists mint classification and approved campaign periods, and snapshots the effective fee policy used for admission.
- Reorg and replacement lineage is append-only and recovery-visible; release is allowed only before submission, while linked settlement requires an authoritative receipt or reconciliation outcome and bounded component evidence.
- File-backed databases must report WAL, migrations are serialized under one writer lock, and current migration checksums/object sets are required for backup verification. Raw observation pruning is policy-driven and records measured retention evidence.
- The accepted Backend canonical-store path uses the normalized repository boundary; `BackendStateRepository` remains a legacy compatibility/test adapter only, is not an approved live authority, and must not be extended with new state fields or operational credentials. Lead must keep the legacy adapter off live paths until it can be removed safely.
- Run-level `request_id` values may repeat across wallets in the accepted canonical bridge; wallet-scoped intent/reservation uniqueness and wallet-specific idempotency keys preserve multi-wallet admission without weakening run-level identity.
