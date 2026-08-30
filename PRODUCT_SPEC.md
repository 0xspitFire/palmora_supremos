# Product Specification — Personal NFT Intelligence & Minting Platform

> Owner: Founding Lead PM · Version 1.0 · Date 2026-08-24
> Inputs: `Product_Manager_Agent` (vision brief), `NFT_MINT_BOT_CONTEXT_BRIEFING.md` (prior CTO analysis + locked decisions), `Repo_Analyze` (7 repo URLs; 10 repos previously reviewed), live audit of `packages/engine`.
> Audience: specialist engineering agents (blockchain, backend, frontend, design, DevOps).

---

## 0. Reconciliation With Prior Analysis (read first)

### Product Owner Decision Addendum — 2026-08-30

These decisions supersede older wording in this document and in agent instructions:

- The product MVP is intelligence-focused. The current execution-focused work is **Phase 1: Execution Foundation**, which precedes and enables the Intelligence MVP.
- The intended users are mostly average blockchain consumers. Every workflow must use plain language, guided choices, clear cost/risk explanations, and optional advanced detail. Technical knowledge must never be a prerequisite for an ordinary product decision.
- Ethereum and Robinhood are the first operational priorities. Base is a supported chain and may be enabled after Ethereum and Robinhood are live and operational.
- A failed simulation is a hard block. Users may inspect the reason, exclude the affected wallet, or rerun the simulation. There is no general simulation override.
- Campaign outcomes are standardized: `Cancelled` means the user stopped before active execution; `Aborted` means a safety control, kill switch, or adaptive stop ended remaining work; `Failed` means the system could not complete because of a technical or execution outcome.
- Robinhood transaction status is standardized as `Submitted → Included → Posted to Ethereum → Ethereum final`. `Included` and `Posted to Ethereum` are not success. The product reports success only after Ethereum finality and retains earlier stages for visibility and recovery.
- Web delivery is staged: consumer-friendly intelligence and readiness views arrive with the Intelligence MVP in Phase 2; campaign, calendar, and execution controls arrive in Phase 3; opportunity intelligence and evidence views expand in Phase 4; the complete dashboard and analytics arrive in Phase 5.
- Robinhood positive SeaDrop characterization is evidence, not enablement. Execution remains blocked until the release candidate passes archive replay, negative-path tests, per-wallet simulation, durable reservations, sequencer/RPC correlation, restart and duplicate reconciliation, finality observation, and the complete safety and operational gates.

The exact Robinhood blocker is therefore **not chain compatibility**. Compatibility has positive evidence. The blocker is missing integrated operational proof and safe production wiring: the tested durable store is not connected to the live backend path, the runnable CLI can bypass backend admission, the finality observer is not wired, archive fork tests are not passing, and no bot-produced bounded live rehearsal exists.

The vision brief and the prior engagement briefing conflict in four places. Per the brief's instruction, prior analysis is **not treated as authoritative**. Resolutions:

| # | Conflict | Vision brief | Prior briefing | PM resolution |
|---|----------|--------------|----------------|---------------|
| R1 | Target chains | Ethereum + Robinhood | Ethereum + Base (8453) + Robinhood (4663) | **Base is supported, with operational priority on Ethereum and Robinhood.** Base may be enabled after both priority chains are live and operational. |
| R2 | Sequencing | Phase 1 = Intelligence MVP (tracking, dashboard, alerts first) | Phase 1 = headless public-mint execution engine; intelligence deferred | **The MVP remains intelligence-focused.** The execution-first work is the Execution Foundation preceding the MVP. It is required before intelligence-driven spending can be trusted, but it is not itself the product MVP. |
| R3 | Users | "Primarily for my own use" | ≤20 users (owner + friends) | **Build single-operator for V1.** No multi-user auth, roles, or tenancy. Friends receive *read-only* visibility via Telegram alerts at most. Any shared-execution model is explicitly out of scope until post-Phase-2. |
| R4 | Dashboard/Telegram timing | Both in early phases | Both deferred beyond Phase 1 | **Use staged delivery:** the Execution Foundation is CLI-only; the Intelligence MVP includes consumer-friendly dashboard and Telegram alert surfaces; Phase 3 adds operational web controls; Phase 4 adds opportunity intelligence; Phase 5 adds the full dashboard and analytics. |

Locked decisions inherited unchanged from prior analysis (do not re-litigate): TypeScript strict + viem; pnpm monorepo; Vitest + Anvil fork testing as CI gate; SeaDrop-v1-public first strategy behind a `MintStrategy` abstraction; pluggable broadcasters (Flashbots primary on L1, sequencer-direct on L2); envelope-encryption custody now, KMS-backed signing as the target; simulation as a T-minus setup gate, never inline on the hot path; fat `maxFeePerGas` cap competing on priority fee; kill switch + spend caps are P0.

All §7 security constraints from the context briefing remain **hard rules** and are restated verbatim in §16 (Risks).

---

## 1. Executive Summary

We are building a consumer-friendly NFT intelligence and execution system: a small, modular platform that finds high-quality mint opportunities, explains them clearly, validates them before spending, and executes mints across a fleet of wallets safely — prioritizing Ethereum and Robinhood while supporting Base for later enablement.

Core value proposition: **selection over speed**. Anyone can submit transactions fast; the durable edge is knowing *which* mints are worth firing and *never* firing an unvalidated transaction. The system optimizes signal quality > execution speed > automation volume, and it never blindly copies on-chain activity.

Current state: the Execution Foundation is spread across specialist branches and is not yet an integrated release. The Intelligence MVP and consumer-facing product surfaces are not yet implemented. This specification is the canonical source for the revised sequence.

---

## 2. Product Principles

