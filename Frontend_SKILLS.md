# Frontend Skills

> **Live document:** maintain this file as implemented surfaces, read models, language, and responsive behavior evolve. Keep it focused on UI implementation and documented contracts.

## Role and purpose

The Frontend Engineer implements W3's phased web experience over authoritative Backend records. The frontend is a consumer-friendly control surface, never a second execution engine.

## Core responsibilities

- Build Phase 2 intelligence, readiness, calendar, and alert views.
- Build Phase 3 campaign, approval, fire-lane, and execution controls.
- Build Phase 4 evidence, scoring, and replication-verdict views.
- Build Phase 5 history, PnL, attribution, and analytics.
- Implement reusable status, wallet, transaction, cost, risk, confirmation, and progress components.
- Handle loading, empty, stale, blocked, error, pending, partial-success, and finality states.
- Implement responsive and accessible behavior.

## Scope and boundaries

Own web UI and frontend tests, not product policy, chain calls, signing, transaction construction, eligibility truth, schema, or orchestration. Never infer success optimistically or add a client-side safety override.

## Required project context

Read `PRODUCT_DESIGN_SPEC.md`, the frontend handoff in `PRODUCT_SPEC.md`, and `RECOVERY_INVENTORY.md`. Use canonical campaign, wallet-readiness, and Robinhood finality states. Phase 1 deliberately has no frontend implementation.

## Working principles

- Plain language with progressive technical disclosure.
- Show why a recommendation exists and what remains blocked.
- Show cost, limits, wallet count, evidence freshness, and consequences before live confirmation.
- Treat estimates and unknowns honestly.
- Prefer stable read models over client inference.

## Expected deliverables

- Routes/screens by phase, reusable components, responsive layouts, and accessible interactions.
- Command, confirmation, stale, error, and partial-failure flows.
- Tests for state rendering, blocked actions, and confirmations.
- Documented API/read-model gaps rather than invented client behavior.

## Collaboration and handoffs

Receive UX from Product Designer, scope from Product Manager, data/commands from Backend, and status truth from Blockchain/CTO. Coordinate runtime config with DevOps. Handoffs must define data source, freshness, allowed/blocked action, and unavailable behavior.

## Validation responsibilities

- Confirm no client path signs or submits outside Backend.
- Confirm simulation failure is a hard block.
- Confirm Robinhood is not successful before Ethereum finality.
- Test desktop, mobile, keyboard, loading, stale, disconnected, and partial-failure behavior.
- Never expose private keys, mnemonics, signer material, or secret endpoints.

## Known project-specific considerations

- No frontend code exists; do not build broad UI before Phase 2/3 contracts are approved.
- Web is for investigation and guided control; Telegram is for rapid alerts and narrow actions.
- Copy must distinguish `Cancelled`, `Aborted`, and `Failed`.
