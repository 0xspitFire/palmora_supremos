# Phase 1 Engineering Review

Review date: 2026-08-25

Reviewed against `PRODUCT_SPEC.md`, `PRODUCT_DESIGN_SPEC.md` in the product-design worktree, `CTO_Brief.md` in the silk-thursday worktree, the five `PLAN_*.md` files, and the actual engineers worktree.

## 1. Executive Verdict

### Phase 1 Not Ready

The repository contains a partial blockchain engine scaffold, but not a functionally complete Phase 1 product. The CLI has package metadata but no source implementation, there are no tests, no durable store, no orchestrator, no API, no Telegram integration, and no deployment or recovery infrastructure. More importantly, the existing engine still contains safety-critical defects: one-wallet simulation is used for a fleet, spend caps are process-local and non-reservation-based, raw account access bypasses the signer boundary, concurrent workers can pass kill/cap checks together, dry-run reports `success` and mutates nonce state, and transaction attempts/reorgs are not durably reconciled. No live capital should be used.

## 2. Overall Scorecard

| Area | Status | Confidence | Key finding |
| --- | --- | --- | --- |
| Blockchain | PARTIAL / BLOCKED | High | SeaDrop and broadcaster scaffolds exist; chain verification, per-wallet simulation, reconciliation, and tests are missing. |
| Backend | MISSING | High | No orchestrator, services, API, durable state, readiness, jobs, or Telegram code. |
| Frontend | MISSING / OUT OF SCOPE FOR P1 | High | No frontend exists; this is correct for the CLI-only Phase 1 boundary, but future flows cannot be exercised. |
| Database | MISSING | High | No schema, migrations, store, durable spend ledger, or event history. |
| DevOps | MISSING | High | No CI workflow, container, deployment, monitoring, backup, or recovery configuration. |
| Integration | FAIL | High | Only in-process engine wiring exists; no end-to-end workflow is runnable. |
| Security | CRITICAL GAPS | High | Local custody is a stopgap and execution bypasses the declared signer contract. |
| Product Requirements | FAIL | High | Core P1 acceptance criteria cannot be demonstrated. |
| Product Design | OUT OF SCOPE / NOT TESTABLE | High | The design correctly defers web UI; its future contracts have no backend/read model to consume. |

## 3. Engineering Stack Reviews

### Blockchain Engineering

#### Done well

- `packages/engine/src/types.ts` defines useful strategy, broadcaster, signer, nonce, receipt, and error concepts.
- `SeaDropV1PublicStrategy` isolates SeaDrop calldata and resolves the singleton at `packages/engine/src/strategies/seadrop-v1-public.ts:76-179`.
- The code uses independent random keys rather than a shared mnemonic and has an explicit zeroize lifecycle in `signer.ts`.
- Ethereum and Base chain IDs are represented, and Robinhood has no RPC endpoints configured, which prevents accidental use through the current client path.
- Broadcast paths are separated into public, blast, Flashbots, and sequencer classes.

#### Incorrect or incomplete

- `mint-engine.ts:228-235` simulates only `fundedWallets[0]`; it does not establish per-wallet or justified wallet-class safety.
- `mint-engine.ts:188-193` estimates gas only for the first wallet and applies the result to every wallet.
- `mint-engine.ts:335-466` launches all wallet operations at once. Kill and spend checks are not serialized immediately before signing and submission.
- `mint-engine.ts:397-398` calls `signer.getAccount()` and signs directly, bypassing `Signer.signTransaction()` and invalidating the future KMS boundary. `signer.ts:213-225` exposes the same bypass publicly.
- `safety.ts:77-138` keeps cap counters in memory, resets them on restart, has no campaign/day persistence, and reserves no pending worst-case exposure.
- `mint-engine.ts:379-393` labels dry-run as `success` and calls `consumeNonce`, contradicting the design’s explicit dry-run semantics.
- `receipt-watcher.ts:43-90` watches one hash only and has no replacement, dropped-transaction, or reorg reconciliation.
- `broadcasters/blast.ts` and `sequencer-direct.ts` return endpoint results but do not provide durable hash identity or ambiguity reconciliation. A timeout or `already known` response can be misclassified.
- `chains.ts:66-76` represents Robinhood as a normal supported type with placeholder values and no explicit verification status. The product requires an unverified execution-blocking state.
- `SeaDropV1PublicStrategy:193-219` uses local wall-clock validation and treats missing supply reads as non-fatal, while the product requires explicit freshness and actionable uncertainty for safety-critical gates.
- `FlashbotsBroadcaster` is not wired into the engine’s `auto` path. `broadcasters/index.ts:62-72` uses blast for Ethereum, contrary to the CTO’s L1 private-orderflow primary direction.