1. **Personal-first.** No user management, billing, orgs, permissions systems, or multi-tenancy unless architecture demands it.
2. **Modular.** Discovery, intelligence, validation, execution, wallets, analytics, notifications, and UI have hard boundaries behind interfaces.
3. **Debuggable.** Straightforward beats clever. Every autonomous action must be explainable after the fact from logs and records.
4. **Safety before automation.** A transaction another wallet executed successfully is not evidence it is safe for us.
5. **Signal before speed.** Execute *good* opportunities quickly; do not execute everything quickly.
6. **Progressive complexity.** Simplest useful version first; sophisticated infrastructure only when demonstrated need exists.
7. **Explicit uncertainty.** Anything unverifiable becomes a named state (`DECISION REQUIRED`, validation failure, risk flag) — never a hidden assumption.
8. **Never lose keys.** Custody is independent per-wallet keys, encrypted at rest, zeroized in memory, with blast-radius containment via burner funding. One leak must never drain more than one burner's budget.
9. **Plain language by default.** Users should understand status, cost, risk, and the next safe action without knowing implementation terminology. Advanced technical evidence is available progressively, never required for ordinary decisions.

---

## 3. User Stories

Single operator persona: **the operator** (owner; sole actor with execution authority).

Execution wave (current focus):

1. As the operator, I want to point the bot at a public SeaDrop drop (by address or OpenSea slug/URL) and have my prepared wallets fire the moment it opens, so I don't have to hand-fire 10 transactions myself.
2. As the operator, I want a mandatory dry-run/arm step between configuration and any spend, so nothing fires accidentally.
3. As the operator, I want per-mint and daily ETH spend caps with automatic abort, so a bug can never drain more than the budget I chose.
4. As the operator, I want a global kill switch (file-based, checkable mid-flight), so I can halt everything from my phone via SSH/Terminal in one action.
5. As the operator, I want preflight proof that every wallet is funded, eligible, and simulated-OK *before* T-0, so failures happen before gas is spent.
6. As the operator, I want per-wallet success/failure isolation, so one bad nonce doesn't take down the fleet.
7. As the operator, I want a structured record of every submission, receipt, and failure with latencies, so I can debug and improve gas strategy.

Monitoring & intelligence wave:

8. As the operator, I want to register tracked wallets and see their historical mint performance, so I know whose activity deserves attention.
9. As the operator, I want to be notified when tracked wallets converge on a new public mint, so I learn about drops before they're widely known.
10. As the operator, I want a mint calendar that scans my wallets against upcoming campaigns and tells me which ones I'm eligible for, so I never forget a mint.
11. As the operator, I want each opportunity scored 0–100 with visible inputs and risk flags, so I decide with information instead of vibes.
12. As the operator, I want Telegram alerts for execution starts/results and eligibility deadlines, so I can operate from anywhere.
13. As the operator, I want post-mint PnL per campaign, wallet, and signal source, so I learn which signals deserve trust.
14. As the operator, I want observed qualifying mint transactions decoded into an explicit replication plan (or an explicit "cannot replicate" verdict with reason), so replication is never blind calldata copying.

---

## 4. Product Modules

| Module | Responsibility | State |
|--------|----------------|-------|
| **Engine** (`@mint-bot/engine`) | Strategy-based drop reading + calldata building + validation + gas estimation; fleet execution; broadcasting; nonce mgmt; receipts; custody; safety (kill switch, spend caps); logging | **Built**, untested against fork |
| **CLI** (`@mint-bot/cli`) | Execution Foundation and maintenance entry point; guided consumer workflows are delivered through the Intelligence MVP and later web/Telegram surfaces | Partial |
| **Orchestrator** (new, backend) | Long-running process: scheduling (T-minus timers), job queue, persistence, notification dispatch, kill-switch enforcement across processes | Not started |
| **Store** (new) | Durable state: wallets metadata (never raw keys), campaigns, jobs, transactions, events, scores, analytics facts. Default candidate: SQLite (single-file, zero-ops) — **not mandated**, see DECISION REQUIRED | Not started |
| **Discovery** (new, Phase 2) | Watchers over tracked wallets, new contracts, mint events; produces candidate Opportunities | Not started |
| **Intelligence / Scoring** (new, Phase 2) | Deterministic signal scoring (§12), tracked-wallet stats, risk flags | Not started |
| **Calendar & Eligibility** (new, Phase 2) | Upcoming-mint registry; periodic wallet-vs-campaign eligibility scan | Not started |
| **Notifications** (new, Phase 2) | Pluggable channel abstraction; Telegram first | Not started |
| **Analytics** (new, Phase 5) | FIFO lot PnL, win/hit rates, attribution by wallet/project/gas-strategy/signal-source | Not started |
| **Dashboard** (new, phased) | Phase 2 consumer-friendly intelligence/readiness views; Phase 3 operational controls; Phase 5 complete dashboard | Not started |

Boundary rules: Engine knows nothing about Telegram, dashboards, or databases. Orchestrator may not sign anything itself — signing only via the Signer interface. Discovery may never submit transactions; it only emits Opportunities. Only the Execution path spends money, and only through Safety gates.

---

## 5. Core Workflows

**W1 — Configure & arm a public mint (exists partially, completes in Phase 1–3)**

```
resolve target (address/slug) → read drop on-chain (strategy) →
validate drop (timing, supply, price bounds) → select wallets →
preflight funding (price×qty + gasLimit×maxFee per wallet) →
T-minus simulation gate (eth_call per wallet class) →
prewarm connections → ARM (operator approval + spend caps registered) →
wait for T-0 (chain-time) → fire fleet (per-wallet isolated) →
broadcast (chain-appropriate path) → watch receipts → record outcomes →
zeroize keys → report
```

Steps through ARM are repeatable and cheap; steps after T-0 are hot-path and irreversible. Everything that can fail must fail before T-0.

**W2 — Discover opportunity (Phase 2 Intelligence MVP)**

```
watcher observes event (tracked-wallet mint / new contract / phase change) →
dedupe → create Opportunity(discovered) → gather evidence (wallets involved,
contract checks, drop reads) → score (deterministic model) →
score ≥ notify threshold → notify operator (Telegram + feed) →
operator approves → promotes to Campaign (enters W1 at validate)
```

**W3 — Qualify & replicate an observed transaction (Phase 4, gated)**

