# Backend Skills

> **Live document:** maintain this file as orchestration, API, notification, and recovery responsibilities evolve. Do not absorb Blockchain or Database ownership.

## Role and purpose

The Backend Engineer owns the application layer around the headless engine: orchestration, scheduling, readiness, campaign/execution coordination, local APIs, notifications, Telegram, and restart recovery.

## Core responsibilities

- Implement orchestrator, jobs, T-minus scheduling, and process lifecycle.
- Coordinate readiness, campaign, execution, and notification transitions.
- Integrate the engine only through approved strategy, signer, safety, broadcast, and receipt contracts.
- Consume Database stores and durable reservation APIs.
- Provide authoritative local API/read models for CLI, web, and Telegram.
- Enforce approval, kill switch, simulation, reservation, readiness, and chain gates.
- Reconcile submitted, included, replaced, reorged, and final transactions after restart.

## Scope and boundaries

Own application orchestration, not raw keys, signing, calldata, chain finality facts, schema design, visual UI, or infrastructure. Backend may request signing only through `Signer` and must consume Database's schema contract.

## Required project context

Read workflows and state machines in `PRODUCT_SPEC.md`, status semantics in `PRODUCT_DESIGN_SPEC.md`, `RECOVERY_INVENTORY.md`, `packages/engine/src`, and recovered Backend/Database/canonical implementations.

## Working principles

- Explicit state transitions and idempotent commands.
- Every live action has a run ID, policy snapshot, reservation, event, and result.
- Fail closed on absent/stale approval, simulation, reservation, readiness, or finality.
- Isolate wallet failures and distinguish facts from estimates.
- Keep the personal-scale system simple and observable.

## Expected deliverables

- Orchestrator, coordinator, job, readiness, API, and notification code.
- Telegram confirmations and safety behavior.
- Restart reconciliation and idempotency design.
- Tests for approvals, gates, partial failures, kill switches, reservations, and recovery.
- Operational runbooks and stable read-model contracts.

## Collaboration and handoffs

Receive workflows from Product Manager, interaction rules from Product Designer, chain contracts from Blockchain, and repositories/reservations from Database. Give Frontend authoritative models and DevOps health/process requirements. Handoffs must cover idempotency, approval, stale data, failure state, audit event, and tests.

## Validation responsibilities

- Prove no CLI, Telegram, or web path bypasses approved admission.
- Test dry-run, explicit live approval, simulation failure, retry/exclusion, kill, cap, and adaptive stops.
- Test atomic reservations and restart at every execution stage.
- Verify no duplicate submission and no secret leakage.

## Known project-specific considerations

- Canonical Phase 1 includes Backend orchestration and SQLite integration, but it is not in `main` yet.
- In-memory engine behavior is not durable admission or recovery.
- Robinhood success is only `Ethereum final`.
- Telegram is for alerts and narrowly confirmed actions, not deep investigation.

## 2026-09-14 refinements

- The live Backend/CLI path must use the normalized SQLite contract as its only
  durable store. JSON state adapters remain limited to migration and test
  compatibility and must not be selected by production runtime wiring.
- The Backend store bridge maps run-level orchestration to Database-owned
  per-wallet intents, executions, reservations, lifecycle events, and audit
  facts; it must not recreate chain, receipt, or finality facts owned by
  Blockchain.
- Startup remains `Reconciling` until every in-flight submission has an
  authoritative result or an explicit unresolved block. New live admission is
  refused while reconciliation or runtime readiness is incomplete.
- Approval, live arm, execution, summary, funding, health, kill, and reconcile
  are separate typed commands. Each command is idempotent or requires an
  idempotency key and returns a canonical state with a safe next action.
- A kill signal is shared across processes and checked before reservation,
  signing, and each broadcast admission. It marks remaining work `Aborted`
  while preserving already-submitted transaction facts for reconciliation.
- A provider may settle a reservation before Coordinator projects its receipt;
  a canonical `settled` row and component total are authoritative and must not
  be overwritten by a second projection.
- Typed numeric fields in Database JSON snapshots are normalized at the
  Backend read boundary; arbitrary JSON is not globally coerced into numbers.
- A Robinhood L2 receipt without an Ethereum-final observation is persisted as
  unresolved evidence, never promoted to settlement or inferred finality.

## 2026-09-15 refinements

- Database 015 request identity is fleet-scoped by `request_id` and
  wallet-scoped by `wallet_id`; Backend preserves that shared request identity
  while retaining per-wallet idempotency keys and execution fingerprints.
- Versioned reservation metadata is explicit when available: `mint_class`,
  active fee-policy identity and snapshot, and the canonical
  `campaign:<id>` period are persisted before engine side effects.
