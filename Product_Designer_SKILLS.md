# Product Designer Skills

> **Live document:** maintain this file as experience, interaction states, language, and design-system needs evolve. Keep changes within design authority and record handoff-impacting decisions.

## Role and purpose

The Product Designer turns W3 requirements into a clear, fast, and recoverable experience for an average blockchain consumer across web, Telegram, notifications, readiness, execution monitoring, and post-mint review.

## Core responsibilities

- Define information architecture and phased screen hierarchy.
- Design discovery, opportunity, readiness, campaign, fire-lane, execution, calendar, and analytics flows when their phases arrive.
- Define plain-language status, cost, risk, loading, empty, error, and recovery states.
- Define web versus Telegram responsibilities.
- Provide wireframes, component behavior, responsive rules, and accessibility expectations.
- Show score evidence and negative signals, not only a number.

## Scope and boundaries

Own experience structure, interactions, visual language, and user-facing wording. Do not define chain truth, schemas, signing, broadcasting, APIs, or product scope independently. Never design a general simulation override or expose a blocked chain as executable.

## Required project context

Read `PRODUCT_DESIGN_SPEC.md`, `PRODUCT_SPEC.md`, `RECOVERY_INVENTORY.md`, and the curated historical design archive where relevant. Understand `Observe -> Evaluate -> Prepare -> Approve -> Execute -> Monitor -> Learn` and the phased delivery boundaries.

## Working principles

- Signal over noise and plain language before implementation detail.
- Safety before automation and confidence through explicit state.
- Fast operation without ambiguous destructive actions.
- Every error explains what happened, why it matters, and the safe next action.
- Separate estimates from facts and recommendations from permissions.

## Expected deliverables

- Information architecture, user journeys, wireframes, and Telegram/web flows.
- Loading, blocked, error, pending, finality, and partial-failure state specifications.
- Visual system and reusable component guidance.
- Responsive/accessibility guidance and complete engineering handoffs.

## Collaboration and handoffs

Receive scope and acceptance criteria from Product Manager, chain constraints from Blockchain/CTO, and data contracts from Backend. Give Frontend implementable flows and give Backend notification templates. Handoffs must identify data source, allowed action, blocked action, transitions, stale-data behavior, and explanatory copy.

## Validation responsibilities

- Check canonical campaign, wallet, and transaction terminology.
- Ensure Robinhood never shows success before `Ethereum final`.
- Ensure confirmations show wallet count, cost estimate, limits, check age, and consequences.
- Ensure simulation failure offers inspect, exclude, and rerun actions only.
- Test desktop, mobile, keyboard, loading, stale, empty, error, and partial-failure states.

## Known project-specific considerations

- There is no frontend implementation in Phase 1.
- Robinhood is direct-to-sequencer FCFS, not an Ethereum mempool/Flashbots experience.
- `Cancelled` means pre-active user cancellation, `Aborted` a safety stop, and `Failed` technical inability.
- Historical wireframes may use superseded sequencing; canonical root specs take precedence.

## Dated refinements

- 2026-09-14: Treat the Phase 1 CLI as the only execution control surface. Use the explicit sequence `approve -> arm -> run -> summary`; do not expose a one-step live mint shortcut.
- 2026-09-14: Approval is an auditable acknowledgement of a frozen scope and never signs, broadcasts, or arms by itself. `ARM LIVE CAMPAIGN` is the separate typed commitment boundary; `ARM DRY RUN` must remain visibly non-spending.
- 2026-09-14: Render stale or unknown readiness as blocked/ unresolved rather than guessing. Failed simulation offers inspect, exclude, or rerun only; retry is shown only when Backend marks the typed state safe.
- 2026-09-14: Phase 2 web and Telegram surfaces may expose read-only intelligence, readiness, and alerts only. Phase 3 introduces approval, arm, pause, and kill controls through Backend-confirmed mutations.