#### Critical fixes

1. Remove account access from the engine and sign only immutable transaction intents through the signer interface.
2. Add per-wallet simulation/gas evidence and block live arming when required evidence is absent or stale.
3. Replace local caps with atomic durable reservations and admission checkpoints.
4. Implement attempt/replacement/receipt/reorg reconciliation before permitting unattended execution.
5. Add the Anvil fork suite and leak-regression suite required by the PM exit criteria.

### Backend Engineering

#### Status

No backend implementation exists. There is no application service, orchestrator, queue, API, readiness engine, campaign state machine, opportunity pipeline, notification dispatcher, or Telegram integration.

#### Required fixes

- Build the Phase 2 operational shell only after Phase 1 engine corrections: persisted runs, scheduling, restart reconciliation, reservation ledger, typed transitions, and one-way notifications.
- Keep orchestrator signing-free and make the store authoritative.
- Separate proposal approval from live campaign arm and persist immutable policy/evidence snapshots.
- Make retryability a typed backend decision rather than a generic UI/Telegram action.

### Frontend Engineering

#### Status

No frontend source exists. This is not itself a Phase 1 defect because the Product Manager and Designer explicitly make the CLI the Phase 1 operator surface and defer the dashboard. It does mean all future designer journeys are currently `NOT TESTABLE`.

#### Required fixes

- Do not pull the dashboard, opportunities, calendar, or analytics into Phase 1.
- When Phase 3+ starts, implement the designer’s read-mostly state-driven views against backend read models, not mock data or client-side chain logic.
- Preserve score/gate separation, canonical states, partial wallet failure, stale-data behavior, and explicit arm confirmation.

### Database Architecture

#### Status

No database schema, migration, store, or durable event/transaction model exists. Consequently, the system cannot reconstruct a run, enforce daily caps across restarts, or meet the PM’s auditability requirement.

#### Required fixes

- Validate SQLite WAL on Windows and the target always-on host before locking the choice.
- Implement durable current-state entities plus targeted historical records for intents, attempts, receipts, simulations, reservations, state transitions, audit, and notification delivery.
- Enforce campaign/wallet/transaction relationships, immutable intents, unique `(from, nonce)` identity where applicable, and atomic reservation transitions.
- Retain executions, scores, and PnL indefinitely; prune raw watcher noise only after the defined retention period.

### DevOps

#### Status

No CI/CD, Anvil service setup, deployment configuration, environment schema, secret manager integration, monitoring, alerting, backup, or recovery runbook exists.

The only visible external configuration is hardcoded public RPC fallback URLs in `packages/engine/src/chains.ts:26-30`. These are not sufficient production configuration and are not evidence of provider health, credentials, failover, or chain verification.

#### Required fixes

- Add reproducible lint/typecheck/unit/fork/build gates and secret scanning.
- Define Windows development and small-host production environments with pinned Node/pnpm/tool versions.
- Add health checks for process, store, RPC endpoints, chain verification, reconciliation age, kill switch, and notification delivery.
- Implement encrypted backup/restore and restart/disk-loss drills before live funds.

## 4. Cross-Stack Integration Review

