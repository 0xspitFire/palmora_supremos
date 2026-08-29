# CTO Engineering Brief

> Personal NFT Intelligence & Minting Platform
>
> Scope: repository due diligence, PRODUCT_SPEC.md reconciliation, and PRODUCT_DESIGN_SPEC.md engineering direction
> Date: 2026-08-25
> Owner: Founding CTO

## 1. Executive Decision

There is no repository in `Repo_Analyze` that is safe or complete enough to fork. The team should build a new system and selectively reproduce patterns:

- Adopt the SeaDrop public calldata derivation, endpoint probing, and pre-serialized broadcast concepts from `solotop999/opensea-nft-public-mint`.
- Adopt custody discipline, chain-time timing, bounded concurrency, and replacement-fee mathematics from `zunmax/osnm-z`.
- Port only the FIFO accounting idea from `singledavinci/solana-pnl-tracker`.
- Use the Ultra Dads repositories for command and copy-mint interaction ideas only.
- Discard scaffolding, the stale free-mint scanner, and the vanity-address generator as implementation sources.
- Build simulation gates, durable state, operator approval, Ethereum private orderflow, chain-specific routing, staged-finality handling, kill-switch semantics, and observability as first-party architecture.

The product must remain execution-first in Phase 1, with the CLI as the only operator surface. Telegram notifications begin in Phase 2. Campaigns, calendar, fire lanes, and approval commands begin in Phase 3. Opportunity intelligence and qualified replication begin in Phase 4. Analytics and the full dashboard begin in Phase 5. This is consistent with the PM and design documents and is a hard scope boundary. No chain is considered live merely because its evidence has been accepted; code, fork/integration tests, and operational gates must pass first.

The product's durable advantage is selection quality, not a promise of universal speed or profitability. Speed is chain-specific: Ethereum is primarily a gas/orderflow problem; L2s are meaningfully latency-to-sequencer sensitive.

## 2. Evidence And Scope

### Reviewed sources

- `Repo_Analyze`: seven URLs: `osnm-z`, `opensea-nft-public-mint`, `nft-public-mint`, `ultra-dads-mint-command-bot`, `ultra-dads-copy-mint-bot`, `solana-pnl-tracker`, and `stale-free-mint-scanner`.
- `NFT_MINT_BOT_CONTEXT_BRIEFING.md`: consolidated due diligence over ten repositories, locked architectural decisions, and security constraints.
- `PRODUCT_SPEC.md`: PM specification, roadmap, functional requirements, domain model, state machines, risks, and acceptance criteria.
- `PRODUCT_DESIGN_SPEC.md`: design handoff in the product-design worktree, including lifecycle UX, safety controls, recovery behavior, wireframes, responsive rules, and frontend acceptance criteria.
- Current implementation in `packages/engine`: the claimed Phase 1 engine, including `mint-engine.ts`, `signer.ts`, `safety.ts`, strategies, broadcasters, nonce management, and receipt watching.

The design specification is not present in this worktree because it was produced in the isolated product-design worktree. Its canonical location during this review was `C:\Users\hamid\AGravity\W3\.kilo\worktrees\product-design-spec\PRODUCT_DESIGN_SPEC.md`. It must be merged or otherwise made available to the engineering branch before implementation teams treat it as a repository artifact.

### What was not established

The repository artifacts are secondary evidence, not production assurance. No source repository provides a complete, audited, current, multi-chain, reorg-aware, operator-safe product. Any copied code would inherit undocumented assumptions, dependencies, and possibly compromised credentials. Every adopted concept requires a clean-room implementation, tests, and ownership of its security model.

## 3. Repository Findings

### `zunmax/osnm-z`

This is the strongest reference for correctness and custody, not for direct integration. Valuable patterns include independent OS-RNG wallets, zeroization, key-leak tests, custom debug behavior, chain-time timing, bounded concurrent execution, fee/replacement calculations, and verified funding flows.

Critical deficiencies include single-RPC public-mempool submission, no pre-send simulation, stale fee capture, an unaudited `SponsoredMintExecutor.sol`, and reliance on Unix `0o600` permissions that do not provide the intended boundary on Windows. Bytecode or creation-hash pinning confirms an artifact identity; it does not constitute a security audit.

**Decision:** reproduce the custody and execution patterns; do not ship the sponsored executor or assume file permissions protect keys. EIP-7702 is deferred until chain support, threat modeling, audit, and recovery behavior are proven.

### Robinhood Chain 4663 policy

The accepted Robinhood evidence establishes the implementation policy for chain 4663: it is an Arbitrum Nitro L2 with chain ID `4663`, no public mempool, strict FCFS ordering at the Robinhood sequencer, and no Flashbots-like builder, relay, or private-orderflow market. The official mainnet RPC/sequencer submission endpoint is `https://rpc.mainnet.chain.robinhood.com`; the sequencer feed is `wss://feed.mainnet.chain.robinhood.com`. These are public network endpoints, not credentials. The execution path is therefore direct-to-sequencer, with endpoint health monitoring and only explicitly configured fallback behavior; priority fee is not a queue-jumping mechanism on this chain. The sequencer feed provides ordering visibility after sequencer decision, not pre-order mempool visibility.

