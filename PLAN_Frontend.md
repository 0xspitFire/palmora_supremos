# Frontend Product/Engineering Plan

## Mandate

Define and, after the gates below, implement the Product Designer's future
surfaces against Backend read models. Phase 1 remains a CLI-only Execution
Foundation. Phase 2 is limited to read-only web intelligence, readiness,
calendar, reminder, alert, and operational-status views plus one-way Telegram
alerts. Phase 3 is the first phase with web or Telegram control mutations.

This plan is a contract and sequencing handoff. It does not authorize frontend
implementation, live execution, or a browser chain connection.

## Delivery gates

1. Do not implement Phase 2 UI until the Phase 1 foundation exit decision is
   recorded and the Phase 2 product/design contract is accepted.
2. Backend and Database must provide accepted `mintbot.read-model/v1` fixtures
   for snapshots, provenance, freshness, canonical states, blockers, amounts,
   finality, and redaction. A partial internal read model is not sufficient.
3. Product Owner and Engineering Lead must accept the Phase 2 surface matrix,
   copy, one-way Telegram event catalog, and no-mutation boundary.
4. Phase 3 may add campaign, approval, arm, fire-lane, execution-control, and
   two-way Telegram views only through separately versioned Backend mutations.
5. Phase 4 adds expanded opportunity evidence, replication verdicts, and signal
   explanations. Phase 5 adds the complete overview, analytics, and history.

## Phase 2 surface matrix

| Surface | Read-only responsibility | Safe Phase 2 action | Required dependency |
|---|---|---|---|
| Home/attention | Attention items, readiness counts, opportunity and calendar highlights, reminders, redacted health | `Inspect` | Backend snapshot and issue envelope |
| Opportunities | Evidence-backed candidate summaries, score/confidence, risks, gate, and freshness | `Inspect` | Durable opportunity/evidence/score records |
| Opportunity detail | Source evidence and recommended next inspection; no execution recommendation | `Inspect` | Field provenance and versioned score inputs |
| Wallet readiness | Per-wallet, per-campaign checks, costs, blockers, and freshness | `Inspect` or `Refresh read model` | Durable eligibility and simulation records |
| Calendar | Verified source, phases, time, price, supply, and readiness summary | `Inspect` | Calendar source authority, expiry, and sweep records |
| Reminders and alerts | Persisted reminder state and Telegram delivery state linked to canonical records | `Inspect` | Notification idempotency and delivery records |
| Run and health status | Dry-run/live status, partial results, reconciliation, staged finality, and redacted health | `Inspect` or `Wait for reconciliation` | Immutable lifecycle and finality history |

Phase 2 navigation omits unavailable future modules instead of rendering empty
execution controls. Phase 3 campaign and execution controls, Phase 4 detailed
replication investigation, and Phase 5 analytics are not implied by this
matrix.

Phase 2 defaults are one local operator, 5-minute readiness freshness,
15-minute discovery/calendar freshness, immediate critical alerts, grouped
non-critical reminders, 30-day read-model/alert retention, and 90-day audit
retention. Backend/Database expose the active policy version; the client does
not change these values.

## Application architecture

- Use route-level screens backed by typed Backend clients and server state. Keep
  UI state separate from read-model and execution state.
- Backend/Store is authoritative for campaign, wallet, transaction, gate,
  score, notification, and finality state. The client never infers a value from
  another field or declares optimistic success.
- Phase 2 transport is `GET` only, with server snapshots, cursor pagination,
  and conditional reads where supported. Refreshing a projection is not a
  mutation.
- The browser never calls a chain, RPC, sequencer, signer, database, or
  secret-bearing endpoint. All chain facts arrive through the redacted Backend
  projection.
- Amounts, IDs, hashes, blocks, and nonces remain typed opaque strings on the
  wire. Missing money is `Unknown`/`Unavailable`, never zero.

## Phase 2 interaction contract

Phase 2 safe verbs are `Inspect`, `View reason`, `Refresh read model`, `Wait for
reconciliation`, and `No safe action`. They do not change a campaign, wallet,
policy, reservation, nonce, transaction, or notification.

The following controls are Phase 3 or later and must not be rendered as active
Phase 2 controls: `Promote proposal`, `Approve`, `Arm dry run`, `ARM LIVE
CAMPAIGN`, `Run`, `Pause lane`, `Kill all`, `Exclude wallet`, `Fund wallet`,
`Validate again`, `Retry`, or any equivalent action. If a future action is
relevant to explain a blocker, show it as plain-language guidance without
invoking it.

Scores, confidence, evidence, risks, and safety gates are separate regions.
`Ready` means the recorded required checks pass at the supplied freshness; it
never guarantees inclusion, mint success, or final settlement.

## One-way Telegram contract

Phase 2 Telegram is an outbound notification channel only. It may send
opportunity, readiness, reminder, execution-status, kill, cap, and health alerts
from persisted events. It does not accept commands, callbacks, approvals,
replies, deep-link mutations, or transaction instructions.

- Every delivery has an idempotency identity, source event, canonical record ID,
  delivery state, attempt time, and redacted message.