| Workflow | Expected path | Actual result | Failure point |
| --- | --- | --- | --- |
| Opportunity discovery | Chain observation → backend → score → store → API → UI/Telegram | MISSING | No discovery, backend, store, API, UI, or Telegram. Correctly deferred from P1. |
| Upcoming mint / eligibility | Calendar → campaign → eligibility → readiness → store → notification | MISSING | Calendar, campaign model, eligibility, readiness, and notification do not exist. Phase 3 scope. |
| Transaction validation | Campaign → wallet selection → construction → simulation → result → records | PARTIAL | Engine constructs and simulates, but only one wallet, with no durable result or campaign boundary. |
| Execution | Operator → backend/CLI → engine → chain → monitoring → records → report | FAIL | CLI/backend/store/report are absent; engine has unsafe admission and reconciliation defects. |
| Failure | Detection → typed classification → durable record → retry/skip → UI/Telegram | PARTIAL IN ENGINE / MISSING SYSTEM | Some `MintError` values exist, but no durable classification, retry authority, or operator surface exists. |

The only runnable architectural slice is an in-process engine invocation, and even that cannot be validated in this checkout because dependencies are not installed and the CLI entrypoint is absent.

## 5. Product Requirement Audit

| Requirement | Implementation | Location | Status | Evidence | Issue |
| --- | --- | --- | --- | --- | --- |
| Fork-tested SeaDrop fleet | Engine scaffold | `packages/engine` | MISSING | No test files; `pnpm test` cannot run without dependencies | No Anvil harness or CI gate. |
| CLI wallet generate/list/fund | Package metadata only | `packages/cli/package.json` | MISSING | No `packages/cli/src` | Operator cannot perform the workflow. |
| CLI mint dry-run/live run | Engine method only | `mint-engine.ts` | PARTIAL | `execute()` exists | No CLI; dry-run falsely returns `success` and consumes nonce. |
| Health and kill commands | `MintEngine.kill()` only | `mint-engine.ts:485-503` | PARTIAL | Programmatic method exists | No CLI, cross-process state, or operational status. |
| Kill switch at every spend checkpoint | Local polling | `safety.ts:37-59`, `mint-engine.ts:341-355` | FAIL | Checks occur before concurrent work only | Already-launched workers can proceed; no shared cancellation/admission gate. |
| Per-mint/daily caps | Process-local tracker | `safety.ts:77-147` | FAIL | Counters and post-receipt recording exist | No atomic reservation, persistence, day scope, or overspend prevention. |
| Independent encrypted custody | AES-GCM/scrypt signer | `signer.ts:69-129` | PARTIAL | Independent key generation exists | Plaintext key JSON is built in memory; atomic file write/schema bounds/rotation absent. |
| Signer-only key boundary | Interface declared | `types.ts:153-161`, `mint-engine.ts:397-398` | FAIL | Direct account signing present | KMS-compatible boundary is bypassed. |
| Preflight funding | Balance loop | `mint-engine.ts:203-224` | PARTIAL | Balance check exists | First-wallet gas estimate is applied to all wallets; no durable readiness. |
| Setup-time simulation | `simulateMint()` | `drop-reader.ts:79-107` | FAIL | One funded wallet only | Fleet safety is not established; result is not persisted/freshness-scoped. |
| Structured JSON logs | Pino logger calls | `mint-engine.ts`, `logger.ts` | PARTIAL | Structured event fields exist | Raw error messages and serialized transactions can leak sensitive operational data; no durable run record. |
| Per-wallet failure isolation | Promise isolation | `mint-engine.ts:335-481` | PARTIAL | `Promise.allSettled` and per-wallet catch | Concurrent admission defeats kill/cap guarantees; no reconciliation. |
| Confirmation/reorg handling | Receipt polling | `receipt-watcher.ts` | FAIL | Confirmation depth is checked | No reorg downgrade, replacement history, dropped transaction state, or restart recovery. |
| Chain profiles | Ethereum/Base/4663 registry | `chains.ts` | PARTIAL | IDs and endpoints exist | Robinhood is not an explicit verified gate; endpoint configuration is partly hardcoded/public. |
| Small-value live-fire report | No operational artifact | Repository | MISSING | No runbook, deployment, or report | Human verification cannot begin safely. |
| Lint/typecheck clean | Scripts declared | root `package.json` | NOT TESTABLE | `tsc` not installed; `node_modules` absent | Dependency installation is required; no test evidence exists. |