The accepted evidence includes the following positive SeaDrop-v1 transaction fixture:

- Transaction: `0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e`
- NFT contract: `0x45ce024f314a2f74c63a8a51743677df97a8d99e`
- Approved test wallet: `0x81c104DcB898416FD4f81eAd091DbA5b8f46F37A`

This is a positive live fixture for SeaDrop-v1 compatibility and the approved wallet path, not a declaration that this product's 4663 execution is live. Any externally supplied failed transaction hashes are documentation-only evidence: they must not be attributed to the approved test-wallet fleet, used as execution proof, or treated as a reason to retry. The implementation must still prove the exact contract/calldata path, fee accounting, soft-confirmation handling, recovery, and safety gates in code and tests before enabling execution.

Product Owner approval for auto-execution is recorded in principle only. It authorizes engineering of bounded, policy-compliant automation; it does not override verification status, simulation, durable reservations, reconciliation, or the release gate. No automatic execution is enabled by this approval alone.

Robinhood has staged finality: soft sequencer confirmation, Ethereum batch posting, and Ethereum finality. Records and UI must distinguish these stages and allow a soft-confirmed result to be downgraded/reconciled during the pre-posting exposure window. The chain profile must not reuse Ethereum's Flashbots assumptions or treat L1 confirmation depth as a sufficient Robinhood finality model.

For a Robinhood FREE mint, `value` is zero. Reserve `l2_execution_gas` and `l1_data_gas` independently at their configured worst-case ceilings, and reserve the priority-fee policy component separately with a maximum of `2x` its configured component. The `2x` rule applies only to the priority-fee component, not to the all-in reservation; the all-in reservation is the atomic sum of zero value plus the independent worst-case gas components and bounded priority component. A zero priority-fee component is valid; it is not an unlimited allowance and must not be rejected merely because it is zero. Total reservation must be atomic and durable across processes. Paid-mint execution on Robinhood remains blocked until the Product Owner defines the explicit value and exposure policy.

### `solotop999/opensea-nft-public-mint`

This is the strongest speed reference. Useful concepts are on-chain SeaDrop v1 public configuration reads, `mintPublic` calldata with `minterIfNotPayer = address(0)`, slug/address resolution, `eth_chainId` endpoint probing, precomputed serialized transactions, and parallel endpoint submission.

The implementation is public-mint-only. Its one-shot warming, plain `fetch`, local-clock timing, interactive raw-key entry, and public-mempool assumptions are not production foundations. A parallel blast also creates duplicate-send ambiguity unless the transaction identity and endpoint responses are reconciled.

**Decision:** port concepts into viem behind strategy and broadcaster interfaces; rewrite custody, timing, warming, retries, and reconciliation.

### `morsyxbt/nft-public-mint`

This is the older lineage of the speed-focused implementation and adds no superior capability. Forking both creates maintenance ambiguity and preserves the same public-only, timing, custody, and broadcast weaknesses.

**Decision:** historical reference only; do not fork.

### `ultra-dads-mint-command-bot`

The command interaction is useful as a UX reference, but single-`MNEMONIC` custody is unacceptable. A mnemonic leak compromises the complete derived fleet. Telegram commands are not approvals by themselves: they require authenticated operator identity, immutable scope, replay protection, confirmation, and durable records.

**Decision:** mine interaction ideas only. No custody or execution code.

### `ultra-dads-copy-mint-bot`

The copy-mint flow illustrates the product idea but is structurally unsafe when it treats observed activity as executable calldata. Wallet-bound signatures, Merkle proofs, `msg.sender` behavior, nonce assumptions, eligibility, and contract changes can invalidate or weaponize a copied transaction.

**Decision:** replace blind copying with a decoder, strategy matcher, per-field provenance, replicability verdict, simulation, and explicit operator approval. Public SeaDrop replication may pass; another wallet's allowlist calldata generally may not.

### `solana-pnl-tracker`

The FIFO lot-accounting concept is potentially useful after adapting it to EVM receipts, transfers, gas, payment tokens, reorgs, confirmation depth, and incomplete market data. The repository's five hardcoded Helius keys and browser-exposed provider key are compromised and must never be used or copied. Provider credentials belong behind a server-side proxy.

**Decision:** port the accounting algorithm conceptually; discard its credential and browser architecture.

### `stale-free-mint-scanner`

Discovery heuristics are not validation. Free mints can still invoke hostile contracts, require approvals, transfer value, or be stale. Low-quality scanning would increase alert fatigue and phishing exposure.

**Decision:** discard for Phase 1; revisit discovery only behind evidence, freshness, contract checks, simulation, and score/gate separation in Phase 4.

### Additional referenced repositories

`superbot-dashboard` and `baby-gpt-final` are scaffolding, not execution foundations. `singledavinci/vanity-address-generator` is forbidden for value-bearing wallets. A vanity address offers no product value that justifies the risk of predictable or backdoored key generation, a risk class demonstrated by the historical Profanity/Wintermute incident.