```
observe candidate tx from tracked wallet → decode (selector + args) →
match against known MintStrategy → produce ReplicationPlan with per-field
provenance → run replicability checklist (§8 FR-SIGNAL group):
wallet-specific params? signatures? merkle proofs? msg.sender-dependent logic?
→ PASS: simulate our reconstructed calldata → promote to Campaign
→ FAIL: mark Opportunity.not_replicable(reason) — explicit state, never silent
```

**W4 — Calendar & eligibility sweep (Phase 2 Intelligence MVP)**

```
registry of upcoming mints → periodic scan: for each upcoming campaign ×
each wallet → check eligibility (allowlist status where readable, balance,
phase limits) → emit readiness matrix → notify: "you are eligible for X,
opens in 6h, 3/10 wallets ready"
```

**W5 — Track outcome & evaluate (Phase 5)**

```
receipt confirmed → record Execution → open PortfolioPosition (FIFO lot) →
poll floor periodically → compute unrealized PnL → on transfer/sale, realize lot →
aggregate: per wallet / campaign / signal-source → feed back into scoring weights
```

---

## 6. MVP Scope

MVP thesis: the product MVP is **an intelligence and readiness experience for average blockchain consumers**. It answers which opportunities deserve attention, which wallets are eligible and ready, and what the user should do next. The trustworthy execution engine operated via CLI is the Execution Foundation that precedes this MVP and must be proven before it can safely power intelligence-driven actions.

### Must Have (MVP exit criteria)

- Engine hardened by Anvil mainnet-fork integration tests (fork at a live SeaDrop drop, warp time, assert fleet mints) running in CI.
- CLI: `wallet generate/list/fund`, `mint run` (with `--dry-run` default-on), `health`, `kill`.
- Dry-run mode that exercises the entire pipeline minus signing/submission.
- Global kill switch (file + programmatic) enforced at every spend checkpoint.
- Per-mint and daily cumulative spend caps with auto-abort (exists in `safety.ts`; wire into CLI + tests).
- Encrypted-at-rest custody with independent keys, in-memory signing, explicit zeroize (exists; add leak-regression tests).
- Preflight funding check + setup-time simulation gate (exists; make failures actionable in CLI output).
- Structured JSON logs sufficient to reconstruct any run end-to-end.
- README-level ops runbook: how to arm, how to abort, how to rotate keys.

### Should Have (immediately after MVP)

- Calibrated timing: chain-time + NTP offset tracking replacing local clock assumptions.
- Connection prewarming loop (tuned keep-alive dispatcher, periodic re-warm to T-0).
- Minimal Telegram notifier: execution started / succeeded / failed / aborted, kill-switch confirmation.
- Post-run summary artifact (per-wallet results, latencies, gas spent).
- Robinhood characterization is documented, but enablement remains gated by integrated operational proof.

### Later

- Campaign/fire-lane model, calendar + eligibility sweeps, opportunity feed, deterministic scoring v1, whale tracker stats, dashboard, OpenSea private-API calldata path (WL/FCFS own-wallet mints), copy-mint replication, EIP-7702 sponsored fleets (requires audit), analytics feedback loop.

### Explicitly Out of Scope (standing)

- Multi-user auth/roles/tenancy/billing.
- ML-based scoring in V1.
- Blind transaction copying without a passed replication checklist.
- Non-EVM chains.
- Public SaaS packaging of any kind.
- Custody via shared mnemonic; vanity-address generation for value-bearing wallets.
- Use of the flagged compromised Helius keys or `SponsoredMintExecutor.sol` without audit.

---

## 7. Phased Roadmap

Resequenced from both documents to match reality (engine exists) and dependency truth (intelligence needs an operating system to learn from).

### Phase 0 — Discovery ✅ (complete)

Repo due diligence (10 repos, adopt/build/rebuild verdicts), chain research (Ethereum, Base, and Robinhood characterized at the evidence level), stack locked, architecture decided. Output: context briefing + this spec's reconciliation.

### Phase 1 — Execution Foundation (before the Intelligence MVP) ← current

- Fork-test harness (Anvil mainnet fork; warp-to-start; assert fleet mints; revert-path coverage) as CI gate.
- CLI completion (`wallet generate/fund/list`, `mint --dry-run`, `mint run`, `health`, `kill`).
- Safety wiring end-to-end: kill switch honored mid-flight; spend caps abort; dry-run default.
- Timing calibration + connection prewarming rewrite (adopt concept from repo A; implement correctly).
- Leak-regression tests for custody (keys never logged, never serialized, zeroized).
- Small-value mainnet live-fire dress rehearsal.
- **Exit when:** acceptance criteria §17-P1 pass.

### Phase 2 — Intelligence MVP (after the Execution Foundation)

- Orchestrator process: persistent scheduled jobs (T-minus timers survive restart), job queue, restart recovery (crash between submit and receipt must reconcile on boot).
- SQLite-class store: wallets-metadata, campaigns-as-jobs (v1 schema keeps Campaign thin), executions, events, spend ledger.
- Telegram notifier and consumer-friendly dashboard surfaces for discovery, readiness, and reminders.
- Runbook-grade observability: run IDs, latency histograms per endpoint, alerting on error-rate anomalies.
- Intelligence MVP exit does not enable Robinhood. Robinhood remains blocked until its separate operational release gates pass.
- **Depends on:** P1. **Exit when:** a scheduled mint runs unattended, survives a mid-flight process restart, and reports via Telegram.

### Phase 3 — Validation, Preparation & Controlled Operations

- Campaign model formalized (grouping wallets × drop × policy); manual arm/approve workflow in plain language.
- Fire lanes: pre-assembled, prewarmed, pre-signed-ready wallet groups; per-lane status; adaptive stop conditions (sold out, price change, cap hit).
- Gas strategy profiles (fat-cap/priority-compete default; replacement bump ladder).
- Calendar + eligibility sweeps (own-wallet allowlist checks where on-chain readable); readiness matrix; deadline notifications; first operational web views.
- Two-way Telegram commands (view, approve, pause, kill).
- **Depends on:** P2. **Exit when:** operator arms an FCFS-style public mint from Telegram and gets per-wallet results without touching a terminal.