## 6. Product Design Audit

| UX requirement | Implemented | Matches flow | Functional | Issue |
| --- | --- | --- | --- | --- |
| Phase 1 CLI-only operator surface | No CLI source | Yes in scope | No | Correct boundary, but supported action cannot be completed. |
| Dry run distinct from live | Partial engine log | No | No | Returns `success` and consumes nonce. |
| Readiness per wallet/campaign | Balance loop only | No | No | No campaign model and only one simulation. |
| Explicit arm/approval boundary | No implementation | No | No | No campaign, approval, or immutable snapshot. |
| Partial failure visibility | Partial result type | Partial | No | No canonical persisted report or operator surface. |
| Kill consequence copy | No UI/Telegram | Not testable | No | Must state future submissions stop and submitted transactions remain. |
| Future web dashboard IA | Missing | Not applicable to P1 | Not testable | Correctly deferred until durable state and later roadmap phases. |
| Future Telegram alerts | Missing | Not applicable to P1 | Not testable | Phase 2; no notifier or delivery records. |

## 7. Security Audit

### Critical

- The live execution path bypasses `Signer.signTransaction()` and obtains a viem account object directly (`mint-engine.ts:397-398`). This breaks the intended KMS boundary and exposes signing capability to engine code.
- Spend caps do not reserve pending exposure and are checked concurrently (`safety.ts:98-135`, `mint-engine.ts:349-355`). A fleet can overspend the configured cap.
- Kill checks do not stop already-admitted concurrent promises (`mint-engine.ts:335-355`). A kill event can be followed by signing or submission.
- Only one wallet is simulated before fleet execution (`mint-engine.ts:226-235`). Wallet-specific eligibility or sender-dependent reverts can reach live signing.

### High

- The signer stores private keys as a JSON string before encryption (`signer.ts:100-123`), making reliable memory zeroization impossible for all runtime copies.
- Wallet file parsing has no strict schema, length, duplicate-index, ciphertext-size, or address/key correspondence validation (`signer.ts:150-182`).
- Wallet generation writes directly to the destination path (`signer.ts:123`) rather than using an atomic replacement strategy.
- Raw error messages are persisted/logged (`mint-engine.ts:303-304`, `455-456`) without a central redaction policy.
- Flashbots authentication accepts a raw private key in a broadcaster configuration (`flashbots.ts:26-44`), with no demonstrated secret-provider boundary or integration test.

### Medium

- Public fallback RPC URLs are committed as defaults. Provider reliability, privacy, rate limits, and endpoint identity are not verified.
- `KillSwitch.reset()` is public (`safety.ts:66-70`), increasing the risk of an accidental production reset if exposed by future application wiring.

No actual credential values were found by the audit search. The search did find security-sensitive identifiers and terms in source and planning documents; those are not credentials.

## 8. Technical Debt

### Must fix before Phase 1

- Missing CLI and operator runbook.
- Missing fork, custody leak, and failure-path tests.
- Signer boundary bypass.
- Non-atomic spend caps and missing durable state.
- Unsafe kill admission and dry-run semantics.
- Missing transaction reconciliation and reorg handling.
- Missing explicit chain verification and Robinhood blocking state.

### Should fix soon

- Strict encrypted-file validation and atomic writes.
- Central error redaction and typed operator-safe output.
- Chain-time/NTP calibration and recurring connection warmup.
- Proper Flashbots/private-orderflow wiring and measured fallback behavior.

### Can defer

- Web dashboard, opportunity intelligence, calendar, two-way Telegram, advanced strategies, EIP-7702, and analytics. These are later roadmap phases, not valid substitutes for P1 reliability.

## 9. Bugs and Required Fixes

### BUG-001

