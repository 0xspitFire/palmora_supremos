# MintBot

MintBot is a personal, single-operator EVM NFT mint intelligence and controlled-execution system. It helps an operator discover public mint opportunities, understand their evidence and risk, verify wallet readiness, prepare a bounded execution, and reconstruct the outcome after submission or failure.

The product optimizes **selection quality and explainability over blind speed**. A score, notification, observed transaction, or successful simulation never authorizes spending by itself.

## Status

Phase 1 local/controlled execution and Phase 2 read-only intelligence foundations are integrated in the protected `main` branch. Production and live execution remain separately gated and are not implied by local tests, fork replays, or working Turnkey health.

Current live boundary:

- Ethereum chain `1` and the approved SeaDrop-v1 public strategy are the first narrow execution target.
- Robinhood chain `4663` is characterized for inspection but live-disabled.
- Base `8453` is defined but unverified, disabled, and not currently admitted by Backend.
- Turnkey is the approved initial remote signer; Verifiable Cloud Boot/App Proofs are conditionally waived while access is pending.
- Phase 2 web and Telegram are read-only/outbound-only. Execution controls are a later, separately approved phase.

## Product Flow

```text
Observe -> Evaluate -> Prepare -> Approve -> Execute -> Monitor -> Learn
```

The system separates:

- Public observations from scored recommendations.
- Eligibility/readiness from desirability scores.
- Dry-run preparation from approval and live execution.
- Signing from broadcasting.
- Inclusion/confirmation from canonical finality.
- Notification delivery from transaction success.

## Architecture

MintBot is a pnpm/TypeScript monorepo with explicit authority boundaries:

| Package | Responsibility |
| --- | --- |
| `@mint-bot/engine` | Chain profiles, SeaDrop strategy, wallet-level simulation, transaction construction, signer boundary, broadcasters, receipts, finality, and recovery facts. |
| `@mint-bot/database` | Normalized SQLite/WAL migrations, durable jobs, reservations, attempts, evidence, recovery queries, and read-model repositories. |
| `@mint-bot/backend` | Admission, orchestration, readiness, reconciliation, canonical state transitions, versioned read models, and notification policy. |
| `@mint-bot/cli` | Wallet setup, dry-run, inspection, health, kill switch, reconciliation, controlled operator workflows, and service launchers. |
| `@mint-bot/web` | Read-only rendering of Backend-owned `mintbot.read-model/v1` projections. It is not a chain, signer, or policy authority. |

The authoritative persistence boundary is normalized SQLite in WAL mode. JSON and process-local stores are compatibility or test mechanisms, not live state authorities.

## Execution Safety

Execution is intentionally narrow and deep:

- Contract-specific behavior is isolated behind `MintStrategy`.
- SeaDrop-v1 public minting is the first strategy.
- Failed, stale, unknown, or unavailable simulation is a hard block.
- Per-wallet simulation, funding, eligibility, fee, quantity, recipient, and cap checks are required before admission.
- Spend reservations are durable and componentized.
- Attempts, replacements, receipts, canonicality, confirmation depth, reorgs, settlement, and recovery are persisted separately.
- Kill-switch checks occur before future admission and do not erase already-submitted facts.
- Phase 2 services are forced into dry-run/read-only mode and reject live job/run mismatches.
- Web and Telegram cannot approve, arm, run, pause, kill, fund, retry, sign, broadcast, or mutate policy in Phase 2.

## Custody

Turnkey is the approved initial policy-bound remote signer. MintBot validates:

- Organization and wallet-map identity.
- Policy and policy-digest binding.
- Chain, destination, calldata, value, quantity, gas, and fee limits.
- Returned signature fields and recovered sender address.

Local encrypted keystores and imported fixtures are for controlled testing. They are not production custody evidence. Private keys, API credentials, mnemonics, credential-bearing URLs, raw calldata, and serialized transactions must not appear in source, UI, read models, logs, backups, or CI artifacts.

## Phase Boundaries

### Phase 1: Execution Foundation

CLI-first, controlled execution foundation:

- Wallet preparation and public metadata.
- SeaDrop strategy and per-wallet simulations.
- Durable reservations and caps.
- Kill switch and admission gates.
- Signing/broadcast boundaries.
- Receipt, replacement, finality, and recovery handling.
- Local Anvil/archive and negative-case evidence.

A Phase 1 local exit is not production approval or a bot-produced mainnet rehearsal.

### Phase 2: Intelligence MVP

Read-only intelligence and operational projections:

- Source-backed opportunities and calendar projections.
- Wallet/campaign readiness.
- Deterministic scores with persisted inputs and policy versions.
- Freshness, provenance, partial/unknown/stale/blocked states.
- Read-only web surfaces.
- One-way owner Telegram alerts with durable delivery state.
- Restart-safe dry-run scheduling and reconciliation.

Component schemas, projections, or injected clients do not by themselves prove a connected discovery-to-score-to-calendar pipeline or deployed read-model API.

### Phase 3: Controlled Operations

A future phase for separately approved mutation contracts:

- Campaign and fire-lane preparation.
- Authenticated approval/arming.
- Operational controls and adaptive stops.
- Execution monitoring and restart-safe live integration.
- Two-way Telegram commands only after explicit security and Product Owner approval.

Phase 3 implementation does not independently authorize live broadcast.

## Development and Operations

Run from the native WSL filesystem with the pinned toolchain:

- Node `20.19.1`.
- pnpm `9.15.4`.
- Foundry/Anvil `1.8.1`.

Common checks:

```bash
pnpm ops:environment
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm ops:secret-boundary
pnpm ops:negative-cases
pnpm ops:recovery-drill
```

Before any live-admission work, run `pnpm ops:health` with host-configured secret, store, kill-switch, signer, backup, reconciliation, and finality references. A failed or unknown health check is unsafe.

Operations use owner-only host secrets, an engaged kill switch during startup/recovery, canonical SQLite/WAL, encrypted off-host backups, isolated restore, and protected PR integration. The current local testing boundary does not claim production host or live-spend readiness.

## Non-Negotiable Rules

- **Chain-narrow execution:** only explicitly verified chain/contract/strategy combinations may progress toward execution; Base and Robinhood remain disabled until their own gates pass.
- **Execution-deep processing:** do not collapse observations, scores, simulations, signatures, submissions, receipts, finality, or reconciliation into one status.
- **No circumvention tooling:** never bypass CAPTCHAs, allowlists, signatures, rate limits, identity controls, access controls, private APIs, or wallet-bound proofs/calldata. If a target cannot be lawfully and safely replicated, mark it blocked or not replicable.
- No shared mnemonic or broad fleet key.
- No raw keys or secrets in Git, logs, browser state, CI, chat, or backups.
- No live transaction without current evidence, durable reservation, custody health, kill-switch clearance, finality policy, and explicit human authorization.

## Source of Truth

Package source, migrations, tests, and protected CI are the implementation truth in this repository.

Product direction, architecture, decisions, specifications, and operating procedures are maintained by the Product Owner in a private documentation set outside this repository. Contributors work from task files and follow `CONTRIBUTING.md`. Historical planning documents remain in Git history and do not override newer Product Owner decisions or current protected code and evidence.