## 4. Essential Features Missing Across All Bots

The following capabilities are absent or insufficiently integrated across the analyzed repositories. They are not optional product polish; they are necessary to operate software that spends money.

### Safety and permission

- A durable, reservation-based per-mint and daily spend ledger.
- A kill switch enforced across processes and between every wallet submission, with clear limits on already-submitted transactions.
- Dry-run semantics that cannot be confused with a live success.
- Explicit separation of prepare, approve, arm, live spend, simulation, and kill actions.
- Typed safety gates independent of desirability scores.
- Immutable approval and policy snapshots.

### Transaction correctness

- Setup-time simulation for every distinct wallet state or wallet, with freshness and checkpoint policy.
- Contract deployment, chain identity, selector, value, recipient, price, supply, phase, and allowance validation.
- Nonce ownership and durable reconciliation after crashes, duplicate sends, replacements, dropped transactions, and reorgs.
- Confirmation-depth policy by chain and an explicit `reorged` state.
- Ethereum L1 private orderflow with revert protection and a defined public fallback.
- Verified-L2 sequencer health, endpoint fallback, and censorship/outage behavior; no assumption that L2s support private orderflow.
- Robinhood FREE-mint cost decomposition: zero value, independent L2 execution-gas and L1 data-gas reservations, and a bounded priority-fee component.
- Staged finality records for Robinhood soft confirmation, Ethereum batch posting, and Ethereum finality.

### Operations

- Durable job and event storage from which a run can be reconstructed without logs alone.
- Restart recovery before accepting new work.
- Endpoint health metrics, latency distributions, error attribution, and alerting.
- Typed retry policy; no generic “retry” button.
- Connection rewarming close to T-0 rather than a single early warmup.
- Chain characterization, especially for Robinhood Chain 4663.

### Intelligence and economics

- A tracked-wallet data model with sample size, recency, confidence, and failure history.
- Evidence-backed opportunity entities rather than bare alerts.
- Replicability classification and explicit non-replicable reasons.
- Reorg-aware EVM PnL and cost accounting.
- Distinct realized PnL, unrealized floor-marked estimates, and unknown coverage.
- False-positive accounting for signal calibration.

### Security and custody

- Independent wallet keys, encrypted at rest, zeroized in memory, and eventually isolated behind KMS/HSM signing.
- Burner budgets that limit the impact of host or process compromise.
- Secret-safe logs, errors, backups, support views, and telemetry.
- Key import/export and rotation procedures that never create plaintext files.
- Funding-graph risk assessment; one hub or one Multicall clusters wallets publicly.

## 5. Structural Loopholes To Block

These are the likely ways a superficially functional implementation could spend incorrectly or evade intended controls.

### Score bypassing a safety gate

A high score, a whale's successful transaction, or convergence of tracked wallets must never authorize execution. Simulation failure, unverified chain, cap breach, invalid target, stale evidence, and failed replication are permission failures. The scoring layer may recommend; only execution gates may permit.

### Blind calldata replay

Observed calldata must be decoded and classified. A public SeaDrop call can be replayable, while signed or Merkle-gated allowlist calls are wallet-bound. The system must refuse to turn a failed or uncertain replicability verdict into a campaign. There must be no generic raw-calldata escape hatch that bypasses simulation and caps.

### One simulation standing in for a fleet

Simulation for wallet A does not prove wallet B is eligible, funded, allowance-compatible, nonce-safe, or `msg.sender` equivalent. Readiness must be `(wallet, campaign)` and the minimum simulation unit must reflect distinct wallet state. Every wallet selected for live spend needs a recorded result or an explicit policy-backed reason for grouping.

### Check-then-spend races

Concurrent workers can all observe remaining cap and then overspend it. A cap check must reserve worst-case exposure atomically before signing/submission. Actual spend then settles the reservation. In-memory counters are not sufficient once there is an orchestrator, restart, or multiple process boundary.

### Kill switch illusion

Checking a kill switch when a worker starts does not stop work already launched by `Promise.all`. The execution scheduler needs cancellation-aware admission, a shared abort signal, a pre-sign checkpoint, a pre-submit checkpoint, and a serialized admission decision. The UI must state that a kill switch cannot recall transactions already submitted.

### Signer abstraction bypass

If the engine obtains a viem account object or raw signing capability from a local signer, the planned KMS boundary is false. The only engine operation should be an interface call that signs an immutable transaction intent. This also makes it possible to test that domain code never receives private key bytes.

### Endpoint response ambiguity

A blast can receive `already known`, timeout, success, and contradictory responses for the same raw transaction. The transaction hash is the identity. Persist every attempt, classify errors, and reconcile chain state before retrying or replacing. Never send a different nonce merely because one endpoint timed out.

### Stale readiness

Funding, supply, phase, price, eligibility, and simulation have different freshness windows. “Ready” is not permanent. Store timestamps, source block, and policy version, and invalidate readiness when its configured age or a relevant chain event is exceeded.