Issue: Fleet simulation uses one wallet.

Severity: Critical

Affected stack: Blockchain; integration ownership with Backend

Evidence: `packages/engine/src/mint-engine.ts:226-235`

Expected behavior: Every live wallet, or a demonstrably equivalent wallet class under an explicit policy, has fresh simulation evidence before arm.

Actual behavior: Only the first funded wallet is simulated and its result gates the fleet.

Recommended fix: Add per-wallet/class simulation records with source block and freshness policy; block affected wallets or live arm when evidence is missing.

Blocking Phase 1?: Yes

### BUG-002

Issue: Concurrent process-local cap checks can overspend.

Severity: Critical

Affected stack: Backend/Database boundary; current implementation in Blockchain engine

Evidence: `safety.ts:98-135`, `mint-engine.ts:349-355`

Expected behavior: Worst-case exposure is atomically reserved before signing/submission and settled or released after authoritative outcome.

Actual behavior: Workers check a shared in-memory number and record actual spend only after confirmation.

Recommended fix: Implement durable chain/campaign/day reservations and admission tokens.

Blocking Phase 1?: Yes

### BUG-003

Issue: Kill switch does not cancel admitted work.

Severity: Critical

Affected stack: Blockchain/Backend integration

Evidence: `mint-engine.ts:335-355`

Expected behavior: Kill blocks every not-yet-admitted signing/submission and reports already-submitted work truthfully.

Actual behavior: `Promise` workers are launched together and only check kill at worker start.

Recommended fix: Add cancellation-aware scheduler, serialized admission, and pre-sign/pre-submit checks.

Blocking Phase 1?: Yes

### BUG-004

Issue: Signing bypasses the declared signer boundary.

Severity: Critical

Affected stack: Blockchain

Evidence: `mint-engine.ts:397-398`, `signer.ts:213-225`

Expected behavior: Engine submits immutable intent through `Signer.signTransaction()` only.

Actual behavior: Engine obtains a viem account and calls `signTransaction()` on the account.

Recommended fix: Serialize the immutable unsigned intent and call the interface; remove or isolate `getAccount()` from production paths.

Blocking Phase 1?: Yes

### BUG-005

Issue: Dry-run is indistinguishable from success and mutates nonce state.

Severity: High

Affected stack: Blockchain/CLI

Evidence: `mint-engine.ts:379-393`

Expected behavior: Dry-run never signs/broadcasts, never mutates live nonce state, and reports an explicit dry-run/prepared result.

Actual behavior: Result status is `success` and nonce is consumed.

Recommended fix: Add explicit dry-run status and use read-only nonce data.

Blocking Phase 1?: Yes

### BUG-006

Issue: No restart/replacement/reorg reconciliation.

Severity: High

Affected stack: Blockchain/Backend/Database

Evidence: `receipt-watcher.ts:43-90`, absence of store/orchestrator

Expected behavior: Every intent and attempt is durable and reconciled before new work after restart; confirmed can downgrade to reorged.

Actual behavior: One selected hash is polled in memory; timeout is a generic error.

Recommended fix: Persist attempts and reconcile by hash and `(from, nonce)` with chain-profile finality policy.

Blocking Phase 1?: Yes for unattended/live operation

### BUG-007

Issue: Phase 1 operator workflow is absent.

Severity: High

Affected stack: Backend/CLI/DevOps

Evidence: `packages/cli` contains only `package.json` and `tsconfig.json`; no `src` directory, store, runbook, or deployment files.

Expected behavior: Product Owner can generate/list/fund wallets, dry-run, run, inspect summary, and kill without code/database intervention.

Actual behavior: No CLI command can be executed.

Recommended fix: Implement CLI and its bounded application boundary after the safety contracts are corrected.

Blocking Phase 1?: Yes

## 10. Integration and Configuration Inventory

