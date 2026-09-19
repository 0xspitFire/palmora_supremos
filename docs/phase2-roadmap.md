# Phase 2 Roadmap: Intelligence MVP

> Delivery lead artifact. Baseline: clean `origin/main@29d837c`.
> Product Owner approval recorded: the `mintbot.read-model/v1` namespace and
> Phase 2 read-only web intelligence/readiness/calendar/reminders plus one-way
> Telegram are approved. This file is planning and
> acceptance documentation only; it does not implement feature code, handle
> secrets, or authorize/broadcast transactions.

## 1. Decision Summary

Phase 2 is the Intelligence MVP that follows the Phase 1 Execution Foundation.
It makes stored intelligence and readiness understandable to an ordinary
operator without making the browser or Telegram a spending authority.

Phase 2 delivers:

- A persistent orchestrator, durable store, restart reconciliation, spend
  reservations, and run/event records needed for unattended scheduled work.
- Tracked-wallet observations, candidate opportunities, deterministic scoring,
  mint-calendar data, eligibility/readiness facts, and reminders.
- A versioned, read-only Backend projection for web and other consumers.
- Consumer-friendly web views for intelligence, readiness, calendar, alerts,
  runs, and health.
- One-way Telegram alerts with recorded delivery state and links to canonical
  records.

Any scheduled execution remains behind the Phase 1-approved Backend/Engine
admission path and its safety gates. Phase 2 web pages and Telegram alerts do
not approve, arm, sign, broadcast, pause, kill, retry, or otherwise mutate a
run. A Phase 2 success decision does not enable Robinhood Chain 4663.

## 1.1 Product Owner Operating Defaults

The Product Owner approved these Phase 2 operating defaults on 2026-09-17.
They constrain freshness, notification behavior, and retention; they do not
expand the Phase 2 feature boundary.

| Policy | Approved default | Required behavior |
|---|---|---|
| Operator model | One local operator | No multi-user roles, tenancy, billing, or shared-execution permissions. Read-only web access does not change the single-operator authority model. |
| Readiness freshness | 5 minutes | Backend marks wallet-by-mint readiness stale after five minutes; the client displays server freshness and suppresses freshness-dependent claims/actions. |
| Discovery/calendar freshness | 15 minutes | Discovery and calendar observations older than fifteen minutes are explicitly stale; they cannot be presented as current opening or opportunity evidence. |
| Immediate alerts | Kill-switch, spend-cap, failed, and blocked events | Deliver immediately, record delivery state, preserve canonical status/cause, and never treat delivery as execution proof. |
| Grouped reminders | Started, succeeded, and underfunded events | Group related events into reminders while preserving per-run/per-wallet canonical records. The grouping window/cadence remains an implementation decision. |
| Read-model/alert retention | 30 days | Retain Phase 2 read-model projections and alert/delivery records for 30 days unless a source fact is covered by the longer-lived fact policy below. |
| Audit retention | 90 days | Retain operational audit projections for 90 days, with purge behavior tested and documented. The classification of immutable safety/audit facts is an explicit assumption in §11. |

Freshness windows are Backend/Database policy values, versioned and returned in
the read model; the browser never computes or extends them. The 30-day and
90-day defaults apply to projections and operational audit retention. They do
not silently override the source specifications' requirement to retain
executions, transaction attempts, simulations, scores, evidence references,
and PnL needed for financial or safety reconstruction; that retention boundary
must be classified and approved before purge jobs are enabled.

## 2. Reconciled Authority

The documents below are used together, with the Product Owner addendum and the
decision in this roadmap taking precedence over older wording.

| Source | Binding Phase 2 interpretation |
|---|---|
| `PRODUCT_SPEC.md` §§0, 4, 6, 7, 8, 14, 17 | Phase 1 is the execution prerequisite. Phase 2 owns the orchestrator, store, discovery/intelligence, calendar/readiness, notifications, observability, and consumer-facing intelligence/readiness surfaces. P2 exits only after an unattended scheduled run survives restart and reports via Telegram. |
| `PRODUCT_DESIGN_SPEC.md` §§Design Direction, Product Sequence, Audience, Core Surfaces | The primary experience is plain-language `Observe -> Evaluate -> Prepare -> Approve -> Execute -> Monitor -> Learn`. Phase 2 web is inspection/readiness first; scores never authorize spending; canonical states and Robinhood blocked copy are mandatory. |
| `PLAN_Backend.md` §§Phase 2, Service contracts, API/event behavior | Backend owns scheduling, persistence, reconciliation, atomic reservations, kill/cap enforcement, read models, and one-way notification delivery. Retryability and state are server decisions. |
| `PLAN_Frontend.md` §§Application architecture, Component system, State/error contracts | The line saying Phase 2 has “no web dashboard” is superseded by the Product Owner decision and this roadmap. The remaining architecture, safety, responsive, accessibility, and state-rendering rules apply to the Phase 2 read-only implementation. Campaign controls remain Phase 3. |
| `docs/frontend-phase2-read-model-api-contract.md` §§1-12 | The Product Owner-approved `mintbot.read-model/v1` namespace and scope are the web handoff. The contract is `GET`-only, snapshot-based, redacted, provenance/freshness-aware, string-safe for amounts, and never an authorization contract. Field-level semantics still require specialist acceptance and fixtures before frontend implementation. |