### Unsafe funding and clustering

Hub funding and atomic multicalls are operationally convenient but expose wallet relationships. Use small burner budgets, record the tradeoff, and do not imply privacy. If privacy is a requirement, fund through a deliberately designed egress strategy rather than pretending a single hub is private.

### Optimistic UI truth

The UI, Telegram, and CLI are not authoritative transaction state. `Submitted` is not `Confirmed`; a notification is not proof of execution; optimistic success must not enable follow-on actions. The store and chain reconciliation are authoritative.

## 6. Biggest Technical Risks

1. **Custody compromise:** local decryption means host compromise can expose the fleet. Mitigate with independent burners, minimal key lifetime, zeroization, encrypted backups, and a KMS/HSM signing path before meaningful capital is used.
2. **Malicious or misidentified contracts:** SeaDrop assumptions do not cover Manifold, thirdweb, or custom contracts. Validate target and strategy; never guess calldata; simulation is necessary but not a complete security proof.
3. **State drift:** a simulation can pass and the mint can sell out, change phase, change price, or become ineligible before T-0. Use freshness checkpoints, bounded policy, and adaptive stop conditions.
4. **L1 reverted gas:** public mempool execution can burn gas on a known-invalid transaction. Ethereum Flashbots/private bundles should be the primary L1 path, with measured fallback behavior. This does not apply to Robinhood, which has no conventional private-orderflow path.
5. **Nonce and replacement failure:** parallel wallets are independent, but retries for one wallet are not. Persist nonce state, replacement history, and chain reconciliation.
6. **Reorg and finality errors:** a receipt is not permanently final. Accounting and UI must support confirmation downgrade and replay-safe reconciliation.
7. **Robinhood integration safety:** chain 4663 evidence is accepted for Arbitrum Nitro identity, FCFS sequencer-direct routing, no public mempool/private orderflow, gas decomposition, staged finality, and positive SeaDrop-v1 compatibility. The product must still refuse execution until the implementation, tests, durable reservations, and operational readiness gates pass. Paid mints remain blocked.
8. **Operational restart gaps:** a crash between submission and receipt can create duplicate spends or unknown outcomes without a durable intent and reconciliation process.
9. **Signal overconfidence:** early wallet statistics have small samples and survivorship bias. Scores must carry confidence and cannot be presented as profitability probabilities.
10. **Provider and dependency failure:** undocumented OpenSea APIs, RPC degradation, viem/foundry churn, and rate limits require pinned dependencies, feature flags, health checks, and degradation states.
11. **Market liquidity:** floor price is not executable sale price. Royalty, marketplace fees, slippage, time-to-sale, wash trading, and illiquidity can turn a floor-marked gain into a loss.
12. **Performance claims:** “near-zero latency” cannot be a universal SLA. Measure time-to-sequencer on L2 and inclusion/orderflow outcomes on L1.

## 7. MintDash / SuperDads Enhancements

The product should reproduce the useful operational shape of MintDash, not merely its visible dashboard.

### Selection system

- Track wallets by chain and preserve raw evidence, timestamps, and source blocks.
- Score track record with recency, sample-size confidence, and failure rates, not only mint counts.
- Detect convergence, but require independent evidence and deduplication.
- Show positive signals, negative signals, freshness, and hard gates side by side.
- Make the recommended action `Inspect` or `Promote proposal`, never `Execute` from a signal card.

### Campaign operations

- Introduce campaigns as immutable operator intent: one drop, wallet scope, quantity, gas policy, spend policy, and trigger.
- Add fire lanes for prepared wallet groups with explicit lifecycle states.
- Add adaptive stops for sold-out state, price drift, cap breach, and kill switch.
- Make readiness campaign-specific and visible per wallet.

### Intelligence quality

- Add a calendar with source authority and verification times.
- Add eligibility sweeps that distinguish unknown from ineligible.
- Add a replication plan with per-field provenance and a hard refusal state.
- Track false positives and missed opportunities, not just wins.

### Operator trust

- Use the design lifecycle: Observe → Evaluate → Prepare → Approve → Execute → Monitor → Learn.
- Use canonical state labels across CLI, store, Telegram, and future web UI.
- Expose execution reports with latency, gas, endpoint attempts, receipts, and skipped reasons.
- Make recovery a first-class workflow: affected wallet, money spent, other wallets' continuation, retry safety, and authoritative record.

### Product positioning

Do not market or internally frame this as a guaranteed profit engine. It is a bounded decision-support and execution system. The edge must be measured from realized outcomes and calibrated over time.

## 8. Profitability Assessment

The likelihood that the product makes its user profitable as an NFT trader is **not currently quantifiable and should be treated as low-to-uncertain until evidence proves otherwise**. The repositories contain execution techniques, not a validated trading edge. Faster submission improves the chance of obtaining an allocation; it does not establish that the asset will appreciate or be liquid at a profitable price.

Profitability is constrained by:

- mint price, gas, priority fees, and failed-transaction losses;
- allocation and sell-out probability;
- collection quality and demand;
- market fees, royalties, slippage, and time-to-sale;
- floor-price manipulation and wash trading;
- wallet and signal selection bias;
- opportunity freshness and data completeness;
- capital opportunity cost and inventory risk.

The correct initial hypothesis is narrower: the system can improve operational expectancy relative to manual execution if it reduces missed valid mints, invalid submissions, unbounded spend, and poor signal selection. It cannot prove positive expected return. The product team should only claim profitability after a statistically meaningful, versioned dataset shows net realized PnL after gas and fees, with holdout periods and false-positive accounting. Until then:

- label results as `realized`, `unrealized floor-marked estimate`, or `unknown`;
- show denominator, sample size, data coverage, and freshness for win rate and hit rate;
- never call a tracked wallet profitable without a defined measurement window and net-cost basis;
- do not allow analytics to authorize execution;
- use small burner budgets and staged live-fire tests.

## 9. Current Engine Audit

The PM specification correctly calls the engine “built” but “untested against fork.” It must not be treated as production-ready. Specific issues found in the current code are below.

### `packages/engine/src/mint-engine.ts`

- `simulateMint` is run only for `fundedWallets[0]`, while the requirements call for per-wallet or per-wallet-class evidence. This is insufficient for wallet-bound behavior and should block live arming until corrected.
- `executeFleet` starts all wallet promises at once. A kill-switch check at worker start cannot prevent workers already admitted from signing or submitting after a kill event. Add an admission gate and cancellation signal immediately before signing and immediately before broadcasting.
- `SpendTracker.isCapExceeded()` is checked independently by concurrent workers, while `recordSpend()` happens after confirmation. This permits cap overshoot and does not reserve pending exposure. Replace it with durable atomic reservations based on worst-case cost and settle/release them on outcome.
- The engine uses `signer.getAccount()` and calls `account.signTransaction()` directly. This bypasses the declared `Signer.signTransaction()` boundary and prevents a drop-in remote KMS signer. Remove account access from the execution path.
- The same estimated gas limit and simulation result are applied across the fleet. Gas estimation should be associated with the actual wallet/call class and recorded per wallet where behavior differs.
- A failure to find one successful blast endpoint is treated as a failed broadcast even though other endpoints may have accepted the transaction but not returned a usable response. Reconcile by transaction hash and nonce before retrying.
- Receipt watching uses one selected hash and does not show durable replacement or reorg history. A production execution record must retain all attempts and reconcile by nonce/from/to/value/data.
- Dry-run consumes local nonces and reports wallet status as `success`, which can mislead operators and make a dry run appear to have minted. Use an explicit dry-run result/state and do not mutate live nonce state.
- Job IDs use `Date.now()` and `Math.random()`. Use a collision-resistant ID and persist it before execution.
- Error logging includes raw error messages. Error normalization must redact secrets, calldata where appropriate, passphrases, and provider payloads before persistence or notification.
- There is no durable run record, approval snapshot, policy snapshot, transaction attempt ledger, or restart recovery in the engine. This belongs in the orchestrator/store boundary but is required before unattended operation.
- `getViemChain(4663)` has an empty RPC URL list and treats Robinhood as usable at the type level. The accepted evidence now supplies the chain policy, but implementation must configure sequencer-direct routing, staged finality, FREE-mint cost inputs, and explicit paid-mint blocking; execution must remain disabled until code/tests and durable readiness gates pass.

### `packages/engine/src/signer.ts`

- The local signer holds viem account objects in memory. `zeroize()` drops references but cannot guarantee that library-managed immutable strings, closures, buffers, or runtime copies are wiped. Treat this as a stopgap, minimize lifetime, and prioritize remote signing.
- Private keys are assembled as JavaScript strings and serialized into a JSON plaintext string before encryption. This is difficult to reliably zeroize. Use bounded buffers where possible and document the residual runtime risk.
- `fromFile()` does not visibly validate schema lengths, wallet/address correspondence, duplicate indices, or ciphertext limits before decryption. Add strict schema validation and denial-of-service bounds.
- `generateAndEncryptWallets()` writes the wallet file directly rather than using an atomic temporary file, restrictive Windows ACLs, and recovery-safe replacement. A crash can leave a partial artifact.
- The passphrase is supplied to the engine as a string and must not be logged, persisted, or placed in process arguments. The CLI must use secure input and a defined operator procedure.
- The file contains all encrypted private keys under one passphrase. This is materially better than a shared mnemonic but still has a fleet-wide decryption blast radius. Independent per-wallet key references and KMS-backed signing are the target.
- Import, backup, rotation, recovery, and audit procedures are not yet implemented.

### `packages/engine/src/safety.ts`

