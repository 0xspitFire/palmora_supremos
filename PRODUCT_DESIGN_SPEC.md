# Product Design Specification

> Canonical design addendum, Product Owner decisions recorded 2026-08-30.
> This file supersedes conflicting audience, phase, lifecycle, and finality wording in older design drafts.

## Design Direction

This product is a clear, guided NFT intelligence and minting experience for average blockchain consumers. It is initially personal-first, but it must not assume that users understand RPCs, gas formulas, nonces, calldata, sequencers, private orderflow, or blockchain finality.

The core experience is:

```text
Observe -> Evaluate -> Prepare -> Approve -> Execute -> Monitor -> Learn
```

Use plain language in primary screens, alerts, confirmations, and Product Owner decision requests. Show technical evidence progressively under an advanced-details view. Every important state must explain what happened, why it matters, and what the user can do next.

## Product Sequence

| Phase | Product experience |
|---|---|
| 1. Execution Foundation | CLI-only safe execution foundation. This is not the intelligence MVP. |
| 2. Intelligence MVP | Wallet tracking, opportunity discovery, mint calendar, eligibility/readiness, deterministic scoring, consumer-friendly dashboard, and Telegram alerts. |
| 3. Controlled Operations | Campaigns, fire lanes, manual approval, operational web views, execution monitoring, and two-way Telegram controls. |
| 4. Qualified Automation | Opportunity evidence, replication checks, qualified automation, and richer signal explanations. |
| 5. Full Experience | Complete dashboard, tracked-wallet history, analytics, PnL, attribution, and learning feedback. |

Web delivery is therefore incremental. Phase 2 provides intelligence and readiness views, Phase 3 provides operational controls, Phase 4 provides opportunity investigation, and Phase 5 provides the complete dashboard and analytics.

## Audience And Interaction Rules

- Use everyday words such as “network connection,” “estimated network cost,” “waiting for confirmation,” and “not ready.”
- Explain technical terms when they affect a decision. Do not require the user to understand them.
- Present cost in ETH and ordinary currency where configured, with a clear estimate label.
- Separate “what the system knows” from “what it expects.” Never present an estimate as a guarantee.
- Make `Dry run`, `Approval required`, `Live`, and `Blocked` visually distinct.
- A recommendation never authorizes spending. Safety and eligibility gates remain separate from scores.
- Failed simulation is a hard block. Offer `View reason`, `Exclude wallet`, or `Run check again`; do not offer a general force option.
- Use `Cancelled` for user cancellation before active execution, `Aborted` for safety, kill-switch, or adaptive stops, and `Failed` for technical or execution inability.

## Canonical Status Language

Campaigns use:

```text
Draft -> Validating -> Ready -> Armed -> Active -> Completed
                                                   |-> Failed
                                                   |-> Aborted
                                                   |-> Cancelled
```

Wallet readiness uses:

```text
Unknown -> Unfunded -> Funded -> Eligible -> Ready -> Executing -> Minted
                                                               |-> Failed / Skipped
```

Transactions use:

```text
Prepared -> Signed -> Submitted -> Included -> Posted to Ethereum -> Ethereum final
                    |-> Replaced  |-> Reorged |-> Failed
```

`Included` and `Posted to Ethereum` are not success for Robinhood. The product must report success only at `Ethereum final`. Earlier stages remain visible so users understand progress and recovery risk.

## Chain Presentation

Ethereum and Robinhood are the first operational priorities. Base is supported and can be enabled after Ethereum and Robinhood are live and operational.

Robinhood must be displayed as:

```text
Robinhood Chain 4663 · ETH · Direct to sequencer · First-come ordering
```

Do not describe Robinhood with Ethereum mempool, Flashbots, or bundle language. A positive SeaDrop-v1 characterization is evidence only. The interface must separately show whether current execution gates pass.

For a Robinhood free mint:

- Show mint value as zero.
- Show estimated execution cost and data-posting cost separately.
- Show the priority-fee policy component separately.
- Explain that a higher priority fee does not move a transaction ahead in the queue.
- Keep execution blocked until all verification, readiness, simulation, funding, durable-reservation, reconciliation, and finality requirements pass.

Paid Robinhood mints remain blocked until the Product Owner approves a specific value and exposure policy.

## Core Surfaces

### Phase 2 Intelligence Home

Prioritize “What needs my attention?” followed by “Which opportunity looks worth checking?” and “Which wallets are ready?” Do not expose empty future modules as if they work.

### Opportunity View

Show the project, network, opening time, price, confidence, evidence, risks, wallet readiness, and recommended next action. The primary action is `Inspect`, not `Execute`. A score can create a proposal, but cannot bypass a blocked gate.

### Wallet Readiness

Readiness is always tied to a specific mint. Show whether each wallet is funded, eligible, checked, and ready. Explain missing requirements in ordinary language.

### Campaign And Execution View

Show total wallets, ready wallets, estimated cost, limits, current state, and what happens next. Group results by state instead of overwhelming users with a large technical table. When one wallet fails, clearly say that other wallets continued.

### Telegram

Telegram is for alerts, reminders, compact status, and narrowly scoped confirmed actions. It never displays keys or secrets and never treats delivery of an alert as proof of execution. Deep investigation belongs in the web experience.

## Robinhood Blocked State

Use wording such as:

> SeaDrop compatibility was confirmed on Robinhood, but automatic execution is temporarily unavailable because the safety and recovery checks are not complete. No transaction will be sent. We will show the exact check that needs attention.

Do not show an active live-arm action while the gate is blocked.

The current blocker is operational, not compatibility. SeaDrop compatibility and a positive transaction are documented, but the integrated product still needs passing archive replay and negative-path tests, per-wallet simulation, durable spend reservations, sequencer/RPC correlation, duplicate and restart reconciliation, a finality observer that reaches Ethereum finality, and a bounded bot-produced live rehearsal. Until those checks pass together, show the chain as characterized but execution blocked.

## Design Acceptance Rules

- Every user-facing status uses the canonical terms above.
- No screen reports a Robinhood mint as successful before Ethereum finality.
- Every blocked action names the failed check in plain language.
- Every live action shows wallet count, estimated cost, limits, check age, and consequences before confirmation.
- Consumer wording is the default; advanced technical details are optional.
- Phase 2 intelligence surfaces must not imply that the Execution Foundation is the product MVP.