Two additional sequencing clarifications resolve wording differences in the
source set:

- Phase 2 computes and displays read-only calendar and wallet-by-mint
  readiness. Phase 3 formalizes the campaign/fire-lane workflow and adds the
  operational controls around that information.
- Phase 2 may show evidence-backed opportunity summaries, score factors, risks,
  and safe inspection paths. Phase 4 expands investigation into the full
  replication/evidence workflow; no Phase 2 view may imply blind replication.

## 3. Scope

### 3.1 In Scope

| Workstream | Phase 2 outcome | Primary owner |
|---|---|---|
| Durable runtime | One long-running orchestrator with persistent jobs, chain-time-aware T-minus scheduling, bounded concurrency, idempotency, and boot-time reconciliation before new live work | Backend |
| Durable store | SQLite/WAL as the default candidate, subject to Windows and Linux-host locking, migration, backup, restore, corruption, and restart tests; wallets metadata, thin campaign/job records, executions, events, attempts, simulations, eligibility, opportunities, notifications, and spend ledger/reservations | Database |
| Safety continuity | Atomic worst-case spend reservations, settlement/release, shared kill-switch cancellation, and preservation of already-submitted work across process boundaries | Backend + Database + Blockchain |
| Intelligence | Tracked-wallet ingestion, observation deduplication, candidate Opportunity records with evidence, deterministic `v1-rules` scoring, confidence/sample coverage, risk flags, and freshness | Backend + Blockchain + Database |
| Calendar/readiness | Upcoming-mint records and per-wallet/per-mint eligibility/readiness with typed checks, source time, expiry, provenance, actionable blockers, 5-minute readiness freshness, and 15-minute discovery/calendar freshness | Backend + Blockchain + Database |
| Read model/API | Accepted version of `mintbot.read-model/v1`; authoritative snapshot envelope, cursor reads, canonical states, amounts as decimal base-unit strings, freshness, provenance, retry policy, finality/reorg history, safe issues, and allowlist redaction | Backend + Database |
| Web | Read-only Home, opportunity, calendar, readiness, run/transaction, alert, and health views backed only by the accepted read model; consumer copy with optional advanced detail | Product Designer + Frontend |
| Telegram | One-way alerts for execution and safety outcomes, underfunding, openings, eligibility, and high-score opportunities; immediate kill/cap/failed/blocked alerts; grouped started/succeeded/underfunded reminders; idempotent delivery records and canonical links | Backend + DevOps |
| Observability/operations | Run IDs, endpoint and queue metrics, reconciliation age, freshness/error indicators, log rotation, backup/restore evidence, and safe health summaries | DevOps + Backend |

The Phase 2 web resource set is the proposal in the read-model contract:

- `GET /api/v1/read-model/home`
- `GET /api/v1/read-model/opportunities`
- `GET /api/v1/read-model/opportunities/{id}`
- `GET /api/v1/read-model/calendar`
- `GET /api/v1/read-model/campaigns/{id}/readiness`
- `GET /api/v1/read-model/runs/{id}`
- `GET /api/v1/read-model/alerts`
- `GET /api/v1/read-model/health`

These paths remain proposals until the contract gate accepts their final wire
names. A displayed “next action” may explain a future CLI/Backend action, but
Phase 2 web exposes only inspection or read-model refresh behavior.

### 3.2 Explicitly Out of Scope

- Browser or Telegram approval, live arm, execute, pause, kill, retry,
  reservation, funding, or any other mutating command.
- `POST`, `PATCH`, or `DELETE` routes under `mintbot.read-model/v1`.
- Browser RPC, wallet-provider injection, client-side chain reads,
  client-side simulation/eligibility/scoring, signer access, key material,
  mnemonics, passphrases, credentials, raw transactions, or raw calldata.
- Formal Phase 3 Campaign and FireLane controls, manual arm/approve flow,
  adaptive stop controls, operational execution controls, and two-way Telegram.
- Full opportunity investigation and qualified replication; replication is a
  Phase 4 concern and always requires explicit, simulated, operator-approved
  plans.
- PnL, attribution, learning feedback, full dashboard analytics, and full
  historical exploration, which are Phase 5 concerns.
- ML scoring, multi-user auth/roles/tenancy/billing, public SaaS packaging,
  non-EVM chains, vanity wallets, shared-mnemonic custody, compromised
  provider credentials, and unaudited sponsor contracts.
- Enabling Robinhood execution or paid Robinhood mints. Positive SeaDrop
  characterization is evidence only; integrated operational release gates are
  separate and remain blocking.

