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

## 2026-09-26 — Phase 2 competency refinements

### Durable orchestration and projection engineering

- Build long-running orchestrators around persistent jobs, collision-resistant
  idempotency keys, recoverable leases, bounded concurrency, retry classification,
  and explicit terminal states. A scheduler must survive process restart without
  replaying completed work or accepting live work before boot reconciliation.
- Convert T-minus schedules from chain time through a recorded clock offset;
  retain target time, scheduled time, offset, and policy version so timing
  decisions are reproducible rather than based on an untracked local clock.
- Model startup as a readiness state machine (`Cold`, `Reconciling`, `Ready`,
  `Blocked`) and preserve dependency, signer, kill-switch, and unresolved-
  submission blockers across coordinator and orchestrator boundaries.
- Treat the normalized SQLite repository as the live authority for scheduler
  jobs, readiness observations, delivery state, lifecycle facts, and settlement
  evidence. JSON adapters are compatibility/test fixtures only; new operational
  state must not create a second live authority.

### Read-model and notification contracts

- Publish `mintbot.read-model/v1` envelopes with snapshot identity, availability,
  freshness, provenance, typed blockers, safe next actions, and explicit
  `unknown`/`stale`/`partial` states. Missing money, finality, readiness, or
  reconciliation facts remain unknown; clients never infer chain truth.
- Keep Phase 2 transport GET-only and map backend state without exposing key
  references, raw provider payloads, calldata, credentials, or secret-like
  errors. Redaction is applied before persistence, notification dispatch, and
  read-model serialization.
- Implement notifications as one-way, idempotent outbox delivery with
  canonical read links, persisted attempts, retry-safe transitions, failure
  evidence, and deduplication. Delivery is never execution proof and Telegram
  does not become a mutation or approval surface.
- Project chain-specific finality and gas facts without flattening them into a
  generic success state: receipts carry provenance, gas components, staged
  Robinhood status, reconciliation evidence, and downgrade/reorg visibility.

### Cross-layer custody and safety integration

- Require explicit signer readiness in live admission in addition to secret-store
  references, custody policy, attestation, notification, chain verification,
  backup, and kill-switch health. Optional compatibility fields may support old
  fixtures, but an explicit negative readiness signal always blocks live work.
- Integrate Backend only through Coordinator, Signer, reservation, lifecycle,
  and finality contracts. Canonical identity must remain bound across run,
  intent, execution, wallet, nonce, attempt, receipt, and reconciliation rows;
  raw SQL or result-ID rebinding cannot bypass those guards.
- Preserve partial-failure semantics: abort unsent work, retain submitted facts,
  settle only from authoritative receipt/reconciliation evidence, and never
  overwrite provider-settled reservations with a later weaker projection.

### Evidence-gated delivery leadership

- Use actual Git ancestry, not branch labels or recovery prose, as integration
  authority. Synchronize against the requested base, resolve conflicts by
  preserving approved safety behavior and adopting newer invariant tests only
  deliberately, then rerun generated-package builds before dependent tests.
- Treat environment, verify, Anvil, Docker, review approval, and clean-worktree
  evidence as independent release gates. A skipped, cancelled, or stale check is
  not a pass for the updated commit; rerun on the approved runner and inspect
  job-level conclusions before merge.
- Communicate cross-agent handoffs with commit ancestry, changed boundaries,
  test counts, CI run/job identifiers, known blockers, and explicit merge
  decisions. Escalate changed-base conflicts or policy changes to the Product
  Owner instead of silently widening scope.

### Chain-specific operational expertise

- Treat Robinhood Chain `4663` as direct-to-sequencer, not Ethereum private
  orderflow: priority fee does not imply queue priority, paid mints remain
  blocked, and success requires the staged path `soft -> posted -> Ethereum
  final`.
- Reserve Robinhood FREE mint exposure as zero value plus independent L2
  execution-gas, L1 data-gas, and bounded priority-fee components. Preserve
  pending/posted evidence across restart and do not promote soft or posted state
  to settlement or Ethereum finality.
- Distinguish local deterministic tests from release evidence. Strict archive
  fork replay, native-WSL environment attestation, migration/backup checks, and
  protected CI are separate proof obligations; passing unit tests alone never
  authorizes unattended execution.
