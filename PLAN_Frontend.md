# Frontend Engineering Plan

## Mandate

Implement the Product Designer’s phased web experience over authoritative Backend read models. The frontend is a consumer-friendly control surface, never a second execution engine. Do not build functionality ahead of its roadmap phase: Phase 1 is deliberately CLI-only with no web implementation, while Phase 2 includes read-only intelligence, readiness, calendar, alert, and system-status dashboard views. Phase 3 adds controlled operational web actions.

## Delivery gates

1. Phase 1 frontend delivery is contract-only: no routes, components, browser chain access, signing, key access, secret access, or execution UI.
2. Begin Phase 2 implementation only after the proposed `mintbot.read-model/v1` contract, durable source records, canonical states, Backend fixtures, and Lead, Backend, Database, Product, and Blockchain/CTO dependencies are accepted.
3. Phase 2 is read-only. Its dashboard, opportunities, readiness, source-backed upcoming-mint calendar, alerts, health, and run projections use Backend-owned `GET` reads; no client mutation or execution permission is introduced. Phase 3 calendar work means operational campaign scheduling and controls, not moving the Phase 2 calendar read model.
4. Begin Phase 3 campaign, approval, fire-lane, execution, and two-way Telegram controls only after a separately versioned command contract and Backend admission path are accepted.
5. Phase 4 expands opportunity evidence, deterministic signal explanations, and qualified replication views. Phase 5 adds the complete dashboard, history, PnL, attribution, analytics, and learning feedback.

## Application architecture

- Use route-level screens backed by typed clients and Backend-owned server state. Keep UI state (filters, drawers, dialogs, preferences) separate from read-model state and any future execution state. Render each view from one authoritative snapshot; do not join records from different snapshots in the client.
- Backend/store is authoritative for campaign, wallet, transaction, gate, score, eligibility, readiness, spend, and finality state. Never implement blockchain business logic, client-side chain reads, simulation, eligibility, scoring, freshness decisions, or optimistic success.
- Phase 2 uses the accepted `mintbot.read-model/v1` contract and read-only `GET` operations, with server-calculated freshness, provenance, availability, cursor pagination, and conditional refresh. Add streaming only when the Backend contract supports it and measured need justifies it.
- Future mutations are Phase 3+ concerns: keep them narrow, scoped, idempotent, and confirmation-gated. Every action calls an approved Backend transition, never an RPC, signer, wallet provider, or chain endpoint directly.
- Treat IDs, hashes, addresses, block numbers, nonces, quantities, and ETH amounts as opaque wire values. Format canonical base-unit strings with explicit asset/unit/decimal metadata; never use JavaScript numbers for money or infer missing values.

## Route structure

Phase 2 routes are Overview/Home (including Backend-supplied tracked-wallet summaries), Attention, Opportunities and Opportunity Detail (inspect-only), Calendar, Wallet Readiness, Alerts, and redacted System Health, plus read-only Run Detail when the Backend projection is available. Phase 3 adds Campaigns, Campaign Detail, Execution, and Fire Lane controls; Phase 4 adds evidence, signal, and replication investigation; Phase 5 adds complete Overview, tracked-wallet history, Wallet Detail, Analytics, and historical exploration. Navigation must omit unavailable features rather than render empty modules. Mobile prioritizes Overview, Attention, Readiness, and Runs without horizontal scrolling.

## Component system

Implement meaning-bearing primitives from the handoff: `StatusBadge`, `GateResult`, `ConfidenceLabel`, `WalletIdentifier`, `TransactionIdentifier`, `Countdown`, `EvidenceRow`, `RiskFlag`, `ReadinessRow`, `LifecycleStepper`, `SpendSummary`, `FilterBar`, `DataTable`, `EventTimeline`, `ConfirmPanel`, `Toast`, and `SystemHealthStrip`.

Phase 2 exposes only Backend-supplied safe read actions such as `Inspect`, `Refresh read model`, and `Wait for reconciliation`; it never invents a mutation or generic retry. Later command contracts may use scoped verbs such as `Validate again`, `Promote proposal`, `Approve`, `Arm dry run`, `ARM LIVE CAMPAIGN`, `Pause lane`, and `Kill all`. Keep `Approve` distinct from `ARM LIVE CAMPAIGN`, and avoid ambiguous `Continue` or `Submit` for spend-affecting actions.

## Core flows

