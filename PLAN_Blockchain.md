# Blockchain Engineering Plan

## Mandate

Own EVM correctness from chain discovery through transaction lifecycle. The engine remains strategy- and broadcaster-driven; it does not know about Telegram, the UI, or database implementation. Phase 1 is Ethereum and Base execution after hardening. Robinhood Chain (4663) is `unverified` and execution-blocked until its characterization spike passes.

## Authority and boundaries

- PM defines product scope and the Phase 1 exit criteria.
- Product Design defines canonical operator states; blockchain outputs must map to them without inventing success states.
- CTO defines clean-room implementation, viem, SeaDrop-v1-public first, private L1 orderflow, sequencer-direct L2 routing, setup-time simulation, and the signer boundary.
- Backend owns orchestration, persistence, readiness aggregation, and retry permission. Blockchain owns facts, construction, simulation, submission, receipt/reorg semantics, and typed technical failures.

## Phase 1 work order

1. Establish chain profiles for Ethereum (1), Base (8453), and an explicit unverified 4663 entry. Validate chain ID, endpoint identity, L2/sequencer behavior, gas model, and confirmation policy at startup.
2. Refactor `packages/engine` so all signing goes through `Signer.signTransaction`; remove all `getAccount()` or raw-key access from execution paths.
3. Make simulation and gas estimation per wallet or proven wallet class. Persist source block, checked-at time, inputs, result, and typed revert information. A single funded-wallet simulation must never authorize a fleet.
4. Define immutable transaction intent: chain, from, to, value, calldata, nonce, gas limit, fee policy, campaign/run identity, and policy/evidence references. Signing accepts only this intent.
5. Implement admission checkpoints immediately before reservation, signing, and broadcast. Coordinate kill cancellation with sequential admission decisions; already-submitted transactions remain observable and cannot be recalled.
6. Replace process-local spend checks with a store-provided reservation interface. The blockchain adapter must receive an approved reservation and settle actual gas/value after reconciliation, not decide caps itself.
7. Make broadcast attempts hash/nonce aware. Persist every endpoint response, including timeout and `already known`; reconcile by `(from, nonce)` and transaction hash before replacement or retry.
8. Track all replacement hashes and receipt transitions. Confirmation is chain-profile-specific; support `pending`, `confirmed`, `reorged`, `replaced`, and `failed` without erasing history.
9. Correct dry-run behavior: no signing or broadcast, no live nonce mutation, and explicit `Prepared`/dry-run results rather than `success` or `Minted`.
10. Add a real connection-warmup loop and chain-time offset measurement. Local wall clock is never the sole T-0 authority.

## Strategy and contract resolution

- `MintStrategy` owns `readDrop`, `buildCalldata`, `estimateGas`, and `validateDrop`; no contract-specific branches in the engine.
- SeaDrop v1 public is first. Verify deployment, active phase, supply, price, per-wallet limit, fee recipient, selector, calldata, and value. Preserve byte-identical `mintPublic(..., address(0), quantity)` behavior.
- `RawCalldataStrategy` is Phase 2, explicit operator input with selector sanity, decoding for display, warnings, simulation, caps, and no semantic guarantee. It is not a safety bypass.
- Manifold, thirdweb, and custom strategies are Phase 4 and require independent fixtures. Unknown or SeaDrop-v2 targets fail with typed `strategy-not-found`, never guessed calldata.
- Contract resolution must represent verified, unverified, proxy, dynamic, and custom contracts. ABI absence is an uncertainty state, not permission to infer.

## Eligibility and replication

Represent eligibility with campaign, phase, wallet, proof/source, source block, timestamp, expiry, and reason. Support Merkle proofs, allowlists, signed claims, allocation limits, and contract-level checks as strategy capabilities.

Replication is Phase 4 only. Decode selector and arguments, match a known strategy, retain per-field provenance, then classify `replicable`, `needs_per_wallet_params`, `msg_sender_dependent`, `nonce_dependent`, or `not_replicable(reason)`. Merkle proofs, signatures, wallet-bound arguments, and sender-dependent logic normally block replay. Only a reconstructed, simulated, operator-approved plan can become a campaign.

## Monitoring and gas

- Phase 1 uses receipt and endpoint health monitoring, not opportunity discovery or mempool-triggered execution.
- Later monitoring must document source, latency, ordering limits, missed-event behavior, reorg handling, and a backfill fallback before activation.
- Use a `GasStrategy` abstraction. Default is a prepared generous `maxFeePerGas` cap with competition via priority fee; no T-0 base-fee refresh. Support bounded same-nonce replacement ladders.
- Ethereum defaults to Flashbots/private orderflow with measured public fallback. Base uses verified sequencer-direct with blast fallback. Do not describe either as guaranteed inclusion.

## Robinhood characterization spike

Before enabling 4663, record chain ID, stable RPC/sequencer endpoints, propagation and mempool visibility, bundle/private-orderflow support, gas/EIP-1559 semantics, confirmation/reorg behavior, 7702 status, and a live SeaDrop-v1 public-drop test. Until the report is accepted, configuration may inspect the chain but execution must refuse it.

## Tests and definition of done

- Anvil fork CI: >=3 wallets, time warp, SeaDrop happy path, revert, sold-out, price drift, insufficient funds, per-wallet limit, replacement storm, reorg, and mid-fleet kill.
- Unit tests cover calldata bytes, contract reads, chain routing, typed revert decoding, gas policy, nonce isolation, dry-run, and signer non-access.
- Leak-regression tests prove no key bytes in logs/errors/serialization and zeroization is invoked on success and failure. Document runtime limitations of JavaScript memory.
- Blockchain work is complete only when every live path is gate-checked, per-wallet simulation is recorded, attempts/replacements are reconstructable, reorgs reconcile, and 4663 remains blocked without evidence.

## Challenges and decisions

- “Built engine” means scaffolded, not live-ready; current audit blockers are mandatory fixes.
- L1 latency claims are orderflow/inclusion measurements, not universal latency SLAs.
- Simulation is necessary but not a complete malicious-contract proof; retain allowance/value/recipient checks and small burner budgets.
- Validate L1=2 and L2=1 confirmation defaults empirically; version profiles rather than treating them as facts.
- KMS/HSM/TPM signing is the end state. Envelope-encrypted local signing is a Phase 1 stopgap with minimized key lifetime.

## Dependencies and outputs

Inputs: immutable campaign/transaction intent, chain configuration, wallet public identity, strategy request, reservation token, and signer interface.

Outputs: drop facts, preparation and simulation records, typed blockchain errors, broadcast attempts, receipt/reorg events, endpoint metrics, and per-wallet execution facts. Backend/store remain authoritative for lifecycle persistence and safety policy.
