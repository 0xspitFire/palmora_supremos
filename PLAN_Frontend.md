# Frontend Engineering Plan

## Mandate

Implement the Product Designer’s future web operating surface against backend read models. Do not build frontend functionality ahead of its roadmap phase. Phase 1 remains CLI-only; Phase 2 has one-way Telegram alerts and no web dashboard.

## Delivery gates

1. Do not begin dashboard implementation until durable Store records, API contracts, canonical states, and Phase 3 scope are accepted.
2. Phase 3 may introduce campaign, readiness, calendar, and controlled operational views.
3. Phase 4 adds Opportunities and evidence/replication views.
4. Phase 5 adds Overview learning surfaces, Analytics, and full historical exploration.

## Application architecture

- Use route-level screens backed by typed API clients and server state. Keep UI state (filters, drawers, dialogs, preferences) separate from server state and execution state.
- Backend/store is authoritative for campaign, wallet, transaction, gate, score, and confirmation state. Never implement blockchain business logic or optimistic “success” in the client.
- Use incremental updates only where useful for active execution. Prefer the simplest transport supported by the backend, initially polling or server-sent events; do not add WebSockets without measured need.
- Keep action mutations narrow, scoped, idempotent, and confirmation-gated. A future web action calls a backend transition, never an RPC directly.

## Route structure

Future routes: Overview, Opportunities, Opportunity Detail, Campaigns, Campaign Detail, Wallets, Wallet Detail, Execution, Run Detail, Analytics, Calendar, and Settings. Navigation must omit unavailable phase features rather than render empty modules. Mobile simplifies to Overview, Attention, Runs, and More.

## Component system

Implement meaning-bearing primitives from the handoff: `StatusBadge`, `GateResult`, `ConfidenceLabel`, `WalletIdentifier`, `TransactionIdentifier`, `Countdown`, `EvidenceRow`, `RiskFlag`, `ReadinessRow`, `LifecycleStepper`, `SpendSummary`, `FilterBar`, `DataTable`, `EventTimeline`, `ConfirmPanel`, `Toast`, and `SystemHealthStrip`.

Buttons use scoped verbs: `Inspect`, `Validate again`, `Promote proposal`, `Arm dry run`, `ARM LIVE CAMPAIGN`, `Pause lane`, and `Kill all`. Avoid ambiguous `Continue` or `Submit` for spend-affecting actions.

## Core flows

- Campaign readiness: show per-wallet chain, balance, eligibility evidence, simulation result/age, gas, caps, and exact blocker. `Ready` never means guaranteed mint success.
- Arm confirmation: full-page review with drop/chain/contract, wallet scope, quantities, cost, gas ceiling, buffer, caps, broadcaster, simulation timestamps, exclusions, consequence copy, kill-switch state, and typed campaign ID for live mode. Record snapshot through backend.
- Execution monitor: aggregate-first lane counts, then wallet rows with state, hash, elapsed time, gas, attempts, receipt/replacement history, and retryability. Show that other wallets continue after isolated failure.
- Recovery: answer what happened, affected wallet, money spent, continuation, retry safety, and authoritative record. Distinguish pending, confirmed, reorged, replaced, failed, skipped, and aborted.
- Opportunity (Phase 4): primary action is `Inspect`; show score inputs, positive/negative evidence, confidence, freshness, risk flags, gates, eligibility, and replicability. Promotion creates a proposal, never a live action.
- Analytics (Phase 5): separate realized PnL from floor-marked unrealized estimate and unknown coverage; show sample sizes, denominators, freshness, fees, and source links.

## Visual and responsive requirements

Use the specified dark low-glare operations surface, restrained amber action token, semantic text/icon/status pairing, Inter/system sans, and monospace technical values. Preserve attention and safety hierarchy over decorative metrics.

Desktop uses navigation rail, health strip, sticky tables, keyboard row inspection, and visible execution summary. Tablet collapses navigation and prioritizes attention. Mobile supports status, kill state, failed-wallet review, readiness summary, and quick decision without horizontal scrolling; it does not become an administration surface.

## State and error contracts

Every non-terminal presentation follows `[STATE] · [subject] · [what happens next]`. Loading preserves final layout; stale data shows age and disables unsafe actions; RPC/chain errors preserve last known records while blocking live actions; unknown eligibility is not ineligible. Never render secrets, provider credentials, raw error payloads, or key blobs.

## Tests and done criteria

- Component tests for canonical labels, gates versus scores, status grammar, secret redaction, and disabled unsafe actions.
- Workflow tests for readiness, typed live arm, proposal promotion, partial execution, kill confirmation, reorg display, retry gating, stale data, and Telegram deep links.
- Responsive/accessibility tests cover keyboard focus, text alternatives to color, reduced motion, mobile no-scroll critical flows, and table inspection.
- Frontend is complete only when it reflects persisted state, does not hide partial failures, and every live-spend surface presents complete scope and safety totals.

## Challenges and decisions

- The designer’s dashboard wireframes are destination contracts, not permission to implement Phase 1 UI.
- “Approve” must remain distinct from “Arm live campaign”; labels and API mutations must enforce this.
- Score and gate must be separate fields and visual regions. A high score cannot enable promotion/arming through client logic.
- Do not expose “expected profitability” without data coverage; use the PM/CTO economic vocabulary.

## Dependencies and outputs

Consumes typed backend read models, lifecycle events, action permissions, retryability, snapshots, and canonical IDs. Supplies operator views and bounded action requests only. Blockchain and transaction truth remain Backend/Engine responsibilities.