## 4. Phase 2 / Phase 3 Boundary

| Capability | Phase 2: Intelligence MVP | Phase 3: Controlled Operations |
|---|---|---|
| Web | Read-only intelligence, opportunity summaries, calendar, readiness, run/alert/health projections; safe actions are inspection and supplied read refresh | Authenticated, confirmation-gated campaign, preparation, approval, arm, fire-lane, execution, and recovery controls |
| Telegram | One-way alerts/reminders and canonical record links; delivery is not execution proof | Authenticated two-way commands with immutable IDs, replay protection, explicit second confirmation, and audit events |
| Campaigns | Thin campaign-as-job records and read-only readiness/run projections | Formal Campaign and FireLane state machines, operator approval distinct from `ARM LIVE CAMPAIGN`, adaptive stops, and per-lane operations |
| Readiness | Compute and display wallet-by-mint checks, freshness, blockers, unknown/stale/ineligible distinctions, and cost estimates | Use readiness in controlled preparation/arming, with complete campaign snapshots and command permissions |
| Calendar | Read-only upcoming-mint records, source authority, timing, and readiness summaries | Operational calendar/eligibility workflows and deadline-driven controls |
| Execution | Only already-approved CLI/Backend/Engine pathways may perform scheduled work after Phase 1 gates; no new web/Telegram authority | Explicit preparation and arm from an approved web/Telegram command contract, still behind Backend, reservations, simulation, and finality gates |
| Opportunity | Candidate records, deterministic score, evidence summaries, risk flags, confidence, and `Inspect` | No automatic execution; richer operational handling may be added only under later approved scope; qualified replication remains Phase 4 |

Phase 2 completion must not be used as implied approval for any row in the
Phase 3 column.

## 5. Milestones and Deliverables

Milestones are ordered gates, not parallel permission to bypass a dependency.
Work may be developed in parallel after its input contract is accepted, but
integration follows the handoff order in §10.

### M0 — Phase 2 Entry and Scope Freeze

**Owners:** Engineering Lead, Product Owner/Product Manager
**Dependencies:** Phase 1 exit evidence and the current published baseline.

Deliverables:

- Accepted Phase 1 evidence package for fork coverage, custody, CLI workflow,
  kill/caps, reconciliation, CI, and smallest-value rehearsal policy.
- Written confirmation that Phase 2 web is read-only and Telegram is one-way.
- Written confirmation that Robinhood remains characterized/blocked and paid
  Robinhood remains blocked.
- Approved owner map, boundary table, and contract-review participants.

Exit gate: the Product Owner and Engineering Lead explicitly accept Phase 2
entry. Missing Phase 1 evidence is a blocker, not a Phase 2 work item to hide.

### M1 — Durable Store and Orchestrator Foundation

**Owners:** Database (store), Backend (orchestrator), DevOps (runtime)
**Dependencies:** M0.

Deliverables:

- Versioned migrations and integrity constraints for the Phase 2 entities;
  immutable intents/attempts/events where required; no key material in domain
  rows.
- Atomic chain/campaign/day spend reservations with idempotency keys and
  pending exposure included in cap calculations.
- Persistent jobs, T-minus scheduling using chain-time offset, bounded worker
  concurrency, run IDs, and restart reconciliation by wallet/nonce/hash.
- Kill-switch checks before reservation, signing, and each broadcast admission;
  submitted work is preserved and unresolved work is not silently failed.
- Backup/restore and cross-platform WAL/locking evidence on the development
  box and target host.
- Retention jobs and documented classes for the approved 30-day read-model/
  alert window and 90-day operational-audit window; immutable source facts
  required for safety and financial reconstruction are not pruned by these
  defaults.

Exit evidence: migration/restart/reservation tests pass; a process kill cannot
create an orphaned submission or double reservation; the orchestrator does not
sign and the client does not become a safety boundary.

### M2 — Chain Facts, Readiness Inputs, and Status Mapping

**Owners:** Blockchain Engineer, CTO/status authority, Backend
**Dependencies:** M0; consumes Phase 1 engine and chain evidence.

Deliverables:

- Authoritative chain/drop observations with source block, observed time,
  expiry, typed errors, and per-wallet or justified-class simulation facts.
- Eligibility/readiness inputs for funding, constructibility, simulation,
  chain verification, evidence freshness, gas policy, runtime readiness, and
  reconciliation.
- Canonical mapping for `Prepared`, `Submitted`, `Included`, `Posted to
  Ethereum`, `Ethereum final`, `Replaced`, `Reorged`, `Failed`, `Aborted`, and
  `Unknown`; intermediate Robinhood stages never mean success.
- `RawCalldataStrategy` only if still required by the Phase 2 engine plan, and
  only behind the existing Backend/CLI safety path; it is not a web feature.

Exit evidence: Backend can consume authoritative facts without deriving chain
truth in the browser; stale, unknown, failed-simulation, reorg, and Robinhood
blocked fixtures are available.