### Phase 4 — Qualified Automation & Opportunity Intelligence

- Tracked-wallet registry + stats pipeline (mint frequency, success rate, recency).
- Discovery watchers (tracked wallets first; trending/new contracts second).
- Deterministic scoring v1 (§12) with persisted score inputs; opportunity feed and evidence explanations.
- Qualified-replication pipeline (W3) with explicit non-replicable states; SeaDrop-public first.
- Optional: OpenSea private-API per-wallet calldata path for own-WL/FCFS mints — behind a feature flag and fragility budget.
- **Depends on:** P3. **Exit when:** ≥80% of operator-fired campaigns originate from system-discovered opportunities, and zero unvalidated replications have executed.

### Phase 5 — Intelligence Feedback Loop & Full Experience

- FIFO lot PnL, win/hit rate, attribution by signal source/wallet/gas strategy/project.
- Scoring weight calibration from realized outcomes (still deterministic; revisit ML only if volume justifies).
- Full dashboard (overview, feed, wallets, whale tracker, campaigns, execution) and historical exploration.
- **Depends on:** P4 + accumulated outcome data.

---

## 8. Functional Requirements

IDs grouped by domain. `[P#]` = earliest phase.

### Chains & Strategies

- **FR-CHAIN-001** [P1]: System supports chain profiles for Ethereum (1), Base (8453), and Robinhood (4663). Ethereum and Robinhood are the initial operational priorities; Base is supported and may be enabled after both priority chains are live and operational.
- **FR-CHAIN-002** [P1]: Broadcast routing is chain-aware: L1 defaults to private orderflow (bundle) with blast fallback; L2 defaults to sequencer-direct with blast fallback. Override per run.
- **FR-CHAIN-003** [P1]: Robinhood inclusion is gated on written characterization plus operational proof covering sequencer endpoints, no-public-mempool behavior, absence of Flashbots-style bundles, gas model, EIP-1559 semantics, SeaDrop-v1 compatibility, per-wallet simulation, durable reservations, sequencer/RPC correlation, recovery, and Ethereum finality. Positive characterization alone never enables execution.
- **FR-STRAT-001** [P1]: All contract-specific logic lives behind `MintStrategy` (readDrop / buildCalldata / estimateGas / validateDrop). The engine contains zero contract-specific branching.
- **FR-STRAT-002** [P1]: `SeaDropV1PublicStrategy` builds byte-identical `mintPublic(nftContract, feeRecipient, address(0), quantity)` calldata with fee recipient resolved from `getAllowedFeeRecipients` (fallback: OpenSea fee collector `0x0000a26b…Aa719`).
- **FR-STRAT-003** [P2]: `RawCalldataStrategy`: operator supplies exact calldata + value; system validates selector sanity, decodes for display, simulates — but applies extra warnings (no semantic guarantees).
- **FR-STRAT-004** [P4]: Additional strategies (Manifold, thirdweb, custom) slot in without engine changes; each ships with its own fork-test fixtures.

### Wallets & Custody

- **FR-WALLET-001** [P1]: Generate independent OS-RNG private keys; no mnemonic derivation; keys encrypted at rest (AES-256-GCM, scrypt-derived KEK), decrypted only in memory, explicit `zeroize()` on completion/error.
- **FR-WALLET-002** [P1]: Bulk import of existing keys via encrypted archive import (never plaintext files left on disk).
- **FR-WALLET-003** [P1]: Wallet list shows address, label, group, per-chain balances, last-audited timestamp. Raw key material is never displayable after creation.
- **FR-WALLET-004** [P2]: Auto-fund from designated hub wallet with configurable amount; funding tx recorded; underfunded wallets flagged against a specific upcoming campaign's requirement (price×qty + gas ceiling + buffer).
- **FR-WALLET-005** [P3]: Wallet groups + campaign assignment; readiness computed per (wallet, campaign).
- **FR-CUSTODY-001** [P1]: Signing occurs only through the `Signer` interface; the engine never touches key bytes. A future KMS implementation (`sign(walletId, hash)` remotely) must drop in without engine changes.
- **FR-CUSTODY-002** [P1]: Any code path that could serialize, log, or transmit key material fails tests (leak regression suite).

### Validation & Simulation

- **FR-VALID-001** [P1]: Pre-flight gates before any submission: chain correctness, contract deployed, drop active window, price within configured bound, supply remaining, per-wallet limit respected, wallet funded (cost + gas ceiling + buffer), recipient valid.
- **FR-VALID-002** [P1]: Each gate failure yields a typed, named error (taxonomy in `MintError`) — no generic strings surfaced to operators.
- **FR-SIM-001** [P1]: Setup-time simulation (`eth_call` at latest state, repeated at T-minus checkpoints) per wallet or justified wallet class. Simulation failure blocks the affected wallet or campaign. There is no general override. The user may inspect the reason, exclude the affected wallet, or rerun simulation; only a separately approved future exception may change this rule.
- **FR-SIM-002** [P1→P4]: No inline simulation on the hot path. At T-0 the only network calls are signing-local operations and submission.

### Execution

