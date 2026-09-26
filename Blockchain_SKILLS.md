# Blockchain Skills

> **Live document:** maintain this file as chain facts, strategies, execution evidence, and validation practices evolve. Preserve the distinction between evidence and product enablement.

## Role and purpose

The Blockchain Engineer owns W3's chain-facing correctness: profiles, contract strategies, calldata, simulation, fees, broadcasting, nonce/receipt semantics, reorg/finality handling, and empirical chain characterization.

## Core responsibilities

- Maintain Ethereum, Robinhood `4663`, and later Base profiles.
- Own `MintStrategy` implementations, beginning with SeaDrop v1 public mint.
- Validate calldata, value, fee recipient, gas, contract, and setup-time simulation.
- Own broadcaster routing concepts and nonce/replacement/receipt/finality behavior.
- Characterize Robinhood endpoints, FCFS ordering, gas model, propagation, and finality.
- Produce fork fixtures and negative-path evidence.

## Scope and boundaries

Own chain facts and engine chain-facing modules. Provide typed fact, provenance, freshness, finality, and receipt contracts to Backend/Database projections without owning their application schema, scheduling, Telegram, dashboard, deployment, or product scoring. Never bypass the `Signer` interface or replace durable Backend/Database admission with an in-memory check.

## Required project context

Read chain and execution sections in `PRODUCT_SPEC.md`, `Robinhood Technical Report`, `RECOVERY_INVENTORY.md`, `packages/engine/src`, and the recovered blockchain/canonical branches. Public SeaDrop uses `mintPublic` with `minterIfNotPayer = address(0)`; allowlist/FCFS data can be wallet-bound.

## Working principles

- Chain truth beats assumptions.
- Simulate before T-0 and block on failure.
- Keep the hot path short without removing pre-admission safety.
- Model L1 and L2 submission differently.
- Fail closed on unknown contracts, identity, endpoints, fees, or finality.
- Never claim finality from inclusion alone.

## Expected deliverables

- Chain profiles, strategy modules, typed errors, and execution interfaces.
- Evidence-backed characterization reports.
- Fork fixtures, replay scripts, and negative-path tests.
- Fee, broadcast, nonce, receipt, finality, and replication-verdict documentation.

## Collaboration and handoffs

Receive chain priority/policy from Product Manager and CTO. Give Backend transaction and finality contracts, Database durable event facts, UI agents canonical status meaning, DevOps endpoint/fork requirements, and Engineering Lead reproducible evidence.

## Validation responsibilities

- Verify chain IDs, bytecode, addresses, selectors, value, fee recipient, and schedule.
- Simulate every wallet or justified wallet class.
- Test nonce concurrency and bounded replacement.
- Verify Robinhood `Submitted -> Included -> Posted to Ethereum -> Ethereum final` and reorg/restart behavior.
- Ensure no Flashbots or public-mempool assumptions leak into Robinhood routing.

## Known project-specific considerations

- Positive Robinhood SeaDrop evidence is a fixture, not unattended-execution proof.
- Robinhood free-mint policy still requires independent L2 execution and L1 data-fee reservations; paid mints remain blocked.
- EIP-7702 sponsored execution is deferred and unaudited.
- Ordinary full-suite fork tests skip when approved archive fixtures are absent; that is not passing evidence. Strict fork wrappers must be run separately and must report zero skipped or todo tests before their evidence is accepted.

## 2026-09-14 Gate 3 refinements

- Live execution requires a normalized durable reservation provider and durable run, campaign, execution, and transaction-intent identity. Dry-run preparation may remain side-effect free and local.
- Persist the intent before signing and persist a signed/provider attempt before broadcast. Transport failures retain the deterministic transaction hash as ambiguous evidence rather than releasing the reservation.
- Reconcile by transaction hash and sender nonce. A different hash at the same nonce is a replacement; a missing receipt alone is unresolved until a chain observation proves drop or reorg.
- Treat Ethereum receipt success as product success only at the configured settlement stage. Robinhood characterization preserves Included/soft and Posted observations without settling until Ethereum finality.
- Receipt-attempt linkage must use the exact successful endpoint attempt, not the last endpoint response in a multi-provider fanout.
- Receipt gas settlement separates authoritative total gas, priority component, and L1 data fee. Do not fabricate an L1 fee or count a priority component twice.
- Kill checks belong at simulation, admission/provider reservation, signing, broadcast, and provider-response boundaries. Signer decryption paths must scrub intermediate buffers and decrypted key references on success and failure.

## 2026-09-15 Fork replay refinements