### M3 — Read-Model Contract Fixtures and Implementation Readiness

**Owners:** Backend and Database, with Engineering Lead, Blockchain/CTO,
Product, Product Designer, and DevOps sign-off
**Dependencies:** M1 and M2.

Deliverables:

- Product Owner-approved `mintbot.read-model/v1` namespace implemented as the
  accepted field-level contract, or a recorded versioned decision if the
  proposal changes.
- Snapshot envelope with `requestId`, consistency, availability, freshness,
  issues, cursors, and authoritative generated/captured times.
- String-safe `EthAmount`/quantity serialization; explicit estimated,
  reserved, actual, and unknown amounts; independent Robinhood gas components.
- Field-level provenance, source blocks, evidence/model/policy versions,
  readiness checks/blockers, Backend-owned retry policy, and complete finality,
  reorg, abort, cancellation, failure, and unknown history.
- Allowlist serializer and fixtures proving no secrets, credentials, endpoint
  values, provider payloads, raw calldata, or signed bytes can escape.

Exit gate: all contract owners accept fixtures and rendering semantics. The
frontend remains ineligible until this gate is green.

### M4 — Intelligence, Calendar, and Readiness MVP

**Owners:** Backend (services), Database (facts/queries), Blockchain (chain
  observations), Product Manager/Designer (meaning and copy)
**Dependencies:** M1, M2, and M3.

Deliverables:

- Tracked-wallet records and ingestion of mint-related observations with
  deduplication and source timestamps.
- Opportunity lifecycle records with evidence, risks, disposition, freshness,
  and candidate summaries.
- Deterministic `v1-rules` score with persisted inputs/model version and sample
  coverage; no invented calibrated probability while `N0` is undefined.
- Calendar entries with source authority, opening/closing/phase data, price,
  supply, method, expected gas, verification/expiry, explicit unknowns, and
  the approved 15-minute freshness policy.
- Wallet-by-mint readiness matrix that distinguishes `Unknown`, `Unfunded`,
  `Funded`, `Eligible`, `Ready`, `Stale`, `Blocked`, `Failed`, and `Skipped`;
  simulation failure is a hard block and unknown eligibility is not
  ineligible. Readiness freshness is five minutes and is server-enforced.

Exit evidence: seeded and replayable records render the required source time,
plain-language explanation, score/gate separation, and exact safe blocker.

### M5 — One-Way Telegram Delivery

**Owners:** Backend (dispatcher), DevOps (host/transport/monitoring), Product
  Designer (templates), Product Owner (copy gate)
**Dependencies:** M1, M3, M4 event catalog; bot configuration is supplied by
the existing host secret mechanism and is not handled by this roadmap.

Deliverables:

- Idempotent, retry-aware delivery records for execution started/succeeded/
  failed/aborted, kill-switch engagement, spend-cap threshold, underfunding,
  opening soon, eligibility found, and high-score opportunity events.
- Immediate delivery for kill-switch, spend-cap, failed, and blocked events;
  grouped reminders for started, succeeded, and underfunded events. Preserve
  per-event/per-wallet records even when the user-facing reminder is grouped.
- Plain-language messages with canonical run/opportunity/readiness links and
  explicit status/freshness; delivery never claims execution success. Retain
  alert and delivery projections for the approved 30-day window.
- No command parser, callback handler, approval route, live-arm action, secret,
  key, credential, raw error, or raw transaction in Telegram.

Exit evidence: a test event produces one recorded delivery, retries safely,
links to the authoritative record, and remains clearly one-way.

### M6 — Read-Only Web Intelligence and Readiness

**Owners:** Product Designer (IA/copy), Frontend (implementation/tests),
Backend/Database (fixtures and truth)
**Dependencies:** M3 contract acceptance and M4 read data; M5 is not a reason
to add web mutations.

Deliverables:

- Home attention/readiness summary, opportunity summaries/detail, calendar,
  wallet-by-mint readiness, run/transaction history, alerts, and redacted
  health views where the corresponding records exist.
- Typed API client and server-state rendering; no direct database, chain,
  provider, or signer access; no client-side business logic or optimistic
  success.
- Consumer copy for cost, risk, state, freshness, next safe step, and
  Robinhood blocked status; technical evidence is progressive/optional.
- Responsive and accessible inspection flows with semantic status text/icons,
  stale/partial/loading/unavailable layouts, and no unsafe action affordances.

Exit evidence: frontend contract/workflow tests pass for all required states,
including score versus gate, unknown/stale readiness, dry run, partial result,
reorg, staged finality, abort, failure, and redaction.

### M7 — Integrated Phase 2 Release Candidate

**Owners:** Engineering Lead, all specialists, Product Owner
**Dependencies:** M1-M6 and every acceptance criterion in §8.

Demonstrate the complete bounded slice:

```text
stored chain/event facts -> readiness/opportunity/calendar projections
-> scheduled Backend job -> restart/reconciliation -> canonical run record
-> one-way Telegram alert + read-only web projection
```

No step adds a browser or Telegram mutation path. The release candidate is
eligible for Phase 2 Product Owner acceptance only after the validation matrix
and evidence packet are complete.

## 6. Ownership and Responsibilities

| Owner | Phase 2 responsibility | Cannot own or bypass |
|---|---|---|
| Product Owner / Product Manager | Scope decision, P1/P2/P3 gates, consumer language, risk/cost policy, calendar source authority, Robinhood block, release acceptance | Technical truth, signer access, or an implicit approval through a score/alert |
| Engineering Lead | Dependency/order control, contract acceptance, integrated evidence, go/no-go, merge coordination | Waiving P1 or safety evidence for schedule |
| Database | Schema, migrations, invariants, indexes, durable facts/history, reservations, query/read-model source, fixtures, retention | Calldata, signing, broadcasting, or UI permission decisions |
| Backend | Orchestrator, scheduling, reconciliation, readiness aggregation, scoring service boundary, read API/serializer, notification dispatcher, safe retry policy | Signing, browser-chain truth, client-side overrides, or exposing secrets |
| Blockchain Engineer / CTO | Chain/drop observations, simulation and finality semantics, strategy facts, typed chain failures, Robinhood characterization/block state | Telegram/UI behavior, database authority, or enabling 4663 without the separate release gate |
| DevOps | Reproducible CI, target host, authenticated server transport, health/metrics/logging, backup/restore, deployment and secret-boundary controls | Reading or copying secret values into this artifact, client state, logs, or test fixtures |
| Product Designer | IA, plain-language state/cost/risk copy, alert templates, responsive safety hierarchy, PO content review | Authorizing spend or inventing state from sparse data |
| Frontend | Typed read-only web client, rendering rules, responsive/accessibility/workflow tests | RPC, database, signer, execution, optimistic success, or mutation endpoints |

## 7. Product Owner Gates

| Gate | Required decision/evidence | Blocking rule |
|---|---|---|
| PO-0: P2 entry | Accept all Phase 1 exit evidence in `PRODUCT_SPEC.md` §17-P1, including fork/security/recovery/CLI/CI and the human-controlled rehearsal policy | Do not start Phase 2 implementation by treating P1 gaps as roadmap scope |
| PO-1: Scope freeze | Approve read-only web intelligence/readiness, one-way Telegram, and the Phase 2/3 boundary in §4; reject the stale “no web dashboard” planning line | Any web or Telegram mutation is out of scope and must be removed before review |
| PO-2: Store and contract | Decide whether SQLite/WAL passes both environments; record the Product Owner-approved `mintbot.read-model/v1` namespace and accept its field-level snapshot semantics, source authority, freshness policies, amount format, and redaction fixtures | Frontend cannot begin against mocks or an unaccepted field-level contract |
| PO-3: Product language and truth | Approve score/confidence vocabulary, `N0` unknown handling, readiness blockers, stale/unknown copy, canonical outcome labels, Telegram templates, and Robinhood blocked copy | A high score, alert, receipt, or intermediate Robinhood state cannot be shown as permission/success |
| PO-4: Release candidate | Witness the unattended schedule/restart/reconciliation path, truthful per-wallet results, one-way Telegram delivery, read-only web states, and validation evidence | No Phase 2 acceptance while data is inferred, unsafe actions are exposed, or recovery is ambiguous |
| PO-RH: Separate chain decision | Keep Robinhood execution disabled until archive replay, negative paths, per-wallet simulation, durable reservations, sequencer/RPC correlation, duplicate/restart reconciliation, finality observation, and bounded rehearsal all pass | P2 acceptance never changes 4663 enablement; paid Robinhood remains blocked pending value/exposure policy |
| PO-5: Phase 3 entry | Separately authorize mutating command contracts, authenticated operator identity, replay protection, explicit confirmations, Campaign/FireLane controls, and first operational web views | P2 completion is not permission to implement or merge Phase 3 controls |

## 8. Phase 2 Acceptance Criteria

All criteria require persisted evidence, not screenshots or a notification by
itself.

1. **Intelligence visibility.** Tracked wallets, upcoming mints, and candidate
   opportunities are visible with source time, freshness/provenance, risks, and
   plain-language explanations. Missing data is `Unknown`/`Unavailable`, not a
   fabricated zero or empty-success state.
2. **Readiness correctness.** Readiness is calculated per wallet and mint/
   campaign. Funding, eligibility, constructibility, simulation, gas policy,
   chain verification, evidence freshness, runtime, and reconciliation checks
   expose typed outcomes and actionable blockers. Readiness expires after the
   approved five-minute freshness window. Unknown eligibility is not
   ineligible; failed simulation is a hard block with no force option.