- Spend counters are process-local, reset on restart, not scoped by chain/campaign/day boundary, and not durable.
- The tracker records actual spend only after receipt. It does not reserve maximum possible exposure before concurrent submissions.
- `recordSpend()` returns a boolean but the caller ignores it after recording, so a cap breach is observed but cannot reliably stop already-admitted concurrent work.
- Daily reset semantics and timezone/UTC boundary are absent.
- The file kill switch is useful but `existsSync` polling has no cross-process event model and does not cancel already-issued promises. Preserve it as a primitive, not the complete safety system.
- A safety reset is available publicly for testing. Ensure production paths cannot accidentally expose or invoke reset.

These findings are implementation blockers for live capital, not reasons to abandon the architecture.

## 10. Target Architecture

### Boundaries

1. **CLI:** validates operator input, renders typed states, starts dry runs by default, and never becomes the source of truth.
2. **Orchestrator:** owns scheduling, job admission, durable state transitions, recovery, notifications, and API parity. It never signs.
3. **Store:** owns durable entities, event log, spend reservations/ledger, approval snapshots, transaction attempts, and idempotency keys. SQLite in WAL mode is appropriate at personal scale if backup and concurrency behavior are tested.
4. **Engine:** owns strategy-driven validation/calldata, signing interface calls, chain-aware broadcast, nonce/receipt lifecycle, and per-wallet execution. It knows nothing about Telegram, dashboard, or database implementation.
5. **Signer:** returns signatures through `sign(walletId, immutableTxIntent)` or equivalent. Local encrypted signing is Phase 1 stopgap; KMS/HSM or TPM-backed signing is the end state.
6. **Strategies:** own protocol-specific read, calldata, gas, and validation behavior. SeaDrop v1 public is first. Raw calldata must remain explicitly warned and gated.
7. **Broadcasters:** Flashbots/private relay for Ethereum by default; Base and Robinhood 4663 use chain-specific sequencer-direct routing when enabled; blast/public fallback only where the chain profile supports it, with outcome reconciliation. Robinhood has no Flashbots/private-orderflow path.
8. **Discovery/intelligence:** observes and scores only. It cannot submit transactions or bypass campaign creation.
9. **Read model/UI:** renders Store state, never infers authoritative success locally. Future web controls call bounded backend transitions.

### Chain-specific policy records

The chain profile must persist routing mode, verification/evidence reference, gas model, and finality model. Ethereum retains Flashbots as the primary L1 route with blast/public fallback. Robinhood 4663 uses its dedicated sequencer endpoint with Arbitrum Nitro FCFS routing, not fee-based ordering or private bundles. Its FREE-mint reservation records `value = 0`, separate worst-case `l2_execution_gas` and `l1_data_gas`, and a priority-fee policy component bounded to `2x` configuration, with zero accepted. Paid-mint policy is a hard block until Product Owner approval is recorded.

### Minimum durable entities

Implement the PM domain model: chain profiles, wallets/key references, wallet groups, tracked wallets, contracts, collections, drops, campaigns, fire lanes, opportunities, signals, eligibility, transactions, executions, gas strategies, spend policies, portfolio positions, performance metrics, notifications, and audit events.

Every monetary movement must link to an execution or funding transaction. No key material enters the domain model. Every transition records actor/source, timestamp, reason, policy version, and evidence snapshot where relevant.

### Execution contract

The live path is:

```text
resolve target → read and validate drop → select wallets → reserve worst-case spend
→ preflight balances and eligibility → simulate each required wallet/class
→ validate freshness → prewarm and calibrate → explicit arm/approval
→ chain-time trigger → kill/cap admission checkpoint per wallet
→ sign immutable intent → broadcast through chain profile
→ reconcile attempts and receipts → confirm/reorg reconcile
→ settle spend → zeroize → publish immutable report
```

No unvalidated transaction enters the signing path. No network read should be added to the T-0 hot path unless its latency and failure semantics are deliberately accepted by the chain profile.

## 11. Phase-Aligned Engineering Plan

### Phase 1: Trustworthy Execution Core

- Anvil mainnet-fork tests against a live SeaDrop public drop, including time warp and fleet assertions.
- Revert, sold-out, price drift, insufficient funds, per-wallet cap, replacement, reorg, and mid-fleet kill scenarios.
- Complete CLI: wallet generation/list/fund, `mint --dry-run`, live `mint run`, health, kill, summary.
- Fix signer boundary, per-wallet simulation, reservation-safe caps, typed error taxonomy, and no-secret logging.
- Add chain-time/NTP offset tracking and a real warmup loop.
- Preserve Ethereum Flashbots/private-bundle routing and Base sequencer-direct routing. Implement Robinhood 4663 as Arbitrum Nitro FCFS sequencer-direct routing with no Flashbots/private-orderflow path; prove the positive SeaDrop-v1 fixture, gas decomposition, staged finality, and recovery behavior in integration tests before enabling it.
- Keep Robinhood production execution disabled until all code, fork/integration, durable safety, and operational gates pass. Block paid Robinhood mints; allow only a separately tested FREE-mint policy with zero value, independent L2/L1 gas reservations, and a priority-fee component capped at 2x configuration.
- Conduct a smallest-value mainnet dress rehearsal only after all gates pass.

### Phase 2: Operational Shell