- Phase 2 home and alerts: answer “What needs my attention?”, “Which opportunity is worth checking?”, and “Which wallets are ready?” with persisted records, source time, freshness, plain-language reasons, and safe inspection actions. A notification is never execution proof.
- Wallet-by-campaign readiness (Phase 2): show per-wallet chain, balance, eligibility evidence, simulation result/age, gas, caps, and exact blocker. Render `Unknown`, `Stale`, `Blocked`, and `Ineligible` distinctly; `Ready` never means guaranteed mint success.
- Read-only run and recovery (Phase 2): show dry-run versus live mode, aggregate and per-wallet results, attempts, receipts, reconciliation, finality history, partial results, and Backend-owned retryability. Distinguish `Prepared`, `Signed`, `Submitted`, `Included`, `Posted to Ethereum`, `Confirmed` where the chain policy permits it, `Ethereum final`, `Replaced`, `Reorged`, `Failed`, `Aborted`, `Cancelled`, and `Unknown` according to the read model.
- Arm and execution controls (Phase 3): use a full-page Backend confirmation review with drop/chain/contract, wallet scope, quantities, cost, gas ceiling, buffer, caps, broadcaster, simulation timestamps, exclusions, consequence copy, kill-switch state, and typed campaign ID. Record and transition through Backend admission; the browser never constructs, signs, or submits a transaction.
- Tracked-wallet and opportunity views (Phase 2, expanded in Phase 4): show Backend-supplied observations, score inputs, positive/negative evidence, confidence, freshness, risk flags, gates, and eligibility. The primary opportunity action is `Inspect`; richer evidence and replicability investigation arrive in Phase 4. Score and evidence may inform a proposal, never a live action or blocked-gate override.
- Analytics (Phase 5): separate realized PnL from floor-marked unrealized estimates and unknown coverage; show sample sizes, denominators, freshness, fees, and source links.

## Visual and responsive requirements

Use the current clear, guided, consumer-friendly direction: plain language first, progressive technical disclosure, semantic text/icon/status pairing, and technical values in a readable secondary treatment. Present costs in ETH and configured ordinary currency as estimates, never guarantees. Preserve attention and safety hierarchy over decorative metrics.

Desktop may use a navigation rail, health strip, sticky tables, keyboard row inspection, and visible run summaries. Tablet collapses navigation and prioritizes attention. Mobile supports attention, readiness, canonical status, failed-wallet review, and quick inspection without horizontal scrolling; Phase 3 control actions remain explicitly gated and mobile does not become an administration surface.

## State and error contracts

Every non-terminal presentation follows `[STATE] - [subject] - [what happens next]` and explains what happened, why it matters, and the next safe action. Use the canonical campaign states `Draft`, `Validating`, `Ready`, `Armed`, `Active`, `Paused`, `Completed`, `Failed`, `Aborted`, and `Cancelled`; wallet states `Unknown`, `Unfunded`, `Funded`, `Eligible`, `Ready`, `Executing`, `Minted`, `Failed`, and `Skipped`; and transaction/finality stages from the accepted read model. `Cancelled` is operator cancellation before active execution, `Aborted` is a safety, kill-switch, or adaptive stop, `Failed` is technical or execution inability, and `Unknown` is unresolved rather than failed or retryable.

Loading preserves final layout. Stale, partial, unavailable, or unknown data remains explicitly labeled and disables freshness-dependent or unsafe actions; missing amounts never become zero. The browser never calls an RPC, chain, sequencer, signer, or wallet provider. For Robinhood, display `Robinhood Chain 4663 · ETH · Direct to sequencer · First-come ordering`; `Included` and `Posted to Ethereum` remain progress milestones, not success, and success is shown only at `Ethereum final`. FREE mint value is zero but execution, data-posting, and priority-fee components remain separate; paid mints remain blocked. Never render secrets, provider credentials, raw error payloads, calldata, signed transactions, or key blobs.

## Tests and done criteria

- Phase 2 component and contract-fixture tests cover canonical labels, gates versus scores, string-safe amounts, provenance/freshness, unknown/stale/blocked data, secret redaction, staged finality, and disabled unsafe actions.
- Phase 2 workflow tests cover attention, opportunity inspection, calendar, wallet readiness, read-only runs, partial responses, reconciliation, and Telegram alert links. Phase 3 tests cover typed live arm, proposal/approval separation, partial execution, kill confirmation, reorg display, and Backend-owned retry gating only after the command contract exists.
- Responsive/accessibility tests cover keyboard focus, text alternatives to color, reduced motion, mobile no-scroll critical flows, and table inspection.
- Frontend is complete only when it reflects persisted Backend state, does not hide partial failures, cannot infer chain truth or permission, and every future live-spend surface presents complete scope and safety totals before a separately authorized Backend transition.

## Challenges and decisions

- Product and design surfaces are phased contracts, not permission to implement Phase 1 UI. Phase 2 dashboard/readiness work is read-only and begins only after the `v1` read-model contract and fixtures are accepted.
- “Approve” must remain distinct from “Arm live campaign”; labels and API mutations must enforce this.
- Score and gate must be separate fields and visual regions. A high score cannot enable promotion/arming through client logic.
- Do not expose “expected profitability” without data coverage; use the PM/CTO economic vocabulary.
- Robinhood compatibility evidence does not enable execution. Paid Robinhood mints remain blocked, and no live-arm action appears while required operational gates are incomplete.

## Dependencies and outputs

Consumes the accepted `mintbot.read-model/v1` envelope, typed Backend read models, lifecycle events, provenance, freshness, redacted health, Backend-owned retryability, snapshots, and canonical IDs. Phase 2 supplies read-only operator views and bounded inspection/refresh affordances; Phase 3+ may supply bounded action requests only through separately accepted Backend command contracts. Blockchain, transaction, eligibility, finality, and permission truth remain Backend/Database/Engine responsibilities.