- **FR-EXEC-001** [P1]: Fleet execution isolates failures per wallet (one wallet's nonce/error never blocks others); results aggregated per run.
- **FR-EXEC-002** [P1]: Fees: generous `maxFeePerGas` cap set at prep; competition via `maxPriorityFeePerGas`; no base-fee refresh at fire; configurable replacement-bump ladder for stuck txs (same-nonce replacement).
- **FR-EXEC-003** [P1]: Confirmation policy per chain profile. Ethereum uses confirmed settlement after its configured block policy. Robinhood uses `Submitted → Included → Posted to Ethereum → Ethereum final`; `Included` and `Posted to Ethereum` are not success, and the product reports success only at Ethereum finality. Reorg detection downgrades state and reconciles accounting.
- **FR-EXEC-004** [P2]: Crash recovery: on boot, reconcile all in-flight submissions (pending? mined? dropped?) before accepting new work.
- **FR-FIRE-001** [P3]: Fire lane = named group of wallets prepared together (funded, simulated, prewarmed) for one campaign; lane states: assembling → warmed → armed → firing → settled/aborted; lanes report aggregate progress.
- **FR-FIRE-002** [P3]: Adaptive stop: lane aborts remaining wallets when sold-out, price change, per-wallet cap reached, or spend cap breached mid-flight.

### Discovery & Signals

- **FR-DISC-001** [P2]: Track arbitrary wallet addresses per chain; ingest their mint-related transactions (transfer/mint events, known-selector calls) in near-real-time.
- **FR-DISC-002** [P2]: Detect: new NFT contracts with active/public drops, mint-phase changes, tracked-wallet convergence (≥N distinct tracked wallets, same contract, within window W).
- **FR-DISC-003** [P2]: Every observation becomes a deduplicated Opportunity entity with evidence attached (never a bare alert).
- **FR-SIGNAL-001** [P2]: Deterministic scoring per §12; every score persists its inputs and model version.
- **FR-SIGNAL-002** [P4]: Replication checklist (explicit states): `replicable` / `needs_per_wallet_params` (merkle proof, signature, wallet-bound arg) / `msg_sender_dependent` / `nonce_dependent` / `not_replicable(reason)`. Only `replicable` + simulated-OK opportunities may become executable campaigns, and even then only with user approval until Phase 5 confidence is earned.

### Calendar, Notifications, Analytics

- **FR-CAL-001** [P2]: Mint calendar entries carry project, contract, chain, times, phases, price, supply, allowlist requirements, method, FCFS/public status, expected gas.
- **FR-CAL-002** [P2]: Periodic sweep computes (wallet × upcoming campaign) eligibility/readiness matrix; surfaces "eligible and not yet minted" items prominently.
- **FR-NOTIF-001** [P2]: Channel abstraction; Telegram first. Event catalog: execution started/succeeded/failed/aborted, kill-switch engaged, spend-cap threshold crossed, wallet underfunded for armed campaign, mint opening soon, eligibility found, high-score opportunity.
- **FR-NOTIF-002** [P3]: Telegram command surface: view readiness, view/run status, approve, pause, kill. Execution-approving commands require explicit confirm step and plain-language consequence summary.
- **FR-ANLYT-001** [P5]: FIFO lot positions per acquisition; floor polling; unrealized/realized PnL; aggregates by wallet, campaign, project, signal source, gas strategy.
- **FR-ANLYT-002** [P5]: False-positive ledger: opportunities scored ≥notify threshold that would have lost money — feeds scoring calibration.

### Safety, Config, Observability

- **FR-SAFETY-001** [P1]: Global kill switch, file-based (`killswitch` sentinel) and programmatic, checked at every spend checkpoint including between individual wallet submissions.
- **FR-SAFETY-002** [P1]: Per-mint and rolling-daily spend caps in native-token terms; breaching aborts remaining work and notifies.
- **FR-SAFETY-003** [P1]: Dry-run mode executes everything except signing/broadcast; CLI default is dry-run; live mode requires explicit flag.
- **FR-CFG-001** [P1]: All knobs (endpoints, fees, caps, concurrency, thresholds) in versioned config; secrets never in config files.
- **FR-OBS-001** [P1]: Structured JSON logs with run IDs, per-stage latencies, endpoint attribution; reconstructable timeline for any execution.
- **FR-OBS-002** [P2]: Metrics: submission→inclusion latency per chain/path, error rates per endpoint, queue depths.

---

## 9. Non-Functional Requirements

Deliberately modest for a single-operator tool.

- **Reliability:** Engine survives RPC endpoint loss (blast across endpoints, health-probe fallback). Orchestrator crash loses no in-flight-submission knowledge (reconciliation on boot). Target: no unrecoverable state short of disk loss.
- **Latency:** Hot path (T-0 → all wallets submitted) target <500ms on L2 sequencer-direct; L1 targets inclusion within 1–2 blocks via bundles, which is a gas/orderflow problem more than a client-latency problem. These are targets, not SLAs; measure and tune.
- **Security:** See §16 hard rules. Threat model: host compromise, config leak, phishing drops, malicious contracts. Blast-radius containment: burners hold only mint budgets.
- **Observability:** Every autonomous spend is explainable post-hoc from persisted records alone. No blind spots between submit and confirm.
- **Maintainability:** Monorepo, strict TS, no `any` escapes into domain types, strategies/broadcasters behind interfaces, unit + fork tests gate merges.
- **Scalability:** Personal scale only: ≤~50 wallets, ≤~10 concurrent executions, thousands of rows/day. Any design that can't do this on a laptop + small VPS is over-engineered.
- **Recovery:** Kill switch is the universal recovery primitive; spend caps bound worst-case damage between operator attention intervals.
- **Data retention:** Executions, scores, and PnL retained indefinitely (small); raw mempool/watcher noise pruned after 30 days.

---

## 10. Domain Model

Entities and key relations (storage-agnostic):

- **ChainProfile** — id, name, blockTime, confirmationDepth, endpoints, sequencer?, relay?, isL2, verification status.
- **Wallet** — address, label, groupId, keyRef (pointer to encrypted blob/KMS alias — never key material), createdAt. Per-chain derived: balances, nonce state (runtime).
- **WalletGroup** — name, default policies (concurrency, funding source ref).
- **TrackedWallet** — external address under surveillance; aggregates into **WalletStats** (mint frequency, success rate, avg timing, recency, reliability sample size).
- **Contract** — address, chainId, verified?, deployment age, strategy hints.
- **Collection** — contract + metadata (name, supply, floor source).
- **Drop** — strategy name, schedule (start/end), price, per-wallet limit, supply, fee recipient; snapshot-able.
- **Campaign** — operator intent unit: target (drop), wallet selection/group, quantity, gas strategy, spend policy, schedule (at/open-trigger), priority tier (normal / FCFS-high / snipe / replication-triggered), state (§11).
- **FireLane** — prepared subset of campaign wallets sharing warm connections and preflight state; belongs to one Campaign.
- **Opportunity** — discovered candidate: evidence refs, score snapshot, risk flags, replicability verdict, disposition (new/evaluating/notified/approved/rejected/expired/promoted).
- **Signal** — atomic evidence item contributing to a score (wallet acted, convergence count, contract fact, market fact) with source + timestamp.
- **Eligibility** — (wallet, campaign) → {unknown | ineligible(reason) | eligible | ready} + proofs cached where applicable.
- **Transaction** — signed intent: from, to, value, calldata ref, nonce, fees, broadcast attempts[].
- **Execution** — lifecycle record of one wallet's attempt: tx hashes, submission latencies, receipts, replacements[], final state, gas spent, errors.
- **GasStrategy** — named profile: maxFee cap, priority fee rule, bump ladder, broadcaster preference.
- **SpendPolicy** — per-mint cap, daily cap, buffer rules; referenced by Campaign, enforced by Safety.
- **PortfolioPosition** — FIFO lots from acquisitions; marks to collection floor; realizes on transfer.
- **PerformanceMetric** — computed aggregates over Executions/Positions/Campaigns (win rate, hit rate, PnL, ROI) keyed by wallet/campaign/project/signal-source dimensions.
- **Notification** — channel, event type, payload ref, delivery state.

Invariants: a Campaign references exactly one Drop target; an Execution belongs to exactly one Campaign and one Wallet; key material never enters this model (only keyRefs); every monetary movement ties to an Execution or a recorded funding tx.

---

## 11. State Machines

**Campaign**
`draft → validating → ready → armed → active → completed | failed | aborted | cancelled`
plus `armed → paused → armed` and `active → aborted (safety)` .
Guards: validating→ready requires ALL validation gates green; ready→armed requires operator approval + SpendPolicy registered; armed→active fires at trigger (time/observed event); operator cancellation before active is `cancelled`; kill switch, safety controls, or adaptive stop produce `aborted`; technical inability to complete produces `failed`.

**Wallet-in-Campaign readiness** (per wallet, per campaign)
`unknown → unfunded → funded → eligible → ready → executing → minted | failed | skipped`
Guards: funded requires balance ≥ cost+gas+buffer; ready requires simulation pass; skipped is terminal-with-reason (ineligible, cap, sold out, lane aborted).

**Transaction/Execution**
`prepared → signed → submitted → included → posted_to_ethereum → ethereum_final | reorged | replaced | failed(dropped)`
`submitted → replaced` via same-nonce bump (bounded ladder); `reorged → resubmitted(submitted)` with accounting reconciliation; `failed` carries typed error taxonomy. Robinhood `included` and `posted_to_ethereum` are retained operational states, never final success. Terminal states are immutable audit records.

**Opportunity**
`discovered → evaluating → scored → notified → approved → promoted | rejected | expired`
Only `promoted` creates a Campaign (which then runs its own machine). `expired` when stale beyond freshness window.

---

## 12. Signal Scoring (V1 — Deterministic)

Model version string `v1-rules`; weights in config, every score persisted with inputs (Phase 5 recalibrates from data).

**Inputs and weights (0–100 total):**

| Factor | Max pts | Source |
|---|---|---|
| Track-record of participating tracked wallets (success-rate × recency-decay × sample-size confidence) | 25 | WalletStats |
| Convergence: distinct high-quality wallets on same contract within window | 20 | Discovery |
| Economics: price vs budget band, est. gas vs price ratio, margin vs floor where floor known | 20 | Drop + market |
| Contract/drop hygiene: verified source, known strategy pattern (SeaDrop v1), contract age, deployer history | 15 | Contract facts |
| Demand: supply remaining, mint velocity, phase scarcity | 10 | Drop + watcher |
| Freshness: full points if <15min since discovery, linear decay to 0 at 6h | 10 | Clock |

**Risk penalties (subtract, floor 0):** unverified contract −30; deployer associated with prior scams −50; price > budget band −100 (i.e., block); simulation failure −100 (block); chain unverified −100 (block); spend-cap breach −100 (block); OpenSea-API-dependent data older than 10 min −10.

**Thresholds:** `score ≥ 70` → auto-promotable to *proposal* (still operator-approved until Phase 5 earned-autonomy policy changes this); `40–69` → notify-only; `<40` → log-only. Confidence = min(1, sample_size/N₀) reported alongside score; low-confidence high-scores downgrade one band.

**Blocking rule:** certain states override score entirely — simulation failure, unverified chain, cap breach, failed replication checklist, kill switch. Score informs *desire*; gates enforce *permission*. No ML in V1; revisit only if Phase 5 data volume justifies.

---

## 13. Repository Assessment

Consolidates the earlier 10-repo diligence (briefing §4) with the 7 URLs in `Repo_Analyze`.

| Repository | Purpose | Relevant Components | Reuse | Risks | Recommendation |
|---|---|---|---|---|---|
| `solotop999/opensea-nft-public-mint` | Speed-focused public-mint sniper (TS/ethers v6) | SeaDrop calldata w/ `minterIfNotPayer=0`; `prepareBlast` precompute; `planRpcs` probing; chains incl. Base+Robinhood sequencers; slug resolver | Concepts adopted; ported to viem in engine | Public-only; naive warming/timing; interactive key pasting | **Harvest complete.** Reference only going forward. |
| `zunmax/osnm-z` | Rigorous Rust multi-mode mint bot | Custody discipline (Zeroizing, leak tests), chain-time timing, fee/replacement math, JoinSet concurrency, Multicall funding w/ bytecode verify, EIP-7702 sponsor executor | Adopt patterns (custody tests, timing, bumps); 7702 deferred to audited future | Single-RPC broadcast; no pre-send sim; stale fees; UNAUDITED sponsor contract; 0o600 no-op on Windows | **Adopt concepts; never ship its Solidity un-audited.** |
| `morsyxbt/nft-public-mint` | Upstream of solotop999 | Same lineage | — | Same as solotop999, older | **Discard (superseded).** |
| `singledavinci/ultra-dads-mint-command-bot` | Telegram-commanded mint bot | UX ideas only | — | Single-MNEMONIC custody = top liability class | **Do not adopt custody.** Mine UX patterns at most. |
| `singledavinci/ultra-dads-copy-mint-bot` | Copy-mint variant | Copy-mint flow sketch | Reference for Phase 4 replication UX | Same mnemonic liability; blind-copy design violates our principles | **Reference only.** |
| `singledavinci/solana-pnl-tracker` | Solana PnL dashboard | `calcStats` FIFO logic worth porting | Port algorithm to EVM in Phase 5 | **5 hardcoded live Helius keys + browser-side key leak (compromised; see §16)**; Solana-specific otherwise | **Port calcStats; touch nothing else.** |
| `singledavinci/stale-free-mint-scanner` | Free-mint scanner | Discovery heuristics | Marginal | Low quality | **Discard; revisit concept in Phase 4.** |
| `superbot-dashboard` | Bot dashboard scaffolding | Dashboard IA reference | Reference | — | **Discard; design fresh in Phase 5.** |
| `baby-gpt-final` | Scaffolding | — | — | — | **Discard.** |
| `singledavinci/vanity-address-generator` | Vanity keys | — | — | Same risk class as backdoored `profanity` (~$160M Wintermute loss) | **Forbidden for value-bearing wallets.** |

Net: no fork candidates. All harvesting is done; remaining repo work is conceptual (patterns), not code transport.

---

## 14. Agent Handoff

Each specialist receives this spec + the canonical `PRODUCT_DESIGN_SPEC.md` + the context briefing + access to `packages/engine`. Product Owner decisions recorded in the addendum at §0 supersede older wording in local agent briefs and generated artifacts. Boundaries below; detailed technical choices inside your lane are yours unless locked (§0).

**Blockchain Engineer**
- Execute and write up the Robinhood (4663) operational verification work (FR-CHAIN-003): sequencer endpoints, no-public-mempool behavior, absence of Flashbots-style routing, gas/EIP-1559 behavior, live SeaDrop-v1 compatibility, finality, and 7702 status.
- Build Anvil mainnet-fork harness + scenarios (happy path, revert path, sold-out, price drift, reorg) — the CI gate for P1.
- Own `MintStrategy` extensions beyond SeaDrop-public (RawCalldata P2; Manifold/thirdweb P4) with per-strategy fork fixtures.
- Design KMS/envelope-encryption evolution of `Signer` (interface-compatible; `sign(walletId, hash)` remote path) and the key-leak regression suite.
- Validate confirmation-depth defaults against observed reorg data per chain.

**Backend Engineer**
- Orchestrator: scheduling (T-minus timers, drift-corrected to chain time), job queue, crash recovery/reconciliation (FR-EXEC-004), persistence schema for §10 entities, spend-ledger.
- Notifications: channel abstraction + Telegram (FR-NOTIF-001/002) with confirm-gated commands.
- Wire Safety surfaces across processes (file kill switch, caps in store).
- Expose a thin local API over Store for future dashboard/CLI parity. No multi-user concerns.

**Frontend Engineer** (Phase 2 entry)
- Phase 2: consumer-friendly intelligence, readiness, calendar, and alert views.
- Phase 3: campaign, execution, fire-lane, and approval controls.
- Phase 4: opportunity evidence and signal explanations.
- Phase 5: complete overview, whale history, analytics, and historical exploration. All views are traceable to underlying records.

**Product Designer**
- Information architecture for those six views prioritized around the operator's core questions: "What should I fire at?", "Are my wallets ready?", "What just happened?", "What did it earn?" Opportunity card must show score breakdown + risk flags + replicability verdict. Telegram message templates for the alert catalog.

**DevOps Engineer**
- Deployment topology: Windows dev box + one small always-on host for orchestrator; secrets handling (no plaintext keys at rest anywhere; backup/restore of encrypted keystore; rotation procedure).
- CI: lint/typecheck/unit/fork gates; fork suite needs Anvil service containerization.
- Monitoring: process liveness, endpoint error rates, disk/log rotation; alerting hook into the same Telegram channel.

---

## 15. Open Questions / DECISION REQUIRED

1. **DECISION REQUIRED — Robinhood operational enablement.** Compatibility is positively characterized. Enablement remains contingent on the integrated release gates: archive replay, negative paths, per-wallet simulation, durable reservations, sequencer/RPC correlation, restart and duplicate reconciliation, finality observation, and bounded live rehearsal.
2. **DECISION REQUIRED — KMS choice for custody end-state.** Current envelope encryption (scrypt KEK) is a stopgap. Candidates: cloud KMS (AWS/GCP) via personal account, local TPM-backed store, or hardware-wallet co-signing. Needed before large budgets ride on burners.
3. **DECISION REQUIRED — Store technology.** Default recommendation SQLite (WAL mode) for zero-ops durability; confirm acceptable given Windows primary + possible Linux VPS orchestrator host.
4. **DECISION REQUIRED — Funding-graph hygiene.** Hub-funded Multicall clusters wallets publicly. For a personal bot this may be acceptable; decide consciously and record the tradeoff (egress diversity costs real convenience).
5. **DECISION REQUIRED — L1 bundle economics.** Flashbots bundle inclusion fees/relay choice (mev-share vs classic) and whether refund mechanics matter at our scale; needs one live-fire measurement.
6. **DECISION REQUIRED — Earned autonomy policy.** At what sustained accuracy does score ≥ threshold graduate from "propose, operator approves" to "auto-arm within caps"? Propose metrics in Phase 5; decide then.
7. **DECISION REQUIRED — Own-WL/FCFS path priority.** OpenSea private-API per-wallet calldata unlocks own-allowlist mints but is undocumented and fragile. Schedule against RawCalldata-manual alternative after P3.
8. **Confirmation-depth validation.** Ethereum and Robinhood finality policies must be validated by the operational release tests.
9. **Consumer language validation.** User testing must confirm that ordinary users understand cost, risk, status, and next actions without technical training.

---

## 16. Risks

### Hard security constraints (restated from briefing §7 — treat as standing rules)

- **`solana-pnl-tracker` contains 5 hardcoded live Helius API keys** and an `api/config.js` that **leaks the key to the browser**. Keys (treat as **burned/compromised — never use**): `f3ac9d10-c200-4f1f-87d6-481260a0e19f`, `3e096acf-ebcf-4b00-b733-c8d554d2c198`, `12c81d6f-9d31-4c46-ac73-8e49c05cd97a`, `3e6d2253-1502-4349-aa80-a1818fc6610e`, `81b87cb0-2d25-4e19-8236-c0d95f9b78f5`. Correct pattern: **server-side proxy only** — never ship provider keys to the client.
- **Single-`MNEMONIC` custody is the #1 liability:** one leak drains every derived wallet. Keep any MNEMONIC out of persisted state; prefer per-wallet independent encrypted keys / KMS.
- **Vanity address generators are the same risk class as the backdoored `profanity` tool** (~$160M Wintermute loss). Never hold value in casually-generated vanity keys.
- **osnm-z's `0o600` wallet-file permission is a no-op on Windows** (our platform) — do not rely on file permissions for at-rest protection.
- **osnm-z's `SponsoredMintExecutor.sol` is explicitly UNAUDITED.** Its creation-hash constant is *bytecode-pinning*, not an audit. Do not route custody/sponsor value through it without an audit.

### Technical
- RPC/endpoint instability at exactly T-0 (mitigate: blast, probes, prewarming, fallback paths).
- Nonce races under retries (existing mutex manager; fork tests must cover replacement storms).
- Reorgs corrupting accounting (depth policy + reconciliation; FR-EXEC-003/004).
- Non-SeaDrop or SeaDrop-v2 drops failing silently (typed strategy-not-found errors; never fall back to guess-calldata).
- Malicious drops/phishing contracts designed to drain approvers (simulation gate + no blanket approvals; allowance audits).

### Product
- Signal quality unproven until Phase 4–5 data accumulates; operator judgment is the interim edge.
- Alert fatigue degrading response to real alerts (strict thresholds, digesting low-priority classes).
- Scope creep toward Phase-2 features during Phase-1 polish (this doc is the arbiter).

### Security
- Host compromise while keys are in memory (window minimization, zeroize discipline, burner budgets, eventual KMS).
- Config/backups leaking keystore (encrypted-at-rest verification tests; backup restore drills).

### Operational
- Unattended money-spending software: bounded only by caps + kill switch; runbook drills before every live-fire.
- Windows-specific quirks (file perms, path handling) — covered by tests on the actual platform.

### Blockchain-specific
- L1 public-mempool submission burns gas on revert (why bundles are the L1 primary path).
- L2 sequencer outages/censorship windows (monitor sequencer health; blast includes public fallback).
- Robinhood compatibility is characterized, but operational enablement remains blocked until the integrated release gates pass.

### Repository/dependency
- OpenSea private GraphQL dependency fragility (feature-flagged, degradation-tolerant).
- viem/foundry version churn (exact-pinned deps; lockfile discipline like osnm-z).

---

## 17. Acceptance Criteria

**P1 — Execution Foundation (exit)**
1. `pnpm test:fork` green in CI: forks mainnet at a block with a live SeaDrop public drop, warps to start, fleet of ≥3 test wallets mints; asserts balances, receipts, spend-ledger entries.
2. Fork coverage for: revert path (bundle/tx not included or reverted cleanly), sold-out, per-wallet cap, insufficient funds, kill switch mid-fleet (later wallets never submit), daily-cap abort.
3. Custody leak-regression suite green: no key bytes in logs, errors, serializations, heap dumps; zeroize verified.
4. CLI flows documented and runnable: generate→fund→dry-run→run→summary→kill.
5. Live-fire rehearsal on smallest viable real mint completed with post-run report (latencies, gas, issues log).
6. `lint` + `typecheck` clean; no TODOs without linked phase/issue.

**P2 — Intelligence MVP (exit)**
1. Tracked wallets, upcoming mints, and candidate opportunities are visible with source time and plain-language explanations.
2. Wallet-by-campaign eligibility and readiness is calculated and surfaced, including actionable blocked reasons.
3. Deterministic scores persist their inputs and model version; hard safety gates cannot be bypassed by a score.
4. Telegram alerts and consumer-friendly dashboard views deliver the defined discovery, readiness, and reminder experience.
5. The Intelligence MVP does not enable Robinhood; chain enablement remains a separate operational release decision.

**P3 — Validation, Preparation & Controlled Operations (exit)**
1. Scheduled mint execution survives a mid-flight process restart and reconciles without double-spend or orphaned work.
2. SQLite-backed reservations and the execution engine are integrated through one approved path.
3. FCFS-style public mint can be prepared and explicitly armed from web or Telegram; per-wallet results are reported; adaptive stops demonstrably fire.
4. Fire-lane lifecycle and staged finality states are observable and auditable.

**P4 — Qualified Automation & Opportunity Intelligence (exit)**
1. Tracked-wallet stats populate from ingested history; convergence detection is demonstrated on historical data replay.
2. Scoring v1 live: every opportunity carries persisted inputs/model-version; thresholds behave per §12.
3. Replication checklist blocks a deliberately non-replicable (merkle-gated) mint with explicit verdict; a replicable SeaDrop public mint passes end-to-end behind operator approval.
4. Zero unvalidated replications executed (audit query returns empty).

**P5 — Feedback Loop (exit)**
1. FIFO PnL matches manually computed ground truth on seeded dataset.
2. Attribution report identifies best/worst signal sources over accumulated data.
3. First scoring-weight recalibration performed from realized outcomes, versioned, diffable.

---

*End of specification. Engineering agents: start from §7 Phase 1 and §14 handoffs; challenge anything with evidence.*