3. **Deterministic scoring.** Scores persist their factors, inputs, model
   version, confidence/sample coverage, freshness, and risks. Desirability and
   safety/permission gates are separate, and no score can authorize a command.
4. **Read-only web experience.** The accepted `mintbot.read-model/v1` projection
   powers consumer-friendly intelligence, readiness, calendar, alert, run, and
   health views. The client uses only typed server data and exposes no browser
   RPC, signer, database, mutation, or optimistic-success path.
5. **One-way Telegram.** The defined event catalog is delivered through an
   idempotent, retry-aware channel with recorded delivery state and canonical
   links. Kill/cap/failed/blocked events are immediate; started/succeeded/
   underfunded events are grouped reminders with per-event records retained.
   Telegram contains no secrets and does not represent delivery as proof of
   execution; no command or callback can mutate a run.
6. **Unattended recovery.** A scheduled mint job runs through the approved
   Backend/Engine path, survives a mid-flight process restart, reconciles every
   in-flight submission before new work, preserves partial wallet results, and
   cannot double-reserve or overspend pending exposure. The resulting state is
   reported through the canonical record and Telegram.
7. **Wire safety.** Every amount round-trips as a canonical decimal base-unit
   string with explicit asset/unit/scale and estimate/reservation/actual kind.
   Every decision-relevant fact has observation time, expiry/freshness, and
   provenance. Snapshot consistency, cursor behavior, redaction, staged
    finality, reorg history, abort/cancel/fail/unknown distinctions, and Backend
    retry policy are testable.
8. **Approved freshness and retention.** Readiness uses a five-minute
   freshness window; discovery and calendar use fifteen minutes. Read-model
   and alert projections are retained for 30 days, and operational audit
   projections for 90 days, with purge tests and source-fact retention
   classification recorded.
9. **Canonical UX states.** Web and alerts use the specified `Draft`,
   `Validating`, `Ready`, `Armed`, `Active`, `Completed`, `Failed`, `Aborted`,
   `Cancelled`, `Unknown`, `Stale`, `Blocked`, and readiness labels. Robinhood
   `Included` and `Posted to Ethereum` remain visible milestones and never
   render as success before `Ethereum final`.
10. **Operational observability.** Run IDs, stage/endpoint latency, queue depth,
   reconciliation age, notification delivery, freshness, dependency health,
   backup/restore status, and kill-switch state are available in redacted
   records and support reconstruction of the end-to-end run.
11. **Boundary and chain policy.** Phase 2 does not enable Robinhood or paid
    Robinhood; it does not add the Phase 3 command surface; and it does not
    introduce secrets, credentials, key material, raw signed transactions, or
    raw calldata into source, storage projections, web, Telegram, logs, or
    fixtures.

## 9. Validation and Evidence Plan

Validation is run by the owning specialists in the approved development/CI
environments. This roadmap neither requests nor reads credential values; any
credentialed integration uses the existing host/CI secret mechanism and keeps
values out of logs, artifacts, fixtures, and messages.

### 9.1 Required command gates

Run from a clean checkout with the lockfile and pinned toolchain:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- `pnpm test:fork` with the approved fork fixtures and no silent skip accepted
  for a release claim
- `pnpm ops:policy`
- `pnpm ops:secret-boundary`
- `pnpm ops:negative-cases`
- `pnpm ops:health`
- `pnpm ops:backup`
- `pnpm ops:restore-check`
- `pnpm ops:recovery-drill`

The exact CI job names may evolve, but the evidence must remain equivalent and
must be attached to the release candidate.

### 9.2 Specialist validation matrix

| Area | Required proof | Owner |
|---|---|---|
| Store | Forward/reapply migrations, foreign keys/uniqueness/checks, query plans, WAL locking on Windows and Linux host, atomic reservation races, UTC cap boundaries, backup restore, retention protection for audit facts | Database |
| Orchestrator | Chain-time scheduling, idempotency, bounded concurrency, crash after submission/before receipt, boot reconciliation, unknown outcome handling, kill/cap admission, no double-spend, partial results | Backend + Database |
| Blockchain facts | Per-wallet simulation/readiness evidence, typed drop/chain failures, source block/freshness, replacement/reorg/finality mapping, explicit Robinhood blocked fixtures, no browser chain access | Blockchain + CTO |
| Read model | Envelope/snapshot consistency, cursor reads, string-safe amounts, provenance/expiry, stale/unknown/partial/unavailable behavior, score/gate separation, retry policy, finality history, allowlist redaction | Backend + Database |
| Intelligence | Tracked-wallet dedupe, opportunity evidence, deterministic score thresholds, low-confidence handling, `N0` unknown display, calendar authority/expiry, readiness matrix | Backend + Database + Product |
| Telegram | Event catalog, idempotency, retries, delivery records, canonical links, redaction, alert-not-proof wording, absence of commands/callback mutations | Backend + DevOps + Designer |
| Web | Typed GET-only client, canonical labels, blocker/next-action grammar, no optimistic success, no secrets/RPC/database/signer access, responsive/accessibility, stale/partial/reorg/abort/unknown workflows | Frontend + Designer |
| Integrated slice | Schedule -> process kill/restart -> reconcile -> persist -> read model -> Telegram link, plus clean health/backup/recovery evidence | Engineering Lead + all owners |