- Persistent scheduled jobs and an idempotent event/command model.
- Boot reconciliation for every in-flight transaction before accepting new work.
- Store schema, encrypted-keystore backup/restore drill, rotation procedure, and WAL durability tests.
- One-way Telegram notifications with recorded delivery state and canonical run links.
- Endpoint latency/error metrics, process health, disk/log rotation, and Telegram alerting.

### Phase 3: Controlled Multi-Wallet Operations

- Campaign and fire-lane state machines.
- Manual arm/approve workflow with immutable policy/evidence snapshot and typed live confirmation.
- Eligibility calendar and readiness matrix.
- Adaptive stops and bounded per-wallet retries.
- Two-way Telegram commands only after authentication, scoped confirmation, replay protection, and consequence copy are implemented.

### Phase 4: Intelligence And Qualified Replication

- Tracked-wallet registry and reorg-aware ingestion.
- Opportunity deduplication, evidence collection, deterministic scoring v1, confidence/sample-size display, and freshness policy.
- Replication decoder and strategy matcher with explicit `replicable`, per-wallet-parameter, `msg.sender`-dependent, nonce-dependent, and `not_replicable(reason)` states.
- No automatic execution from score alone; operator approval remains required.
- OpenSea private API only behind a feature flag, server-side credentials, degradation behavior, and a fragility budget.

### Phase 5: Analytics And Feedback

- FIFO EVM lot ledger with gas and fees.
- Realized/unrealized separation, floor source/freshness, data coverage, and manual ground truth tests.
- Attribution by wallet, campaign, project, signal source, and gas strategy.
- False-positive ledger and versioned deterministic weight recalibration.
- Full dashboard only after durable state and meaningful outcome data exist.

## 12. PM/Design Alignment Flags

Flags are intended to prevent silent contradictions. Each has an owner and resolution rule.

### FLAG-001: “Built” engine versus live readiness

**Status:** Blocking. `PRODUCT_SPEC.md` calls the engine built but untested against a fork. Current code also has cap, simulation, signer, and kill admission defects. **Resolution:** interpret “built” as scaffolded implementation only; Phase 1 exit criteria remain mandatory before live capital.

### FLAG-002: Product design artifact location

**Status:** Documentation. The design handoff exists in a separate worktree, not this branch. **Resolution:** merge/copy the approved artifact through the normal workflow before frontend implementation; do not recreate a divergent design spec.

### FLAG-003: Approval versus arm

**Status:** Must resolve before Phase 3. `Approve` must create/promote a proposal or authorize a frozen campaign; `ARM LIVE CAMPAIGN` authorizes bounded future spend. They are separate records and controls. **Resolution:** adopt the design recommendation: promotion never broadcasts, and live arm requires an explicit typed campaign identifier.

### FLAG-004: Telegram command consequence

**Status:** Must resolve before two-way Telegram. `/approve` must say whether it authorizes preparation only or firing at the configured trigger. **Resolution:** require a second explicit live-spend confirmation and show scope, caps, simulation age, and consequence in the confirmation response.

### FLAG-005: Phase 1 dashboard language

**Status:** Scope guard. PM material describes future dashboard flows while defining a CLI-only MVP. **Resolution:** CLI is the Phase 1 operator surface; do not implement web routes, opportunity feed, calendar, or analytics early.

### FLAG-006: Robinhood evidence versus execution enablement

**Status:** Evidence accepted; implementation gate remains blocking. The accepted evidence establishes chain 4663 as an Arbitrum Nitro FCFS sequencer network with no public mempool or Flashbots/private-orderflow route, and includes the positive SeaDrop-v1 fixture `0xf24e0c85f6f4fa71d012b6ffbfbc871b901fb1e949635799d1821716013d891e` for NFT `0x45ce024f314a2f74c63a8a51743677df97a8d99e` and wallet `0x81c104DcB898416FD4f81eAd091DbA5b8f46F37A`. The earlier report wording that SeaDrop was “not yet empirically confirmed” conflicts with that accepted positive fixture; this brief treats the fixture as positive compatibility evidence while retaining the engineering enablement gate. External failed transaction hashes remain documentation-only and must not be attributed to the approved wallet fleet. **Resolution:** registry may expose the accepted characterization, but execution remains `blocked` until code/tests prove dedicated sequencer-direct submission, FREE-mint fee accounting, staged finality, durable reconciliation, and safety gates. Paid Robinhood mints remain blocked.

### FLAG-007: Simulation freshness and scope

**Status:** Blocking. PM requires simulation per wallet class; current code simulates one wallet. **Resolution:** define max age and checkpoint rules, persist result/source block, and test per-wallet behavior where state can differ.

### FLAG-008: Score and safety gate semantics

**Status:** Locked. Design correctly states that scores express desirability and gates express permission. **Resolution:** represent them as separate typed fields in APIs, records, CLI output, and future UI. No override may bypass a hard safety gate.

### FLAG-009: “Expected profitability” wording

