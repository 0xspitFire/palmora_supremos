# MintBot Decisions Log

**Document status:** Authoritative append-only architectural and product decision record
**Review date:** 2026-09-28
**Current implementation baseline:** `origin/main@35ef0fd`
**Owner:** Product Owner

## How to Use This Log

This file records decisions that explain why the current system has its shape. It is not a test report, release approval, or substitute for `PROJECT.md`, `PRODUCT_SPEC.md`, `PRODUCT_DESIGN_SPEC.md`, or `OPERATIONS.md`.

Each entry contains:

- **Status:** resolved, conditional, or deferred.
- **Decision:** the choice that contributors must preserve.
- **Rationale:** why the choice was made.
- **Constraints:** behavior that follows from the choice.
- **Evidence:** source documents and implementation references.

Entries are append-only. Corrections or reversals must add a new dated entry; do not rewrite historical decisions. A dated plan, recovered branch, or agent suggestion cannot override a later Product Owner decision without an explicit new entry.

## D-001 — Personal, Single-Operator Product

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** MintBot is a personal, single-operator NFT intelligence and bounded-execution system, not a multi-tenant SaaS, consumer wallet provider, or generic trading bot.
- **Rationale:** The product is intended to optimize selection quality, explainability, controlled preparation, and operator judgment rather than volume or blind speed.
- **Constraints:** No V1 billing, tenancy, role system, shared execution, or multi-user authorization. Friends may receive read-only notifications only. Scores and observed transactions never authorize spending.
- **Evidence:** `PROJECT.md` §§1–3; `PRODUCT_SPEC.md` §§0–2; `Docs/Agent Skills/Product_Manager_SKILLS.md`.

## D-002 — Observe, Evaluate, Prepare, Approve, Execute, Monitor, Learn

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** The product lifecycle is `Observe -> Evaluate -> Prepare -> Approve -> Execute -> Monitor -> Learn`.
- **Rationale:** Observation and scoring must remain separate from eligibility, readiness, authorization, signing, submission, and settlement.
- **Constraints:** A recommendation, score, notification, signature, transaction hash, or inclusion event is not proof of a completed mint. Each boundary must remain inspectable and auditable.
- **Evidence:** `PROJECT.md` §1; `PRODUCT_DESIGN_SPEC.md` §§Design Direction, Core Surfaces.

## D-003 — Strict Responsibility Boundaries

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** Engine, Database, Backend, CLI, and Web are separate authorities.
- **Rationale:** Separation prevents discovery, UI, orchestration, or notification code from becoming an unreviewed spending path.
- **Constraints:** Engine owns chain strategies and signing interfaces; Database owns normalized persistence; Backend owns admission, jobs, readiness, reconciliation and projections; CLI wires controlled operator workflows; Web renders Backend data and never calls RPC or signers.
- **Evidence:** `PROJECT.md` §1; `PRODUCT_SPEC.md` §§4, 14; `Docs/Agent Skills/*_SKILLS.md` role boundaries.

## D-004 — TypeScript, viem, pnpm, Vitest and Anvil

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** Use strict TypeScript, viem, pnpm, Vitest and Anvil in the existing monorepo.
- **Rationale:** The stack is already established and supports typed EVM transaction construction, local fork tests, package boundaries and reproducible CI.
- **Constraints:** Do not introduce a second execution stack or framework merely to solve a local problem. Native WSL is the approved runtime/testing filesystem; Windows paths and `/mnt/c` are not execution locations.
- **Evidence:** `PRODUCT_SPEC.md` §§0, 14; `OPERATIONS.md` §§Configuration, Health; `package.json`; CI workflow.

## D-005 — Ethereum-First Chain Enablement