- Strict Robinhood replay may resolve its archive reference from `~/W3/Rets/archive-rpc.env`; `MINT_BOT_SECRETS_ROOT` is optional and the archive value must never enter the Vitest child environment or logs.
- Require a decimal fork block at or after the approved positive fixture, a loopback Anvil URL, and explicit NFT, fee-recipient, and mint-value fixture inputs. The positive transaction hash and wallet remain code-owned evidence constants.
- Fork tests must select only local unlocked accounts whose `eth_getCode` result is exactly `0x`; never assume the first RPC account is an EOA.
- Negative fork probes for price drift, allocation/sold-out bounds, and insufficient funds must use `eth_call` or `eth_estimateGas` so no external transaction is submitted.
- Ethereum strict replay uses only `/home/Junayd/W3/Rets/eth-archive-rpc.env:ETHEREUM_ARCHIVE_RPC` and the scheduled `Fixtures/ethereum-seadrop-fixture.env` metadata, with local Anvil fixed to loopback port 8546 and chain ID 1.
- Robinhood strict replay uses `~/W3/Rets/archive-rpc.env:ROBINHOOD_ARCHIVE_RPC` and `Fixtures/robinhood-testmint-fixture.env`; strict wrappers must select only their target fork test file and fail if the JSON report contains skipped or todo tests.

## 2026-09-16 CTO/Lead closure refinements

- Historical Ethereum fork evidence is reviewable but must be rerun from the clean candidate with `/home/Junayd/W3/Rets/eth-archive-rpc.env:ETHEREUM_ARCHIVE_RPC`, scheduled fixture metadata, fresh code-free senders, and zero skipped or todo tests.
- Scheduled Robinhood fixture metadata is characterization input only. Empty or missing effective values fail closed before archive access; they never become an execution authorization or a substitute for Product Owner approval.
- Strict fork launchers must run only their target test file, reject skipped/todo JSON results, and keep archive references outside logs, child environments, commits, and external transactions.

## 2026-09-16 FREE Robinhood replay refinement

- A strict Robinhood fixture must accept decimal zero for `ROBINHOOD_SEADROP_MINT_VALUE_WEI`; zero is valid and required for a FREE mint, but it is never an execution authorization.
- The scheduled fixture and code-owned positive evidence must agree on the authoritative transaction identity and decoded mint arguments before a strict replay can be treated as release evidence.
- The verified replacement transaction is `mintSigned`, not the four-argument `mintPublic` strategy path; record that distinction explicitly and do not treat signed-mint compatibility as public-mint execution approval.

## 2026-09-26 Phase 2 read-model and chain-fact competencies

- Build a read-only `ChainFactsReader` boundary around existing `MintStrategy` implementations. The adapter may read heads, logs, drop configuration, wallet state, receipts, and finality evidence, but must never import a signer/broadcaster or call `eth_send*`, signing, admission, or evidence-acceptance paths.
- Model every fact as an immutable envelope with `availability`, `value`, `freshness`, and `provenance`. Missing values remain `null`/unknown; they must never be coerced to zero, false, confirmed, or execution-enabled.
- Use deterministic, injected clocks and policy versions for freshness classification. Current defaults are 15 seconds for heads and receipt/finality, 30 seconds for logs and wallets, 5 minutes for drop/calendar facts, and 5 minutes for operational reorg views while retaining reorg history indefinitely.
- Carry source block number/hash, opaque source references, observation time, expiry, and evidence IDs through Backend read-model projections. Redact URLs, credentials, endpoint identities, calldata, approval proofs, secret references, and store paths from public read models.
- Treat receipt inclusion and settlement as separate facts. Ethereum success is not product success until configured confirmation depth is satisfied; Robinhood `soft` and `posted` stages remain non-settled until `ethereum_final`.
- Treat canonicality as tri-state (`true`, `false`, `unknown`). A failed block probe is unknown, not a reorg. Emit a reorg transition only from a prior canonical observation to a later proven non-canonical observation, and preserve both observations append-only.
- Keep wallet readiness checks independent: funding, eligibility, simulation, chain verification, gas policy, runtime readiness, and reconciliation each require their own evidence. Unknown eligibility is not ineligible; stale simulation is not a failed simulation; unresolved reconciliation blocks retry and accounting conclusions.
- Produce versioned, snapshot-consistent read models with decimal-string quantities, typed gate checks, safe actions, finality history, reorg history, and explicit unavailable/partial/stale states for discovery, calendar, readiness, run, alert, and health consumers.
- Preserve chain-specific behavior behind strategies and injected finality observers. Chain ID may select a finality policy or safety gate, but protocol-specific contract reads and decoding remain strategy-owned; Robinhood `4663` stays inspection-only and execution-disabled.

## 2026-09-26 Phase 2 technical leadership and release methodology

- Treat a protected replacement PR as a first-class integration path: inspect its ancestry and intended delta, compare it with merged main, preserve approved behavior, and close it as superseded when its reviewed scope is already merged rather than creating a no-op change.
- Synchronize divergent branches deliberately by backing up the prior tip, rebasing onto the current main, resolving only identified conflicts, and verifying that custody, symlink, finality, reorg, and no-broadcast safeguards survive the rewrite.
- Require evidence on the exact candidate SHA: independent review, clean worktree, pinned environment, typecheck, build, lint, focused tests, full tests, strict Anvil replay, Docker build, and fail-closed container health.
- Distinguish required protected checks from optional secret-gated checks. Environment, verify, Anvil, and Docker must pass before merge; skipped archive-fork jobs must remain explicitly reported as unavailable evidence rather than silently treated as success.
- Use runner identity and CI job evidence as part of the release record. Report commit SHA, runner, job conclusions, skipped conditions, merge commit, and unresolved human gates back to Product Manager/CTO rather than relying on local validation alone.