**Status:** Product-risk. A floor is not a sale. **Resolution:** use `floor-marked estimate`, show source/time/assumptions, and omit it where coverage is insufficient. Analytics must publish definitions and denominators.

### FLAG-010: Confidence baseline `N0`

**Status:** Data contract gap. The scoring formula references `N0` without defining it. **Resolution:** PM/data owner versions a value before score UI; until then display sample coverage, not calibrated probability.

### FLAG-011: Failed versus aborted

**Status:** State contract. **Resolution:** `Failed` means technical/execution completion failure; `Aborted` means kill, cap, or adaptive stop ended remaining work. Preserve partial results in both cases.

### FLAG-012: Calendar authority

**Status:** Reliability gap. A stale manually maintained calendar cannot prevent missed mints. **Resolution:** store source, last verification, phase evidence, and only escalate eligible + verified + opening-soon entries.

### FLAG-013: Retry semantics

**Status:** Safety gap. Replacement, reorg, and nonce retries are not universally safe. **Resolution:** backend marks retryability from typed state; UI/Telegram expose retry only when the persisted policy permits it.

### FLAG-014: Store technology

**Status:** Decision required. SQLite is appropriate for personal scale but needs WAL, backup, locking, corruption, and restart tests on Windows and the always-on host. **Resolution:** use SQLite unless those tests fail; do not build against process-local counters.

### FLAG-015: KMS end state

**Status:** Decision required before material capital. Envelope encryption is a stopgap, not host-compromise isolation. **Resolution:** select cloud KMS, TPM-backed storage, or hardware signer and prove interface compatibility with the engine before increasing budgets.

### FLAG-016: Funding graph privacy

**Status:** Explicit tradeoff. Hub funding clusters wallets. **Resolution:** record that it is acceptable for personal operations or design egress diversity if privacy is a real requirement; never claim anonymity.

### FLAG-017: Confirmation depth

**Status:** Empirical requirement. L1=2 and L2=1 are defaults, not facts. **Resolution:** measure reorg/finality behavior and version chain policies; preserve `reorged` transitions.

### FLAG-018: Robinhood fee and finality policy

**Status:** New implementation contract. Ethereum's EIP-1559/Flashbots policy must not be copied to Robinhood. **Resolution:** for FREE mints, set value to zero; reserve L2 execution gas and L1 data gas independently at worst-case ceilings; cap the priority-fee policy component at `2x` its configured component, including valid zero; and model soft confirmation, Ethereum batch posting, and Ethereum finality as separate states. Use durable atomic reservations and reconciliation across every process boundary.

### FLAG-019: Accepted evidence is not live enablement

**Status:** Release gate. The accepted Robinhood report, positive SeaDrop fixture, and Product Owner auto-execution approval in principle are evidence/policy inputs, not a production-live declaration. **Resolution:** do not label 4663 execution live or enable it in defaults until implementation, Anvil/integration tests, safety/reconciliation tests, dedicated-endpoint correlation, and an operational rehearsal pass. Auto-execution approval does not override the residual gates; paid mints remain blocked. The report's accepted status must not override the engineering definition of done.

## 13. Definition Of Done For Core Architecture

The architecture is acceptable only when all of the following are true:

- A fork test proves a multi-wallet SeaDrop public mint and its principal failure modes.
- No live execution can proceed without valid chain, target, timing, funding, spend reservation, simulation, and explicit mode/arm state.
- The engine cannot access raw key material through its public contract.
- A kill event blocks every not-yet-admitted spend and produces a truthful partial result.
- A crash after any submission can reconcile the outcome without duplicate spending.
- Caps are durable, atomic, chain-aware, and enforced against pending exposure.
- Every transaction has immutable intent, all broadcast attempts, authoritative hash/receipt state, gas, and typed errors.
- Reorgs downgrade state and reconcile accounting rather than silently remaining confirmed.
- Robinhood refuses execution until the accepted characterization is implemented and all code, integration-test, durable safety, reconciliation, and operational readiness gates pass; accepted evidence alone cannot enable live execution.
- Robinhood FREE mints enforce zero value, independent L2/L1 gas reservations, and the bounded priority-fee policy; paid mints remain blocked.
- Dry runs cannot be mistaken for live mints in CLI, logs, store, or Telegram.
- No secret, compromised provider credential, mnemonic, vanity key, or unaudited sponsor contract enters the product.
- Future UI and Telegram controls map to the same canonical state machine and never become the security boundary.
- Analytics make no unsupported profitability claim and are disabled as an execution authority.

## 14. Final CTO Position

Build a small, test-heavy execution operating system first, not a thin bot fork and not a dashboard that implies intelligence it does not yet possess. The implementation should be boring at the boundaries: immutable intents, explicit gates, typed state, durable records, measured timing, isolated signers, and deterministic recovery.

The first release succeeds if it can safely refuse a bad mint, execute a validated public mint across independent wallets, survive endpoint failure and restart, explain every outcome, and bound the worst-case loss. Intelligence, replication, and analytics should earn their authority from recorded evidence. Profitability is an empirical result to measure, not a feature to promise.