- **Date:** 2026-08-30, reconciled 2026-09-28
- **Status:** Resolved with conditional chain gates
- **Decision:** Ethereum chain `1` and known SeaDrop-v1 public minting are the first narrow execution target. Robinhood `4663` is characterized but execution-disabled. Base `8453` is defined but unverified, disabled and not currently admitted by Backend.
- **Rationale:** Chain compatibility, characterization, and live permission are separate decisions. Ethereum has the least additional operational uncertainty for the first release path.
- **Constraints:** A chain profile, replay, positive transaction, or mutable flag cannot enable live execution. Each chain requires independent RPC, finality, negative-path, per-wallet, recovery, backup and Product Owner evidence.
- **Evidence:** `packages/engine/src/chains.ts`; `PRODUCT_SPEC.md` FR-CHAIN-001/003; `PROJECT.md` §3; `Docs/Agent Skills/Blockchain_SKILLS.md`.

## D-006 — SeaDrop Strategy Boundary

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** Contract-specific behavior lives behind `MintStrategy`; SeaDrop-v1 public mint is first.
- **Rationale:** Typed strategy boundaries prevent arbitrary calldata, contract-specific branches scattered through the engine, and unsafe fallback behavior.
- **Constraints:** A strategy must read its drop, build calldata, estimate gas, validate arguments and provide fixtures. No generic arbitrary-call executor or guessed calldata path is allowed.
- **Evidence:** `PRODUCT_SPEC.md` FR-STRAT-001/002; `packages/engine/src/strategies/seadrop-v1-public.ts`; `Docs/Agent Skills/Blockchain_SKILLS.md`.

## D-007 — Chain-Narrow, Execution-Deep Processing

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** Support a narrow, explicitly configured chain/contract surface while processing each permitted execution deeply from preparation through final settlement.
- **Rationale:** A small permitted surface makes policy and review tractable; deep processing prevents a hash or notification from being mistaken for a successful mint.
- **Constraints:** Track preparation, simulation, reservation, nonce, attempts, replacements, receipts, canonicality, confirmation depth, reorgs, settlement and recovery as separate facts. Unknown or stale evidence blocks action.
- **Evidence:** `PROJECT.md` §§3, 5; `PRODUCT_SPEC.md` FR-EXEC-001–004; `packages/backend/src/canonical-store.ts` and `packages/engine/src/receipt-watcher.ts`.

## D-008 — No Circumvention Tooling

- **Date:** 2026-08-30, reaffirmed 2026-09-28
- **Status:** Resolved
- **Decision:** MintBot must not bypass third-party restrictions or build circumvention tooling.
- **Rationale:** Multiple wallets and automation are permitted only within the target’s terms and the operator’s approved policy. A faster bypass is not a product advantage.
- **Constraints:** No CAPTCHA/anti-bot bypass, allowlist or signature forgery, Sybil/fake identity, rate-limit/IP evasion, access-control bypass, unauthorized private APIs, or blind wallet-bound calldata/proof replay. Mark inaccessible or non-replicable targets as blocked.
- **Evidence:** `PROJECT.md` §5; `PRODUCT_SPEC.md` risk constraints; `Docs/Agent Skills/Blockchain_SKILLS.md`.

## D-009 — Simulation Is a Hard Gate

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** A failed, stale, unknown or unavailable simulation cannot be overridden by a generic force option.
- **Rationale:** The same calldata can behave differently by wallet, timing, eligibility, fee recipient, quantity or state. A score or another wallet’s success is not safety evidence.
- **Constraints:** Simulate per wallet or use an explicitly justified equivalent class; expose the reason; allow only approved inspect/exclude/rerun flows. Simulation is preparation-time work, not an uncontrolled hot-path retry.
- **Evidence:** `PRODUCT_SPEC.md` §0 and FR-EXEC; `PROJECT.md` §4; `packages/engine/src/mint-engine.ts`; `packages/backend/src/evidence.ts`.

## D-010 — One Guarded Execution Path

- **Date:** 2026-08-30
- **Status:** Resolved
- **Decision:** The approved sequence is `approve -> arm -> run -> summary`; only the gated Execution path may spend.
- **Rationale:** Recommendations, UI actions, Telegram delivery, discovery and orchestrators must not become alternate signing or submission paths.
- **Constraints:** Dry-run is visibly non-spending. Live mode requires a persisted campaign/policy, fresh evidence, reservation, custody health, kill-switch checks and explicit authorization. Phase 2 service/Web/Telegram remain dry-run/read-only.
- **Evidence:** `PRODUCT_SPEC.md` §§4, 7, 8; `PRODUCT_DESIGN_SPEC.md` Phase 2 Scope Lock; `packages/cli/src/index.ts`; `packages/backend/src/application.ts` and `coordinator.ts`.