| Integration | Environment | Required | Credential | Setup action | Verification |
| --- | --- | --- | --- | --- | --- |
| Ethereum RPC pool | Dev/CI/live | Yes | Provider URL, possibly API key | Product Owner supplies approved endpoint(s) through host secret/config system | `eth_chainId`, health probe, latency/error metrics, fork/live connectivity. |
| Base RPC/sequencer | Dev/CI/live | Yes | Provider/sequencer endpoint configuration | Supply approved endpoints and fallback policy | Chain ID, endpoint propagation, sequencer health and test transaction. |
| Robinhood Chain 4663 | Future only | No until verified | Characterized endpoint(s) | Do not enable; provide characterization evidence first | Written spike covering endpoints, sequencing, gas, EIP-1559, private orderflow, and SeaDrop test. |
| Flashbots relay | Ethereum live | Required for intended L1 primary | Auth signer secret and relay policy | Supply through secret manager; choose relay/economics | Bundle dry-run/live measurement and inclusion/revert behavior. |
| Encrypted wallet file | Local/live | Yes for current custody stopgap | Operator passphrase, never persisted | Product Owner creates/imports wallets through CLI procedure | Decrypt/list, backup restore, signing test, zeroization/leak suite. |
| SQLite store | Live orchestrator | Required P2, not present | None or host file protection | Approve location and backup target | WAL locking, migration, restart, reservation, and restore tests. |
| Telegram Bot API | P2 | No for P1 | Bot token and allowed operator identity/chat | Create bot and provide token through secret mechanism | Send test alert and verify canonical run link/delivery record. |
| Anvil/fork RPC | CI | Yes for P1 | Fork provider URL if required | Configure CI secret and pinned Anvil version | `pnpm test:fork` with live SeaDrop fixture and failure scenarios. |
| Monitoring/alert destination | P1/P2 | Process health required; Telegram alerting P2 | Optional monitoring credential | Choose host metrics/log destination | Trigger liveness, disk, RPC, kill, and backup alerts. |

Current status for all external integrations is `MISSING` or `NOT TESTABLE`; no credentials were provided or exposed during this review.

## 11. Product Owner Action Checklist

### Credentials

- [ ] Provide approved Ethereum and Base RPC endpoint configuration through the project’s secret mechanism. Needed for chain reads, fork tests, and live operation; blocks P1 validation and live use; verify with chain ID and health checks.
- [ ] Provide Flashbots authentication configuration if Ethereum private orderflow is approved. Needed for intended L1 broadcast; blocks L1 live execution; verify with a non-value bundle test.
- [ ] Create a Telegram bot and provide its token only through host secret storage before Phase 2. Not a P1 blocker; verify with a test alert after implementation.

### Configuration

- [ ] Approve the initial Ethereum/Base enablement and keep Robinhood disabled until the characterization report is accepted. Blocks any Robinhood use; verify chain registry status.
- [ ] Set conservative per-mint and rolling-daily native-token caps and burner funding limits. Blocks live spend; verify in the arm snapshot and cap-ledger drill.
- [ ] Choose the approved wallet fleet, labels, and funding policy. Blocks live execution; verify balances and wallet-specific readiness.
- [ ] Approve the chain confirmation policy after empirical validation. Blocks final operational sign-off; verify with receipt/reorg drill.

### External Integrations

- [ ] Select the always-on host and backup destination for the orchestrator/store. Blocks Phase 2 unattended operation; verify restore and restart drills.
- [ ] Decide whether hub funding’s public wallet clustering is acceptable for personal operations. Does not block dry-run; blocks an approved privacy-sensitive operating policy; verify the documented risk decision.

### Product Decisions

- [ ] Approve the local encrypted signer as a temporary stopgap and set the threshold at which KMS/TPM/hardware signing becomes mandatory. Blocks operation with material capital; verify documented custody policy.
- [ ] Decide whether Telegram Phase 3 approval authorizes preparation only or firing at a configured trigger, retaining a separate explicit live arm. Not a P1 blocker; blocks Phase 3 semantics; verify confirmation copy and audit records.

### Wallet / Blockchain Setup

