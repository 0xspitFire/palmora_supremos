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

Own chain facts and engine chain-facing modules. Do not own application schema, scheduling, Telegram, dashboard, deployment, or product scoring. Never bypass the `Signer` interface or replace durable Backend/Database admission with an in-memory check.

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
- Seven canonical fork tests currently skip without approved Anvil fixtures; this is not passing evidence.

## 2026-09-14 Gate 3 refinements

- Live execution requires a normalized durable reservation provider and durable run, campaign, execution, and transaction-intent identity. Dry-run preparation may remain side-effect free and local.
- Persist the intent before signing and persist a signed/provider attempt before broadcast. Transport failures retain the deterministic transaction hash as ambiguous evidence rather than releasing the reservation.
- Reconcile by transaction hash and sender nonce. A different hash at the same nonce is a replacement; a missing receipt alone is unresolved until a chain observation proves drop or reorg.
- Treat Ethereum receipt success as product success only at the configured settlement stage. Robinhood characterization preserves Included/soft and Posted observations without settling until Ethereum finality.
- Receipt-attempt linkage must use the exact successful endpoint attempt, not the last endpoint response in a multi-provider fanout.
- Receipt gas settlement separates authoritative total gas, priority component, and L1 data fee. Do not fabricate an L1 fee or count a priority component twice.
- Kill checks belong at simulation, admission/provider reservation, signing, broadcast, and provider-response boundaries. Signer decryption paths must scrub intermediate buffers and decrypted key references on success and failure.