## D-011 — Canonical Normalized SQLite/WAL Store

- **Date:** 2026-09-17, consolidated 2026-09-28
- **Status:** Resolved
- **Decision:** Normalized SQLite in WAL mode is the canonical local store for wallets metadata, campaigns, jobs, reservations, attempts, receipts, evidence and read models.
- **Rationale:** It provides zero-ops local durability at the project’s scale while retaining atomic admission, recovery and auditable history.
- **Constraints:** JSON/process-local stores are compatibility/test mechanisms only. Backend/Database own schema and repository contracts. GET projections must not refresh or mutate spend summaries. Production path, backup and isolated restore remain separate human gates.
- **Evidence:** `packages/database`; `packages/backend/src/canonical-store.ts`; `OPERATIONS.md`; `PROJECT.md` §1.

## D-012 — Durable Identity, Reservations and Recovery

- **Date:** 2026-08-30, consolidated 2026-09-28
- **Status:** Resolved
- **Decision:** Persist intent before side effects, reservations before signing, every attempt/replacement/receipt/finality fact, and unresolved outcomes for restart reconciliation.
- **Rationale:** A transport timeout cannot prove a transaction was dropped; restart must never silently double-submit or orphan spend.
- **Constraints:** Reservations include componentized exposure and bounded replacement costs. Reconcile by sender/nonce/hash. A kill switch blocks future admission but cannot undo a submitted transaction. Settlement is monotonic and evidence-backed.
- **Evidence:** `PRODUCT_SPEC.md` FR-EXEC-004; `packages/backend/src/canonical-store.ts`; `packages/database/src/phase2.ts`; `Docs/Agent Skills/Database_SKILLS.md`.

## D-013 — Turnkey as Initial Remote Signer

- **Date:** 2026-09-17
- **Status:** Resolved, attestation conditional
- **Decision:** Turnkey is the initial policy-bound remote signing direction. Local encrypted keystores remain controlled-test custody only.
- **Rationale:** Turnkey keeps key material behind a remote signer boundary and supports policy-bound secp256k1 signing at the project’s scale.
- **Constraints:** Verify provider identity, wallet-map/key references, policy digest, decoded transaction target/arguments, fee/value bounds and recovered signer address. Do not expose API or wallet keys. Verifiable Cloud Boot/App Proofs are conditionally waived while access is pending; live custody/rotation evidence remains required.
- **Evidence:** `packages/engine/src/turnkey-signer.ts`; `packages/engine/src/turnkey-import.ts`; `Docs/turnkey-policy-boundary.md`; `Docs/production-health-config.md`.

## D-014 — Phase 2 Read-Only Intelligence Boundary

- **Date:** 2026-09-17
- **Status:** Resolved
- **Decision:** Phase 2 exposes read-only intelligence/readiness/calendar/reminder/status views and outbound-only owner Telegram. It does not approve, arm, run, pause, kill, fund, retry, sign or broadcast.
- **Rationale:** The Intelligence MVP must explain opportunities and readiness without turning a score, refresh, alert or browser into spending authority.
- **Constraints:** `mintbot.read-model/v1` is the authoritative GET contract. Backend/Database own truth. Web consumes projections; it does not call RPC or signer. Telegram delivery is not execution proof. Phase 3 requires a separate mutation contract and authorization.
- **Evidence:** `PRODUCT_DESIGN_SPEC.md` Phase 2 Scope Lock; `Docs/frontend-phase2-read-model-api-contract.md`; `PROJECT.md` §3.

## D-015 — Phase 2 Freshness, Retention and State Vocabulary