- [ ] Fund only designated burner wallets with the approved small budget after all engineering gates pass. Blocks live-fire rehearsal; verify on-chain balances and funding records.
- [ ] Select a real public SeaDrop test target for the smallest-value rehearsal after fork tests pass. Blocks rehearsal only; verify target, chain, phase, price, and simulation evidence.

### Deployment

- [ ] Approve the production host, operating account, secret storage, and maintenance window. Blocks unattended operation; verify clean-host rebuild.
- [ ] Approve backup retention and recovery ownership. Blocks operational sign-off; verify a restore without plaintext key creation.

### Final Verification

- [ ] Observe and approve the first dry-run output, confirming it cannot be confused with a live mint. Blocks live use; verify no signing, broadcast, or nonce mutation.
- [ ] Participate in a smallest-value live-fire rehearsal only after engineering reports all P1 gates green. Blocks production confidence; verify per-wallet results, gas, cap ledger, logs, and kill behavior.

## 12. Phase 1 Gate

### BLOCKING ISSUES

- No CLI or complete operator workflow.
- No Anvil fork suite, custody leak suite, or CI evidence.
- One-wallet simulation and first-wallet gas estimation.
- Signer boundary bypass.
- Non-durable, non-atomic spend caps.
- Kill-switch admission race.
- Incorrect dry-run state and nonce mutation.
- No durable transaction attempt, restart, replacement, or reorg reconciliation.
- No durable run records or audit reconstruction.
- No deployment, backup, or recovery process.
- Robinhood lacks an explicit verified/unverified execution guard.

### NON-BLOCKING ISSUES

- Web dashboard and future design implementation, correctly deferred to later phases.
- Opportunity intelligence, calendar, two-way Telegram, advanced strategies, EIP-7702, and analytics.
- Chain-time calibration, recurring warmup tuning, and measured L1 economics after correctness foundations.

### PRODUCT OWNER ACTIONS

- Approve chains, caps, burner policy, custody stopgap, host, backup target, and initial endpoints.
- Provide RPC/relay configuration through secrets, not chat or source.
- Fund test wallets and select the smallest-value rehearsal only after engineering gates pass.

### ENGINEERING ACTIONS

- Implement the CLI, durable store/orchestrator boundary, safety reservations, signer isolation, per-wallet simulation, reconciliation, fork tests, leak tests, observability, runbook, and CI.
- Add explicit Robinhood verification state and refuse execution until the spike passes.

### VERIFICATION REQUIRED

- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:fork` from a clean checkout with dependencies installed.
- Execute fork scenarios for happy path, revert, sold-out, price drift, insufficient funds, cap race, kill mid-fleet, replacement, reorg, and restart.
- Complete dry-run, wallet readiness, kill, backup/restore, and smallest-value live-fire drills.

### FINAL RECOMMENDATION

> NO-GO

The repository is a useful starting scaffold, but it does not satisfy the Phase 1 acceptance criteria and currently contains defects that can cause unauthorized or unbounded spend. Reassess only after the blocking engineering actions are implemented and evidenced by fork, security, restart, and operator workflow tests.

## 13. Frontend Phase 1 Alignment Addendum

Review date: 2026-08-28

### Frontend audit result

The engineers branch contains no tracked `packages/web` or other web source. This is consistent with the approved Phase 1 CLI-only boundary. Frontend-owned Phase 1 blockers: **zero**.

### Shared contract verification

- `packages/engine/src/chains.ts` keeps Robinhood Chain 4663 at `verificationStatus: 'unverified'` and `executionEnabled: false`.
- `packages/engine/src/mint-engine.ts` refuses execution when the chain is disabled or unverified.
- `packages/backend/src/coordinator.ts` requires verified chain status, SeaDrop compatibility, evidence metadata, simulation evidence, and Robinhood sequencer mode before live arm.
- Engine and Database finality stages are `soft`, `posted`, and `ethereum_final`; Backend read models expose the corresponding Robinhood stages as `soft`, `posted`, and `final`. These represent the same staged model but require a shared mapping before a future UI is implemented.
- No frontend path can currently create optimistic success, bypass the backend gate, or expose Robinhood as executable because no web source is present.

### Deployment readiness impact

The Frontend audit adds no Phase 1 blocker. The following shared evidence gates remain deployment blockers for every future operator surface, including CLI and any later web UI:

- Robinhood chain/sequencer/feed characterization;
- archive-backed fork evidence through the approved `ROBINHOOD_ARCHIVE_RPC` reference in `Rets/MINT_BOT_SECRETS.env`;
- per-wallet simulation and readiness evidence;
- FREE-mint value/priority policy plus independent L2 and L1 gas reservations;
- durable intent, attempt, receipt, replacement, restart, reorg, and kill-switch recovery evidence;
- runtime health configuration and successful operational checks.

Product Design and Frontend remain non-blocking for Phase 1. Future frontend implementation must consume backend read models, preserve `soft`/`posted`/finality distinctions, separate safety gates from desirability scores, and never infer success optimistically.

### Consolidated frontend checklist verdict

- No tracked `packages/web` or frontend source: **PASS**; correct CLI-only Phase 1 scope.
- No browser secret, `Rets`, or custody access: **PASS by absence**.
- No client RPC, signing, or optimistic success path: **PASS by absence**.

## 14. 2026-08-29 Integration Checkpoint

The specialist implementation branches have been integrated into `engineers`.
The integrated stack now includes Blockchain, Database, Backend/CLI, DevOps,
and the CTO brief update. Frontend remains correctly deferred under the approved
Phase 1 CLI-only boundary.

### Validation

- `pnpm install --frozen-lockfile`: **PASS**.
- `pnpm typecheck`: **PASS**.
- `pnpm build`: **PASS**.
- `pnpm lint`: **PASS**.
- `pnpm ops:policy`: **PASS**.
- `pnpm ops:secret-boundary`: **PASS**.
- `pnpm ops:negative-cases`: **PASS**; paid mints, cap violations, missing
  independent gas reserves, unconfigured health, and unconfigured backup/
  restore fail closed.
- `pnpm test`: **FAIL at the live-fork gate**: 83 tests pass and 6 genuine
  Robinhood archive-fork tests fail because the approved archive/Anvil runtime
  is unreachable or unavailable. This is not a skipped or passing test.
- `pnpm ops:health`: **FAIL closed** because runtime secret-store, RPC, store,
  kill-switch, signer, notification, chain-verification, and reconciliation
  configuration has not been injected into this process.

### Current blockers

- Install/pin Anvil and make the approved archive RPC reachable through the
  read-only `Rets/MINT_BOT_SECRETS.env` reference. The test harness must start
  local Anvil from the archive source and run replay against local Anvil.
- Complete the six archive-backed tests: positive SeaDrop replay, invalid
  value, duplicate semantics, replacement, reorg disappearance, and staged
  finality anchor.
- Inject production runtime configuration through the secret manager and
  complete health, backup/restore, signer, kill-switch, and reconciliation
  drills without exposing values.
- Run an actual sequencer/feed correlation and accepted-but-unreported
  transaction recovery test.
- Obtain Product Owner acceptance of the complete evidence package before
  changing Robinhood from `unverified` to `verified` and enabling execution.

### Current gate

> NO-GO

The implementation is materially advanced and the static, unit, policy, and
security-boundary checks pass. Phase 1 is not deployment-ready and Robinhood
automated execution must remain disabled until the archive-backed fork and
runtime/recovery gates pass with recorded evidence.
- Robinhood 4663 shared fail-closed gate: **PASS**; Engine and Backend reject disabled/unverified live execution and require the stated evidence gates.
- Finality label difference: **documented, non-blocking for Phase 1**; shared mapping required before Phase 3 UI.
- External failed hashes: **documentation-only**, never fleet evidence.
- Frontend-owned Phase 1 blockers: **ZERO**.

Frontend cannot declare deployment readiness independently. Overall deployment readiness remains **NO-GO** until the shared evidence, safety, recovery, and operational gates pass.
