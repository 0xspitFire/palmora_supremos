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