- **Date:** 2026-09-17
- **Status:** Resolved
- **Decision:** Initial Phase 2 defaults are one local operator, five-minute readiness freshness, fifteen-minute discovery/calendar freshness, thirty-day read/alert retention and ninety-day audit-event retention. State values `unknown`, `stale`, `blocked`, `partial`, and `unavailable` remain distinct and mutually exclusive.
- **Rationale:** A readable stale or partial answer is safer than a fabricated current recommendation; explicit state lets users understand what needs attention.
- **Constraints:** Read models preserve source time, freshness, provenance, policy version and typed blockers. Missing values are not silently converted to zero, false or success.
- **Evidence:** `PRODUCT_DESIGN_SPEC.md` Phase 2 defaults and status rules; `PROJECT.md` §3; `packages/backend/src/read-model-v1.ts`.

## D-016 — Native WSL and Protected CI

- **Date:** 2026-09-17
- **Status:** Resolved
- **Decision:** Develop/run on native WSL paths with pinned Node `20.19.1`, pnpm `9.15.4`, Foundry/Anvil `1.8.1`; integrate only through protected PRs with required environment, verify, anvil and docker checks.
- **Rationale:** Native WSL permissions and deterministic tooling match the operational target and avoid Windows path/permission ambiguity.
- **Constraints:** Do not use `/mnt/c` as an execution location. Secrets remain host-only. CI evidence is separate from local tests and cannot be bypassed by force push or direct main edits.
- **Evidence:** `OPERATIONS.md`; `.github/workflows/ci.yml`; protected `main` configuration.

## D-017 — Production/Live Readiness Is a Separate Gate

- **Date:** 2026-09-17
- **Status:** Resolved, deferred
- **Decision:** Phase 1 local/controlled development and Phase 2 read-only development may be complete while production/live execution remains NO-GO.
- **Rationale:** Local code/tests, positive characterization and Turnkey health do not prove a durable production host, off-host restore, finality/reconciliation, custody attestation, wallet rotation or safe live spend.
- **Constraints:** Require a least-privilege service identity, canonical production SQLite/WAL, encrypted off-host backup and isolated restore, kill-switch runbook, current finality/reconciliation evidence, signer/rotation evidence, limits and explicit Product Owner authorization before broadcast.
- **Evidence:** `PROJECT.md` §§3–5; `OPERATIONS.md`; `Docs/production-health-config.md`; conditional waiver record.

## D-018 — Historical Documents Do Not Override Current Decisions

- **Date:** 2026-09-28
- **Status:** Resolved
- **Decision:** `PROJECT.md`, current Product Owner decisions and protected merged code/evidence supersede dated plan/review claims. Historical audit/CTO/agent documents remain useful context and must not be erased or treated as current status without verification.
- **Rationale:** Dated plans legitimately describe an earlier scaffold, but repeating “not started,” Windows-primary, KMS-undecided or unintegrated-branch claims after implementation causes regressions and redundant inquiries.
- **Constraints:** Reconcile docs against code, tests and protected history; classify claims as implemented, tested, deferred, waived or open. Never restore historical credentials or stale status language.
- **Evidence:** `PROJECT.md` Authority and interpretation; `ENGINEERING_REVIEW.md`; `Docs/Exec Plans/CTO_Brief.md`; `Docs/Agent Skills/Engineering_Lead_SKILLS.md`.

## Open Questions — Not Decisions

These remain explicit Product Owner/release questions and must not be inferred:

1. Robinhood operational enablement and any paid-mint policy.
2. Production host/service identity, SQLite location, backup provider, retention and isolated restore.
3. Turnkey Verifiable Cloud proof retrieval after waitlist access.
4. Live wallet rotation, funding, spend cap and bounded rehearsal authorization.
5. Funding-graph privacy tradeoff and L1 bundle economics.
6. Phase 3 mutation/authentication contract, Telegram command policy and future recipient access code.
7. Phase 4 qualified-replication inputs and any permitted owner-controlled WL/FCFS source.
8. Phase 5 earned-autonomy threshold, scoring calibration and analytics acceptance.

A new decision must record its owner, date, rationale, constraints and evidence. Until then, the safer existing boundary remains in force.
