# Phase 2 Blockchain Read Model

This document defines the read-only source and freshness contract used by
`ChainFactsReader` and the Backend `mintbot.read-model` v1 projector. It does
not authorize signing, submission, broadcasting, private-key access, or
Robinhood execution enablement.

## RPC Requirements

The configured source is an opaque `sourceRef` label. RPC URLs, credentials,
provider tokens, and endpoint payloads must not be copied into read-model
responses or provenance.

Required read methods:

| Fact | JSON-RPC/read source | Required evidence |
| --- | --- | --- |
| Head | `eth_blockNumber`, `eth_getBlockByNumber` | block number; block hash when the provider supplies it; observation time |
| Discovery logs | `eth_getLogs` over an explicit `[fromBlock, toBlock]` range | address/topics, block number/hash, transaction hash, log index, removed flag |
| Drop/calendar | Existing `MintStrategy.readDrop` contract reads | strategy name/version, contract, source block number/hash, observation time, expiry |
| Wallet readiness | `eth_getBalance`, `eth_getTransactionCount`, optional `eth_getCode` | address, balance/nonce/code availability, source block, observation time |
| Receipt | `eth_getTransactionReceipt`, `eth_getBlockByNumber` at the receipt height | transaction hash, receipt status, block hash, gas fields, canonicality result |
| Ethereum finality | Ethereum head plus configured confirmation depth and canonicality probe | confirmation count, canonicality, required stage |
| Robinhood stages | configured read-only posting/finality probes behind `FinalityObserver` | `soft`, `posted`, or `ethereum_final`; Ethereum finality is the settlement stage |

Every provider call is read-only. A provider implementation must not expose or
invoke `eth_sendRawTransaction`, `eth_sendTransaction`, signer methods,
broadcasters, or private-key/keystore APIs through this boundary.

## Source And Freshness

Every `ChainFact` carries:

- `availability`: `available`, `partial`, or `unavailable`.
- `freshness`: `fresh`, `stale`, or `unknown`, calculated against an injected
  server clock and an explicit policy version.
- `provenance`: an opaque record ID, source label, observation time, and source
  block number/hash when known.
- `value: null` when a required read is unavailable. Missing values must never
  be converted to zero, `false`, or a successful gate.

The default policy in `engine/src/chain-facts.ts` is:

| Fact | TTL |
| --- | ---: |
| Head | 15 seconds |
| Logs | 30 seconds |
| Wallet | 30 seconds |
| Receipt/finality | 15 seconds |
| Drop/calendar | 5 minutes |
| Reorg evidence | 5 minutes for an operational view; retain history indefinitely |

Expiry is inclusive: `now >= expiresAt` is stale. Missing, malformed, or future
observation timestamps are unknown. A stale value can be displayed as a stale
value, but it cannot satisfy a readiness or execution gate. A partial wallet
fact cannot satisfy funding readiness. A failed canonicality probe is unknown,
not proof of a reorg.

The Backend v1 envelope repeats this model as `freshness`, `issues`, and typed
`GateCheck` values. Decimal quantities, balances, nonces, block numbers, and
gas values are serialized as decimal strings. `null` means unknown; it is not a
zero value.

## Finality And Receipts

Receipt inclusion and settlement are separate facts:

- Ethereum receipts may be `confirmed` as included while finality remains
  pending until the configured confirmation depth is met.
- Robinhood `soft` and `posted` are operational milestones only.
- Robinhood `ethereum_final` is the only settlement stage and must be
  canonical. Characterization of chain ID `4663` never enables paid or live
  execution.
- A reverted receipt is never settlement-ready.
- Missing receipts are `RECEIPT_NOT_FOUND`; they are not inferred as dropped,
  reverted, or reorged.
- A canonicality probe with no source hash returns `canonical: null`,
  `stage: unknown`, and `ready: false`.

Receipt observations are append-only. `appendReceiptObservation` preserves
prior values. A reorg fact is emitted only when a previously canonical receipt
is subsequently observed at a non-canonical block. A missing later receipt or a
provider error remains unresolved until canonical replacement evidence exists.
Reorg history must remain visible to run, receipt, accounting, and audit
projections; it must not be overwritten by the replacement attempt.

## Projection Boundaries

`Phase2ReadModelService` consumes a captured `BackendState` snapshot and has no
RPC or mutation dependency. It provides the versioned envelope for home,
opportunities, calendar, campaign wallet readiness, runs, alerts, and health.

- Discovery and calendar without authoritative observations return an explicit
  source issue and partial availability rather than fabricated empty success.
- Wallet eligibility, balance, simulation, and reconciliation are independent
  checks. Unknown eligibility is not ineligible; stale simulation is not a
  failed simulation.
- Attempt calldata, endpoint URLs, approval proofs, secret references, and
  store paths are not projected.
- Retry policy is denied by default. Reorged or unresolved submissions require
  reconciliation before any retry or accounting conclusion.
- Read-model snapshots use an injected request ID, captured time, consistency,
  and deterministic state digest so fixtures and consumers can reproduce a
  response.

## Unresolved Gates

The current read model is intentionally fail-closed where Phase 2 persistence
is not yet supplied:

- A deployment must provide canonicality block-hash probes and the Robinhood
  posting/L1-finality sources before finality can become ready.
- Wallet balance and eligibility observations need durable source/expiry fields
  before funding and eligibility can move from unknown to pass.
- Discovery/calendar producers must append normalized observations before
  opportunities or schedules can be treated as authoritative.
- Robinhood evidence remains inspection-only; separate approved safety evidence
  and an explicit policy change would be required for any future execution
  path, which is outside this phase.