### 9.3 Evidence acceptance rules

- A green unit test does not replace an integration or recovery drill where the
  criterion concerns process boundaries, persistence, or chain truth.
- A Telegram message, browser cache, receipt hash, or local optimistic state is
  never authoritative execution proof.
- Fork tests must use approved fixtures and record whether they actually ran;
  skipped tests cannot be reported as passing evidence.
- Redaction checks inspect responses, logs, error envelopes, telemetry, test
  artifacts, and notification payloads.
- Every unresolved assumption in §11 is either closed by a decision record or
  marked as a release blocker before PO-4.

## 10. Required Specialist Handoff and Review/Merge Order

This is the required dependency order for specialist handoffs. Independent
review may occur in parallel only after the listed predecessor artifact is
accepted. No merge, push, or chain broadcast is performed by this roadmap.

1. **Engineering Lead -> Product Owner/Product Manager:** Review this roadmap,
   confirm the P1 entry gate, accept the Phase 2 read-only web/one-way Telegram
   decision, and freeze the Phase 2/3 boundary.
2. **Database:** Deliver and review the durable schema, migration plan,
   reservation/integrity model, query interfaces, and deterministic fixtures.
   Engineering Lead accepts the store decision or records a replacement for
   SQLite/WAL.
3. **Blockchain Engineer/CTO:** Review the chain fact schema, simulation and
   finality/reorg mapping, eligibility evidence, and explicit Robinhood blocked
   state. Do not change 4663 enablement in this phase.
4. **Backend:** Consume the accepted Database and Blockchain contracts; deliver
   the orchestrator, reconciliation/reservation bridge, readiness/intelligence
   services, accepted read-model serializer/API, and one-way dispatcher. Backend
   review must prove the API is GET-only and redacted.
5. **DevOps:** Review the reproducible CI gates, deployment/transport/auth
   boundary, health/metrics/logging, backup/restore, and runtime recovery
   evidence. Secret values stay in the approved mechanism and out of the PR
   and artifact set.
6. **Product Designer/Product Owner:** Review information architecture, state
   grammar, score versus gate presentation, blocker/cost/risk copy, staged
   finality, Robinhood blocked copy, and one-way Telegram templates.
7. **Frontend:** Only after M3 contract fixtures and the Product Designer/PO
   content gate are accepted, implement and review the read-only web surfaces
   and their contract/workflow/responsive/accessibility tests.
8. **Engineering Lead integration review:** Run the complete validation matrix,
   inspect the diff and evidence packet, verify no Phase 3 controls or secret
   material entered the change, and produce a single release-candidate report.
9. **Product Owner Phase 2 acceptance:** Accept or reject against §8. A Phase 2
   acceptance does not merge or authorize Phase 3; Phase 3 requires PO-5 and a
   separately reviewed mutation contract.

For Git integration, merge only the reviewed, passing specialist change in the
same order above, then run the aggregate gates after each boundary-changing
merge. Do not cherry-pick historical specialist work already present in the
baseline, and do not merge a frontend branch against mock or unaccepted read
models.

## 11. Unresolved Assumptions and Decisions