- Backend assigns urgency. Kill, cap, blocked-health, unresolved-submission,
  reorg, execution-failed, and execution-aborted events are critical and are
  delivered immediately. Execution-status alerts default to immediate delivery;
  ordinary opportunity, eligibility, opening, deadline, and underfunded
  reminders may be grouped without losing source events.
- A message links only to a read-only canonical record. Delivery is not proof
  that a transaction was submitted, included, posted, or finalized.
- The message repeats the authoritative state and freshness where relevant;
  it never upgrades `Unknown`, `Stale`, `Blocked`, `Included`, or `Posted to
  Ethereum` into success.
- Telegram never contains keys, key references, credentials, raw calldata,
  signed bytes, provider payloads, secret URLs, or unnormalized exceptions.
- A failed or delayed delivery is an operational notification issue, not a
  change to the underlying campaign or transaction state.

## Component system

Use meaning-bearing primitives from the handoff: `StatusBadge`, `GateResult`,
`ConfidenceLabel`, `WalletIdentifier`, `TransactionIdentifier`, `Countdown`,
`EvidenceRow`, `RiskFlag`, `ReadinessRow`, `LifecycleStepper`, `SpendSummary`,
`FilterBar`, `DataTable`, `EventTimeline`, `Toast`, and `SystemHealthStrip`.

`ConfirmPanel` and spend-affecting controls belong to Phase 3. Avoid ambiguous
`Continue` or `Submit` labels in any future control surface.

## Core flows

- Attention: show what needs review first, then opportunities, readiness, and
  upcoming reminders. Partial or unavailable sources remain labeled.
- Opportunity: show project, network, opening time, price estimate, score and
  sample coverage, evidence, risks, gate, and `Inspect`. A score never grants
  permission or creates a spend action.
- Readiness: show `(wallet, campaign)` checks for funding, eligibility,
  constructibility, simulation, gas policy, chain verification, and freshness.
  Unknown, stale, and blocked rows are not counted as ready.
- Calendar/reminder: show source authority, verification time, expiry, phase,
  deadline, price estimate, and eligibility counts. An external or stale time
  is not an on-chain guarantee.
- Status/recovery: show dry-run versus live mode, partial wallet outcomes,
  reconciliation, replacement and reorg history, and whether other wallets
  continued. Robinhood success is only `Ethereum final`.

## Visual and responsive requirements

Use the specified dark low-glare operations surface, restrained amber action
token, semantic text/icon/status pairing, Inter/system sans, and monospace
technical values. Preserve attention and safety hierarchy over decorative
metrics.

Desktop uses navigation rail, health strip, sticky tables, keyboard row
inspection, and visible status summaries. Tablet collapses navigation and
prioritizes attention. Mobile supports attention, readiness summary, stale or
blocked review, and status without horizontal scrolling; it does not become an
administration or execution surface.

## State and error contracts

Every non-terminal presentation follows `[STATE] · [subject] · [what happens
next]`. Loading preserves the final layout. `Stale` shows the last-known value,
source time, and expiry while suppressing freshness-dependent claims. `Unknown`
names the missing authority and is never rendered as `Ineligible`, `Failed`, or
success. `Blocked` names the exact failed gate and offers no force action.
Unavailable or partial data preserves unaffected records and never invents
zero, false, empty-success, or ready values.

## Tests and done criteria

- Contract fixtures cover amount precision, snapshot consistency, provenance,
  freshness, canonical labels, score/gate separation, redaction, and GET-only
  resource behavior.
- State fixtures cover unknown eligibility, stale simulation/calendar data,
  hard simulation failure, unavailable dependencies, partial responses, dry run,
  reorg, staged Robinhood finality, and all terminal outcome distinctions.
- Telegram fixtures cover every Phase 2 event, idempotent delivery, failed
  delivery, canonical read links, redaction, and delivery-not-execution proof.
- Future UI tests cover keyboard focus, text alternatives to color, reduced
  motion, mobile critical flows, and no active mutation controls in Phase 2.
- Frontend is complete only when it reflects persisted state, never hides
  partial failures, and never turns a read-only recommendation into authority.

## Challenges and decisions

- Designer wireframes are destination contracts, not permission to implement
  Phase 1 UI or Phase 3 controls early.
- `Approve` remains distinct from `ARM LIVE CAMPAIGN`; neither exists as a Phase
  2 mutation.
- Score and gate remain separate; a high score cannot enable promotion or arm.
- Do not expose expected profitability without data coverage. Use realized,
  unrealized floor-marked estimate, or unknown with source and freshness.

## Dependencies and outputs

Consumes the accepted `mintbot.read-model/v1` snapshots, canonical lifecycle
events, freshness/provenance, redacted issue and retry policy, and opaque IDs.
Backend owns serialization, state mapping, and notification event semantics;
Database owns durable source records and history; Blockchain owns chain and
finality facts; DevOps owns authenticated transport and safe operations. Future
Frontend supplies bounded read-only views only in Phase 2. Any Phase 3 mutation
must be separately versioned, Backend-gated, confirmation-gated, and audited.