| ID | Assumption/decision still open | Owner and resolution point | Impact if unresolved |
|---|---|---|---|
| A1 | Phase 1 exit evidence at `origin/main@29d837c` must be rechecked; the commit identity alone is not evidence that every §17-P1 criterion passed | Engineering Lead + PO at PO-0 | Blocks all Phase 2 implementation and unattended work |
| A2 | SQLite/WAL remains the default only if Windows and Linux-host locking, migration, backup/restore, corruption, and restart tests pass | Database + DevOps at M1/PO-2 | Store technology decision and schedule are blocked; no process-local safety fallback is allowed |
| A3 | Product Owner approved the `mintbot.read-model/v1` namespace and scope, but final field-level semantics, endpoint names, and additive defaults still require owner review; the current contract document remains `0.1.0-proposal` until that work is recorded | Backend/Database + Lead/PO at M3 | Frontend cannot start until the approved namespace has stable fields and fixtures |
| A4 | Calendar source authority, verification window, expiry policy, and treatment of manually entered/external times are not yet selected; the approved 15-minute freshness default applies once the source policy is defined | Product + Blockchain + Backend at M4/PO-3 | Calendar claims and readiness freshness cannot be presented as guarantees |
| A5 | Scoring denominator `N0` is undefined | Scoring owner + Product at M4/PO-3 | Display sample coverage and `unknown` confidence; never invent a probability or calibration |
| A6 | The exact definition of a Phase 2 scheduled job versus a formal Phase 3 Campaign is not fully specified | Backend + Product at M1/M4/PO-1 | Assume thin, preconfigured, Backend/CLI-admitted jobs only; no web/Telegram approval or live arm |
| A7 | Near-real-time watcher sources, backfill behavior, rate limits, and freshness policy details are not selected; the 15-minute discovery/calendar default is fixed | Blockchain + Backend + DevOps at M2/M4 | Opportunity/readiness completeness and alert latency remain bounded/possibly partial |
| A8 | The initial authenticated server transport, origin policy, TLS, and deployment placement for read-only web are not finalized | DevOps + Backend at M3/M6 | Web integration cannot be released; browser permissions are never a substitute |
| A9 | Telegram destination/chat policy, delivery retry limits, canonical link host, grouping window/cadence, and bot provisioning workflow need Product/DevOps confirmation; immediate-versus-grouped classes are approved | Product + DevOps + Backend at M5 | Alert acceptance is blocked, but no token or secret may be copied into this worktree |
| A10 | A dedicated `packages/web` implementation does not exist in the baseline | Frontend + Lead at M6 | Frontend starts only after M3; absence is not permission to create a mock or client-side chain path |
| A11 | Robinhood confirmation-depth/finality policy and operational enablement remain separate decisions even if compatibility evidence is positive | Blockchain/CTO + PO at PO-RH | 4663 stays read-only/blocked; paid mints stay blocked |
| A12 | The Phase 2 need for `RawCalldataStrategy` must be confirmed against the current engine plan | Blockchain + Backend at M2 | If needed, deliver backend/CLI-only with full safety gates; never widen web/Telegram authority |
| A13 | Currency display configuration and data coverage for estimates are not finalized | Product + Backend at PO-3 | Show ETH and clearly marked estimates; do not claim profitability or substitute missing values |
| A14 | Product Owner approved 30-day read-model/alert and 90-day operational-audit defaults, while source plans require indefinite retention of execution, attempt, simulation, score, evidence, PnL, and some audit facts; purgeable projections versus immutable reconstruction facts must be classified explicitly | Database + Product + Lead at M1/PO-2 | Do not enable purge jobs or claim retention compliance until the classification and supersession decision are recorded |

Until these assumptions are closed, the release candidate must fail closed and
label affected data partial, stale, unknown, or unavailable as appropriate.

## 12. Phase 2 Exit and Phase 3 Entry Checklist

### Phase 2 exit

- [ ] PO-0 through PO-4 decisions are recorded.
- [ ] P1 prerequisite and all M1-M7 evidence are attached.
- [ ] Read model contract and fixtures are accepted; every resource remains
  `GET`-only and redacted.
- [ ] Web intelligence/readiness views are read-only, responsive, accessible,
  and truthful for all required states.
- [ ] Five-minute readiness and fifteen-minute discovery/calendar freshness
  policies are versioned, server-enforced, and rendered as stale when expired.
- [ ] Telegram is one-way, idempotent, redacted, and linked to canonical
  records; immediate and grouped alert classes behave as approved.
- [ ] Thirty-day read-model/alert and ninety-day operational-audit retention
  jobs are tested, with immutable source-fact retention classification recorded.
- [ ] Unattended scheduled work survives restart and reconciles before new
  work; reservations, caps, kill, and partial outcomes are durable.
- [ ] Robinhood execution remains disabled and paid Robinhood remains blocked.
- [ ] No Phase 3 command, control, or authorization surface is present.

### Phase 3 entry

- [ ] PO-5 explicitly authorizes the controlled-operations scope.
- [ ] A separately versioned mutation/command contract is reviewed; it is not
  added to `mintbot.read-model/v1`.
- [ ] Campaign/FireLane state guards, approval versus live arm semantics,
  authentication, replay protection, consequence copy, reservations,
  simulation freshness, adaptive stops, and audit events are specified.
- [ ] Web and Telegram controls are implemented only through Backend state
  transitions; neither calls RPC or the signer directly.

## 13. Source References

- `PRODUCT_SPEC.md`: Product Owner addendum, modules, MVP scope, phased roadmap,
  functional requirements, handoffs, open decisions, and §17 acceptance
  criteria.
- `PRODUCT_DESIGN_SPEC.md`: product sequence, audience/canonical state rules,
  chain presentation, Robinhood blocked state, core surfaces, Telegram, and
  design acceptance rules.
- `PLAN_Backend.md`: orchestrator/store/notification phase plan, services,
  canonical states, API behavior, tests, and decisions.
- `PLAN_Frontend.md`: read-model architecture, routes/components, state/error
  contracts, responsive/accessibility tests, and ownership boundaries; its old
  Phase 2 web deferral is superseded as documented in §2.
- `docs/frontend-phase2-read-model-api-contract.md`: proposed
  `mintbot.read-model/v1` envelope, resources, serialization, freshness,
  provenance, finality, redaction, fixtures, and acceptance criteria.
