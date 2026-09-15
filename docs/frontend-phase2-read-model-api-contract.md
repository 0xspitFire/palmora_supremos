# Phase 2 Read-Model/API Contract Proposal

> Contract document version: `0.1.0-proposal`
> Wire contract namespace: `mintbot.read-model/v1`
> Status: proposed, not implemented
> Date: 2026-09-14
> Consumer owner: Frontend
> Authoritative owners: Backend and Database, with Blockchain/CTO status truth

## 1. Decision Summary

This document proposes the versioned, read-only contract that a future Phase 2
web client may consume. It is an API/read-model handoff, not a web
implementation. It does not add routes, a browser execution surface, browser
RPC access, a signer, key access, secret access, transaction construction, or
any client-side safety override.

The Backend/store remains authoritative for every fact. The client renders the
projection and may not infer eligibility, readiness, spend, success, finality,
retryability, or permission from other fields. Phase 1 remains CLI-only and
this proposal is not an authorization to start Phase 2 UI work.

The contract has these non-negotiable properties:

- Every amount is a validated decimal base-unit string with an explicit asset,
  unit, and decimal scale. JavaScript floating-point numbers are never used
  for money, gas, caps, reservations, or PnL-like values.
- Every important fact carries observation time, expiry/freshness, and
  provenance. Server time and persisted source blocks are authoritative.
- Readiness is a per-wallet, per-campaign decision with typed checks and
  blockers. `Unknown`, `Ineligible`, `Blocked`, and `Stale` are distinct.
- Desirability scores and permission/safety gates are separate fields. A high
  score never enables an action.
- Retryability is a backend policy result, never a client guess. Unknown
  outcomes do not receive a generic retry action.
- Robinhood finality is staged. `Included` and `Posted to Ethereum` are not
  success; success is shown only at `Ethereum final`.
- `Reorged`, `Aborted`, `Cancelled`, `Failed`, and unresolved `Unknown` remain
  distinguishable and preserve partial results.
- Missing, stale, blocked, or unavailable data is rendered safely. The client
  never substitutes zero, false, success, or a usable action for missing data.

## 2. Phase Boundary and Authority

### In scope for this proposal

- Read-only projections for the future Phase 2 intelligence, readiness,
  calendar, reminder, alert, and operational-status views.
- A future read-only run/transaction projection so staged finality and recovery
  can be displayed without making the web client an execution engine.
- Stable wire names, versioning, amount serialization, provenance, freshness,
  blocker, retry, finality, reorg, abort, and redaction rules.
- Contract acceptance criteria and Backend/Database dependencies.

### Out of scope

- React, routes, components, CSS, browser state management, or UI tests.
- `POST`, `PATCH`, `DELETE`, arm, approve, execute, pause, kill, retry, or
  transaction-submission endpoints.
- Browser RPC, wallet-provider injection, signer access, private keys,
  mnemonics, passphrases, raw transactions, calldata, or provider credentials.
- Client-side chain reads, client-side simulation, client-side eligibility,
  client-side scoring, or optimistic success.
- Enabling Robinhood or paid mints. Robinhood execution remains blocked until
  the separate integrated release gates pass; paid Robinhood mints remain
  blocked pending an explicit value/exposure policy.

### Authority rule

The Backend API reads an authoritative Store snapshot. The UI must not read the
database directly, call a chain endpoint, or combine records from different
snapshots. A response may be partial or stale, but it must say so. An API
response, Telegram message, browser cache, or local optimistic state is not
transaction truth.

## 3. Versioning and Transport

- The document version is `0.1.0-proposal` until Lead, Backend, Database,
  Product, and Blockchain/CTO owners accept it.
- The wire namespace is `mintbot.read-model/v1`; every response includes both
  `contract` and `version`.
- Additive fields are allowed within `v1` when their absence has a defined
  default. Renaming a field, changing an enum meaning, changing amount units,
  or changing a terminal-state meaning requires `v2`.
- Unknown enum values must be preserved by the client as an unknown status and
  must not be treated as success or permission.
- All timestamps are RFC 3339 UTC strings. The server calculates age and
  expiry; the client does not rely on its local clock for freshness decisions.
- IDs, hashes, addresses, block numbers, nonces, and other chain quantities are
  opaque strings on the wire. A client must not parse them into JavaScript
  `number` values.
- The future transport is Backend-owned HTTP or an equally typed server
  transport. Phase 2 uses `GET` read operations only, with cursor pagination
  for collections. Authentication, origin policy, TLS, and deployment are
  Backend/DevOps responsibilities and are not browser-chain permissions.
- Responses should support a server snapshot identifier and conditional reads
  such as an ETag. A client may refresh a projection but cannot mutate the
  authoritative snapshot.

## 4. Common Response Envelope

The following is TypeScript-like contract notation, not implementation code.

```ts
type ReadModelEnvelope<T> = {
  contract: "mintbot.read-model";
  version: "1";
  requestId: string;
  generatedAt: string;
  snapshot: {
    id: string;
    capturedAt: string;
    consistency: "snapshot" | "partial";
  };
  availability: "available" | "partial" | "stale" | "unavailable";
  freshness: Freshness;
  data: T | null;
  issues: ReadModelIssue[];
  nextCursor?: string;
};
```

`requestId` and cursors are opaque identifiers. They must not contain a token,
credential, URL with credentials, key material, or raw provider payload.

### Freshness

```ts
type Freshness = {
  status: "fresh" | "stale" | "unknown";
  observedAt: string | null;
  expiresAt: string | null;
  ageSeconds: string | null;
  policyVersion: string | null;
};
```

`ageSeconds` is a non-negative decimal integer string calculated by Backend.
`unknown` means that the source did not provide a trustworthy observation or
expiry; it does not mean fresh. `stale` means the last value may be shown as a
last-known value but cannot satisfy a freshness-gated decision.

### Provenance

```ts
type Provenance = {
  kind:
    | "backend_store"
    | "chain_observation"
    | "eligibility_check"
    | "simulation"
    | "calendar_source"
    | "score_calculation"
    | "reconciliation"
    | "notification_event";
  recordId: string;
  observedAt: string;
  sourceBlockNumber?: string;
  sourceBlockHash?: string;
  evidenceId?: string;
  modelVersion?: string;
  policyVersion?: string;
  sourceRef?: string;
};
```

`sourceRef` is an opaque, non-secret source identifier only. It is not a URL,
RPC endpoint, secret-store path, credential reference, or provider key. The
Backend must omit a provenance field rather than expose a sensitive value.
Records and fields that affect a user decision, including amount, eligibility,
simulation, score, gate, calendar time, and finality, must carry provenance and
freshness. Derived records include `fieldSources` when their fields come from
different observations.

### Issues and availability

```ts
type ReadModelIssue = {
  code: string;
  severity: "info" | "warning" | "blocking";
  message: string;
  retryable: boolean;
  safeAction:
    | "Inspect"
    | "Refresh read model"
    | "Resolve eligibility"
    | "Fund wallet"
    | "Validate again"
    | "Wait for reconciliation"
    | "No safe action";
  provenance?: Provenance;
};
```

Messages are plain-language, stable enough for display, and already redacted by
Backend. Raw exception strings, calldata, provider payloads, credentials,
passphrases, and key material are never returned. `retryable` describes the
specific read or recovery operation authorized by Backend; it is not a generic
permission to spend.

## 5. Safe Primitive Types

### Amounts

Every ETH amount uses this shape:

```ts
type EthAmount = {
  value: string; // canonical unsigned integer, /^(0|[1-9][0-9]*)$/
  asset: "ETH";
  unit: "wei";
  decimals: 18;
};
```

Rules:

- `value` is the exact base-unit value. The wire never sends a `bigint`, a
  floating-point ETH value, a locale-formatted string, or a bare numeric field.
- The UI validates the grammar before formatting. Invalid or missing values
  render as `Unknown`/`Unavailable`, never as `0`.
- Mint value, estimated execution gas, estimated data-posting gas, priority-fee
  policy component, worst-case reservation, actual spend, per-run cap, daily
  cap, and balance all use `EthAmount`.
- Robinhood FREE mints expose `mintValue.value = "0"` and keep
  `l2ExecutionGas`, `l1DataGas`, and `priorityFeeComponent` separate. The
  aggregate is an explicit sum, not a replacement for the components.
- An optional configured-currency estimate must remain an estimate and use a
  decimal string plus its own freshness:

  ```ts
type FiatEstimate = {
  value: string;
  currency: string;
  kind: "estimate";
  freshness: Freshness;
};
```

- The API must identify whether an amount is `estimated`, `reserved`, `actual`,
  or `unknown`; it must not make an estimate look like settled spend.

The sourced form used by resource shapes is:

```ts
type SourcedAmount = {
  amount: EthAmount | null;
  kind: "estimated" | "reserved" | "actual" | "unknown";
  freshness: Freshness;
  provenance: Provenance[];
};

type SourcedQuantity = {
  value: string | null;
  unit: "gas";
  freshness: Freshness;
  provenance: Provenance[];
};
```

`amount = null` is the explicit unknown/unavailable representation; it is not a
zero amount.

### Gates, checks, and safe actions

```ts
type CheckOutcome = "pass" | "fail" | "unknown" | "stale";

type GateCheck = {
  code: string;
  outcome: CheckOutcome;
  required: boolean;
  message: string;
  evaluatedAt: string | null;
  validUntil: string | null;
  provenance?: Provenance;
  freshness: Freshness;
};

type GateSummary = {
  decision: "permitted" | "blocked" | "unknown";
  checks: GateCheck[];
  blockers: ReadModelIssue[];
  nextAction: ReadModelIssue["safeAction"];
};
```

`decision = "permitted"` is reserved for a Backend-authorized read-model
claim, not a client-generated eligibility or execution permission. Phase 2
views should normally expose inspection and readiness decisions only; they do
not expose an execution mutation.

### Retryability

```ts
type RetryPolicy = {
  allowed: boolean;
  kind:
    | "none"
    | "refresh_read"
    | "reconcile"
    | "replace"
    | "resubmit"
    | "rerun";
  reasonCode: string;
  message: string;
  requiresFreshData: boolean;
  safeAction: ReadModelIssue["safeAction"];
};
```

The UI renders a retry or refresh affordance only when `allowed` is true and
the operation is read-only or explicitly represented by a future Backend
mutation contract. It never derives retryability from `state`, the presence of
a transaction hash, or an RPC timeout. The default for omitted or unknown
retry policy is `allowed = false`, `kind = "none"`, and `No safe action`.

Supporting shapes used below are defined as follows:

```ts
type ScoreFactor = {
  code: string;
  contribution: number;
  explanation: string;
  provenance: Provenance[];
  freshness: Freshness;
};

type RiskFlag = {
  code: string;
  severity: "info" | "warning" | "blocking";
  message: string;
  provenance?: Provenance;
  freshness: Freshness;
};

type EvidenceRow = {
  id: string;
  label: string;
  summary: string;
  provenance: Provenance[];
  freshness: Freshness;
};

type ReadinessSummary = {
  total: string;
  ready: string;
  blocked: string;
  unknown: string;
  stale: string;
  ineligible: string;
  executing: string;
  freshness: Freshness;
};

type CampaignState =
  | "Draft" | "Validating" | "Ready" | "Armed" | "Active" | "Paused"
  | "Completed" | "Failed" | "Aborted" | "Cancelled";

type CampaignSummary = {
  id: string;
  state: CampaignState;
  chainId: string;
  contract: string | null;
  quantity: string;
  cost: SourcedAmount;
  gate: GateSummary;
  freshness: Freshness;
  provenance: Provenance[];
};

type WalletExecutionResult = {
  walletId: string;
  address: string;
  state: string;
  attemptIds: string[];
  finality: Finality | null;
  reason?: OutcomeReason;
  retry: RetryPolicy;
  freshness: Freshness;
};

type TransactionAttempt = {
  id: string;
  walletId: string;
  hash: string | null;
  nonce: string | null;
  attemptNumber: string;
  replacementOfId: string | null;
  state: string;
  finality: Finality | null;
  retry: RetryPolicy;
  reason?: ReadModelIssue;
  provenance: Provenance[];
};

type TransactionReceipt = {
  id: string;
  attemptId: string;
  hash: string;
  status: "pending" | "confirmed" | "reverted" | "reorged" | "dropped";
  blockNumber: string | null;
  blockHash: string | null;
  gasUsed: SourcedQuantity | null;
  effectiveGasPrice: SourcedAmount | null;
  actualSpend: SourcedAmount | null;
  finality: Finality;
  provenance: Provenance[];
};

type ReconciliationObservation = {
  id: string;
  state: "unresolved" | "matched" | "ambiguous" | "reorged" | "final";
  observedAt: string;
  reason: string | null;
  retry: RetryPolicy;
  provenance: Provenance[];
};

type TimelineEvent = {
  id: string;
  type: string;
  state: string | null;
  occurredAt: string;
  message: string;
  provenance?: Provenance;
};
```

## 6. Proposed Read-Only Resources

All paths below are proposals under `/api/v1/read-model`. They are `GET` only
and are not implemented by this change.

| Resource | Purpose | Initial phase use | Safe primary action |
|---|---|---|---|
| `/home` | Attention items, readiness counts, candidate opportunities, reminders, and system summary | Phase 2 | `Inspect` |
| `/opportunities` | Paginated evidence-backed candidate summaries | Phase 2 discovery when accepted; extensible for Phase 4 | `Inspect` |
| `/opportunities/{id}` | Full evidence, score inputs, risks, gates, and freshness | Phase 2/4 contract | `Inspect` |
| `/calendar` | Upcoming mint records, source authority, timing, price, supply, and readiness summary | Phase 2 | `Inspect` |
| `/campaigns/{id}/readiness` | Per-wallet readiness matrix for one campaign/drop | Phase 2 read-only readiness | `Refresh read model` or `Resolve eligibility` |
| `/runs/{id}` | Dry-run/live record, wallet outcomes, attempts, receipts, reconciliation, and finality history | Phase 2 monitoring projection | `Inspect` or `Wait for reconciliation` |
| `/alerts` | Persisted alert and delivery summaries with canonical links | Phase 2 reminders | `Inspect` |
| `/health` | Safe dependency, kill-switch, reconciliation, and data-freshness summary | Phase 2 system strip | `Inspect` or `No safe action` |

No resource in `v1` returns an action URL that signs, broadcasts, arms, kills,
or mutates a run. Future Phase 3 command contracts must be separately versioned
and must call Backend transitions through the same authoritative state machine.

## 7. Resource Shapes

### Home and attention

`HomeReadModel` contains:

- `attention`: items with `severity`, subject ID, canonical state, plain-language
  reason, `freshness`, `provenance`, and a safe primary action.
- `readinessSummary`: separate counts for `ready`, `blocked`, `unknown`,
  `stale`, `ineligible`, and `executing`; no unknown or stale item is counted
  as ready.
- `opportunities`: summaries with score and gate separated.
- `calendarHighlights`: only records whose source and opening evidence are
  represented; stale entries stay explicitly stale.
- `alerts`: persisted delivery state, never delivery-as-execution proof.
- `system`: the redacted health projection described below.

Attention items must not imply that a Phase 1 CLI run or a future Phase 2
recommendation is authorized to spend.

### Opportunity summary and detail

```ts
type OpportunityReadModel = {
  id: string;
  project: { name: string | null; contract: string | null };
  chain: { id: string; name: string; verification: GateSummary };
  disposition:
    | "discovered"
    | "evaluating"
    | "scored"
    | "notified"
    | "approved"
    | "promoted"
    | "rejected"
    | "expired";
  openingAt: string | null;
  price: SourcedAmount | null;
  score: {
    value: number | null;
    modelVersion: string | null;
    confidence: {
      sampleSize: string;
      denominator: string | null;
      label: "low" | "medium" | "high" | "unknown";
    };
    factors: ScoreFactor[];
    freshness: Freshness;
    provenance: Provenance[];
  };
  risks: RiskFlag[];
  evidence: EvidenceRow[];
  gate: GateSummary;
  readiness: ReadinessSummary | null;
  nextAction: "Inspect";
  freshness: Freshness;
  provenance: Provenance[];
};
```

`SourcedAmount` wraps `EthAmount` with `kind: "estimated" | "reserved" |
"actual" | "unknown"`, `freshness`, and `provenance`. `ScoreFactor` contains a
stable factor code, contribution, source, and explanation. Score is
desirability only. It is not a probability, profitability guarantee, approval,
or execution permission. Until the scoring owner versions the confidence
baseline `N0`, the UI displays sample coverage and `unknown` confidence rather
than inventing a calibrated probability.

`RiskFlag` and `EvidenceRow` must expose source time and reason. Evidence of a
positive Robinhood SeaDrop characterization is not an execution enablement
claim. A blocked gate remains blocked regardless of score.

### Calendar

Each calendar entry includes:

- project/collection name when known, contract address when known, chain ID and
  canonical chain name;
- opening/closing times and phase, each with source provenance and freshness;
- mint price as a sourced `EthAmount`, or explicit `Unknown` when unavailable;
- supply and per-wallet limit as integer strings when known;
- method, public/FCFS status, and expected gas as an estimate;
- source authority (`on_chain`, `operator_record`, or `external_source`),
  verification status, last verification, and expiry;
- eligibility summary with counts split across `eligible`, `ineligible`,
  `unknown`, `ready`, and `stale`;
- `nextAction: "Inspect"` only.

A manually entered or externally sourced time is not presented as an on-chain
guarantee. A stale calendar entry cannot be used to claim that a wallet is
ready or that an opening is safe to act on.

### Wallet-by-campaign readiness

```ts
type ReadinessRow = {
  campaignId: string;
  wallet: { id: string; address: string; label: string | null };
  state:
    | "Unknown"
    | "Unfunded"
    | "Funded"
    | "Eligible"
    | "Ready"
    | "Executing"
    | "Minted"
    | "Failed"
    | "Skipped";
  decision: "ready" | "blocked" | "unknown" | "stale";
  checks: GateCheck[];
  blockers: ReadModelIssue[];
  cost: {
    mintValue: SourcedAmount;
    executionGas: SourcedAmount;
    dataPostingGas: SourcedAmount | null;
    priorityFeeComponent: SourcedAmount | null;
    estimatedTotal: SourcedAmount;
    balance: SourcedAmount | null;
  };
  nextAction: ReadModelIssue["safeAction"];
  freshness: Freshness;
  provenance: Provenance[];
};
```

Minimum check codes are `funded`, `eligible`, `constructible`, `simulated`,
`gas_policy`, `chain_verified`, `evidence_current`, `runtime_ready`, and
`reconciliation_clear`. Backend may add codes only additively in `v1`.

Required rendering semantics:

- `eligibility = unknown` renders as `Unknown`, not `Ineligible`; it names the
  missing authority and does not count as ready.
- `simulation = fail` is a hard block. The safe choices are inspect the reason,
  exclude the wallet through a future Backend flow, or validate again through a
  future Backend flow. There is no force/override action.
- An expired simulation or eligibility proof renders `Stale` and suppresses a
  readiness claim until Backend supplies fresh evidence.
- A missing balance, gas estimate, cap, or policy renders `Unknown` or
  `Unavailable`, never zero.
- `Ready` means all required recorded checks currently pass. It never means a
  guaranteed mint, inclusion, or final settlement.
- Paid Robinhood rows are `Blocked` with the policy reason; they do not expose a
  live action. FREE Robinhood rows show zero mint value and independent gas
  components, but execution still remains blocked if integrated release gates
  are incomplete.

### Run, attempt, receipt, and reconciliation

The run projection is read-only and must preserve the difference between dry
run and live execution:

```ts
type RunReadModel = {
  run: {
    id: string;
    campaignId: string;
    mode: "dry-run" | "live";
    state: CampaignState;
    outcome: "not_started" | "dry_run_completed" | "partial" | "settled" | "unknown";
    createdAt: string;
    updatedAt: string;
    retry: RetryPolicy;
  };
  campaign: CampaignSummary;
  walletResults: WalletExecutionResult[];
  attempts: TransactionAttempt[];
  receipts: TransactionReceipt[];
  reconciliations: ReconciliationObservation[];
  events: TimelineEvent[];
  freshness: Freshness;
  provenance: Provenance[];
};
```

The canonical campaign labels are `Draft`, `Validating`, `Ready`, `Armed`,
`Active`, `Paused`, `Completed`, `Failed`, `Aborted`, and `Cancelled`.

The proposed wire execution status codes and labels are:

| Code | Label | Success claim |
|---|---|---|
| `prepared` | `Prepared` | no |
| `signed` | `Signed` | no |
| `submitted` | `Submitted` | no |
| `included` | `Included` | no |
| `posted_to_ethereum` | `Posted to Ethereum` | no |
| `confirmed` | `Confirmed` | yes only when the chain policy requires `confirmed` |
| `ethereum_final` | `Ethereum final` | yes only when required by chain policy |
| `replaced` | `Replaced` | no; show replacement history |
| `reorged` | `Reorged` | no; reconciliation required |
| `failed` | `Failed` | no; show typed technical/execution reason |
| `aborted` | `Aborted` | no; show safety/kill/adaptive-stop reason |
| `unknown` | `Unknown` | no; outcome is unresolved |

`pending` may be represented as `Submitted` or `Included` plus an explicit
`finality` stage; it must not become a success label.

Each attempt includes wallet identity, hash when known, nonce as a string,
attempt number, replacement relationship, redacted reason, `retry`, and
provenance. It never includes raw signed bytes or calldata.

Each receipt includes status, block number/hash when known, gas used and
effective price as sourced amounts, observed time, finality, and reconciliation
history. `actualSpend` is distinct from a reservation or estimate.

### Finality and reorg contract

```ts
type Finality = {
  stage: "unknown" | "confirmed" | "soft" | "posted" | "ethereum_final";
  requiredStage: "confirmed" | "ethereum_final";
  settlementReached: boolean;
  observedAt: string | null;
  freshness: Freshness;
  provenance: Provenance[];
  downgradeReason?: string;
};
```

Chain policy controls `requiredStage`; the client does not calculate it.

- Ethereum may settle at its configured `confirmed` policy. A receipt before
  that policy is not final.
- Robinhood progresses `Submitted` -> `Included`/`soft` -> `Posted to
  Ethereum`/`posted` -> `Ethereum final`/`ethereum_final`.
- Robinhood `Included` and `Posted to Ethereum` remain visible operational
  milestones and never render as minted/success.
- A `Reorged` observation sets `settlementReached = false` for the current
  record, preserves the prior observation in history, and requires Backend
  reconciliation before any retry or accounting conclusion.
- A finality observer or sequencer feed is evidence for the stored record, not
  an instruction for the browser to connect directly to that source.

### Abort, cancellation, failure, and unknown

The projection includes a terminal or unresolved reason object:

```ts
type OutcomeReason = {
  code: string;
  label: "Cancelled" | "Aborted" | "Failed" | "Unknown";
  message: string;
  actor: "operator" | "safety_control" | "adaptive_stop" | "backend" | "chain" | "unknown";
  occurredAt: string;
  submittedWork: "none" | "some" | "all" | "unknown";
  retry: RetryPolicy;
  provenance?: Provenance;
};
```

- `Cancelled` means the operator stopped before active execution. If no
  transaction was submitted, state that plainly.
- `Aborted` means a kill switch, spend cap, safety control, or adaptive stop
  ended remaining work. Submitted transactions remain subject to
  reconciliation; a kill switch cannot recall them.
- `Failed` means technical or execution inability prevented completion. It may
  contain partial wallet results and gas spent.
- `Unknown` means the authoritative outcome is unresolved, commonly after a
  crash, endpoint ambiguity, or missing receipt. It is not failed, confirmed,
  or safe to retry.

The UI must show partial results for all four outcomes and state whether other
wallets continued. It must not collapse `Aborted` into `Failed` or
`Cancelled`.

### Redacted system health

The health projection exposes only operational facts needed to explain whether
read data or future actions are available:

```ts
type SystemHealth = {
  state: "Ready" | "Not ready" | "Killed" | "Unknown";
  killSwitch: "clear" | "engaged" | "unknown";
  dependencies: {
    engine: "ready" | "not_ready" | "unknown";
    chain: "ready" | "not_ready" | "unknown";
    backup: "ready" | "not_ready" | "unknown";
    notifications: "ready" | "not_ready" | "unknown";
    reconciliation: "clear" | "required" | "in_progress" | "unknown";
  };
  blockers: ReadModelIssue[];
  checkedAt: string;
  freshness: Freshness;
};
```

The response must omit secret-store references, filesystem paths, RPC/sequencer
URLs, archive URLs, signer details, credentials, and raw configuration. A
boolean readiness claim is safe; the underlying secret or endpoint value is
not.

## 8. Rendering Rules for Unsafe or Incomplete Data

Every non-terminal presentation follows `[STATE] - [subject] - [what happens
next]`. The client must apply these rules without inventing fallback data:

| Condition | Required rendering | Forbidden rendering |
|---|---|---|
| `unknown` eligibility/outcome | Neutral `Unknown`, reason, observed age, and a safe inspection/refresh action only when supplied | `No`, `Ineligible`, `Failed`, `Success`, or a generic retry |
| `stale` evidence/simulation/calendar | Last-known value clearly marked `Stale`, expiry, source time, and blocked freshness-dependent decision | Treating stale data as current or ready |
| known hard gate failure | `Blocked`, exact failed check, plain-language consequence, and no force action | Hiding the blocker or letting score bypass it |
| unavailable dependency | Preserve last-known records, show `Unavailable` health issue, and suppress unsafe actions | Empty dashboard interpreted as no opportunities or zero balances |
| partial response | Keep unaffected records and identify omitted/partial areas | Claiming a complete fleet or complete result |
| dry run | `Dry run`/`dry_run_completed`; no minted or confirmed claim | Reusing `Confirmed` or `Minted` for preparation |
| Robinhood `soft`/`posted` | `Included`/`Posted to Ethereum`, `Waiting for Ethereum finality` | `Success`, `Minted`, or settled PnL |
| reorg | `Reorged`, downgrade explanation, reconciliation state, no retry until policy allows | Leaving the old success badge in place |
| abort/kill | `Aborted`, cause, submitted-work scope, reconciliation next step | `Cancelled`, silent stop, or promise that submitted work was recalled |
| technical inability | `Failed`, typed reason, partial results, backend retry policy | Calling it `Aborted` merely because work stopped |

Safe Robinhood blocked copy may be rendered as:

> SeaDrop compatibility is recorded for Robinhood, but execution is blocked
> because the required safety and recovery checks are not complete. No
> transaction will be sent. The system will show the exact check that needs
> attention.

The page must not display a live-arm action while the chain gate is blocked.
Semantic color is paired with text and an icon/accessible label. Loading,
stale, disconnected, and partial states preserve the final layout and do not
flash an optimistic success state.

## 9. Redaction and Security Boundary

The Backend serializer must use an allowlist for read-model fields. The
following are never present in a Phase 2 response, error, notification link,
or telemetry payload:

- private keys, mnemonics, passphrases, signer/account objects, key references,
  encrypted keystore contents, or secret-store values;
- RPC, archive, sequencer, relay, or provider credentials and credentialed URLs;
- raw calldata, signed/raw transaction bytes, provider payloads, authorization
  headers, or unnormalized exception text;
- environment contents, secret file paths, or operational backup locations.

Public addresses, transaction hashes, block hashes, and contract addresses may
be returned only as ordinary public identifiers and must still be treated as
opaque strings. The browser never calls a chain or signer endpoint. All chain
facts, balances, simulations, finality, and reconciliation facts arrive through
the Backend projection.

## 10. Alignment With the Current Repository

The current code is useful input but is not this wire contract:

- `packages/backend/src/read-model.ts` currently exposes only a narrow run
  projection and accepts readiness as an external array. It needs a stable
  snapshot envelope, typed availability/issues, and authoritative readiness
  joins before a client consumes it.
- `packages/database/src/read-models.ts` currently returns readiness booleans,
  limited simulation timestamps, active executions, opportunity counts, chain
  verification rows, and pending reconciliation rows. It does not yet expose
  field-level provenance, expiry for every fact, blocker codes/messages,
  string-safe amount objects, complete finality history, or retry policy.
- `packages/backend/src/types.ts` and repository records use `bigint` and
  optional staged-finality fields internally. The API adapter must serialize
  them into the explicit wire forms above and must not rely on JSON's default
  `bigint` behavior.
- Current readiness evaluation is boolean-oriented. Backend must retain the
  distinction between `unknown`, `fail`, and `stale`, including the source
  block, input digest/evidence identity, checked time, expiry, and exact safe
  next action.
- Current run/receipt types use internal `Confirmed`/`Pending` forms while the
  product language requires `Included`, `Posted to Ethereum`, and `Ethereum
  final` for staged chains. Backend owns the explicit mapping and history; the
  client must not derive it from a hash or receipt alone.
- Current health records contain operational fields that must not be projected
  verbatim. The future `/health` read model is a redacted summary, not a dump of
  `OperationalReadiness` or configuration.
- The existing command application includes mutating operations. It is not a
  Phase 2 browser API. Any future command surface must be a separate,
  confirmation-gated contract and must retain the same Backend admission,
  signer, reservation, simulation, reconciliation, and finality boundaries.
- Opportunity, tracked-wallet, signal, calendar, and complete eligibility
  records need durable source data and query ownership before their projections
  can be considered complete. The frontend must not reconstruct them from
  sparse rows or external chain calls.

## 11. Dependencies and Assumptions

### Required owners and dependencies

- **Engineering Lead:** accept the contract version, integration eligibility,
  Phase 2 surface boundary, and ownership map.
- **Backend:** implement the server-side projection/serializer, snapshot
  consistency, issue taxonomy, canonical state mapping, safe retry policy, and
  redacted health response. Do not add browser execution routes under `v1`.
- **Database:** persist/query source records, provenance, freshness policies,
  immutable lifecycle history, finality/reorg observations, reservation
  amounts, and wallet-by-campaign readiness without process-local inference.
- **Blockchain/CTO:** approve chain verification status, Robinhood blocked
  wording, staged finality/reorg semantics, and required settlement stage per
  chain.
- **Product Manager/Designer:** approve plain-language labels, calendar source
  authority, score/confidence vocabulary, blocker copy, and the distinction
  between `Inspect`, `Promote proposal`, `Approve`, and `ARM LIVE CAMPAIGN`.
- **DevOps:** provide the authenticated server transport, safe logging,
  snapshot observability, and deployment configuration without exposing secret
  values. Native WSL remains the development/test environment for this branch.
- **Future Frontend implementation:** validate the schema, render all states,
  and add responsive/accessibility/workflow tests only after this contract and
  its Backend fixtures are accepted.

### Assumptions

- V1 remains single-operator and non-SaaS; no tenancy or multi-user permission
  model is introduced here.
- Store records and reconciled chain observations are the source of truth.
- The initial asset is ETH on Ethereum/Robinhood. Additional assets require a
  new asset/unit contract decision, not a client convention.
- Freshness windows and policy versions are supplied by Backend/Database. The
  client displays them and does not set, extend, or waive them.
- A missing value is unknown, not zero. A high score is not permission. A
  notification is not execution proof.
- Phase 1 remains CLI-only. This artifact may be reviewed and versioned now,
  but no implementation is eligible until the Lead accepts it and the listed
  dependencies produce contract fixtures.

## 12. Future Acceptance Criteria

Before a frontend implementation is eligible for integration, contract tests
and review must demonstrate:

1. Every monetary field round-trips as a canonical string amount with no
   precision loss, and Robinhood FREE cost components remain independent.
2. Every decision-relevant field has provenance, observed time, expiry, and a
   freshness status; server snapshot consistency is testable.
3. Readiness fixtures distinguish pass, fail, unknown, stale, and blocked;
   failed simulation is a hard block and unknown eligibility is not ineligible.
4. Scores, confidence, evidence, risk flags, and safety gates are separate;
   no score fixture yields an execution permission.
5. Retry fixtures cover dependency failure, unknown submission, replacement,
   reorg, cap/kill abort, and technical failure with explicit allowed/denied
   policy and no generic retry.
6. Ethereum and Robinhood fixtures render the correct finality stages;
   `Included` and `Posted to Ethereum` never render as success.
7. Reorg, `Cancelled`, `Aborted`, `Failed`, dry-run, partial, and unknown
   fixtures preserve history, affected-wallet scope, and next safe action.
8. Redaction tests prove that keys, credentials, endpoint values, raw calldata,
   raw transactions, and provider payloads cannot enter read responses or safe
   error envelopes.
9. An unavailable/partial response preserves last-known records and never
   invents zero, false, empty-success, or ready values.
10. `v1` has only read operations. Any future mutating operation is reviewed as
    a separate Phase 3 contract.

## 13. Phase 1 Closure Review

Review date: 2026-09-15

### Review basis

- Assigned worktree: `/home/Junayd/W3/MintBot/.kilo/worktrees/frontend-engineer-wsl`.
- Feature HEAD: `dc3a2a2`; actual `origin/main`: `d7e72f0` (`Complete Ethereum archive fork replay`). The feature HEAD is an ancestor of `origin/main`; no merge or checkout was performed.
- `origin/main` has no `packages/web` tree and no tracked JSX/TSX frontend source. The current worktree has only the two intentional documentation changes listed in the handoff below.
- Reviewed `Frontend_SKILLS.md`, `PRODUCT_SPEC.md`, `PRODUCT_DESIGN_SPEC.md`, `PLAN_Frontend.md`, `ENGINEERING_REVIEW.md`, Backend types/read-model/application contracts, Database read models, and the normalized-store/read-model additions present on `origin/main`.

### Checklist

| Check | Status | Evidence and limitation |
|---|---|---|
| Phase 1 has no frontend implementation | **PASS** | Product and design make Phase 1 CLI-only; neither the current worktree nor `origin/main` contains a web package. This proposal is documentation only. |
| No Phase 2/3 dashboard or control leakage | **PASS** | No route, component, browser client, or mutation was added. The proposed resources are future `GET` contracts and explicitly do not authorize UI implementation or execution. |
| Canonical campaign and wallet-readiness states | **PASS as contract** | The proposal preserves the canonical campaign labels and wallet states, including `Unknown`, `Ready`, `Failed`, and `Skipped`; readiness remains per wallet and campaign. |
| Safety gates versus desirability score | **PASS as boundary** | Score, confidence, evidence, and gate are separate contract fields. Backend/store permission and simulation policy remain authoritative; the client cannot promote a score into permission. |
| Robinhood paid-mint block | **PASS fail-closed** | The normalized origin-main Backend/CanonicalStore path rejects paid Robinhood execution and keeps chain execution disabled. The proposal exposes the block without a live action. |
| Robinhood staged finality | **PARTIAL; Backend blocker** | Origin-main mapping retains `soft`, `posted`, and `ethereum_final`, but internal execution mapping still collapses intermediate states to `Submitted`/`Confirmed` and no public `v1` DTO preserves the complete history. The proposal requires the Backend mapping before UI implementation. |
| Reorg, abort, cancellation, and unknown outcomes | **PARTIAL; Backend/Database blocker** | Origin-main normalized records include reorg/recovery evidence and `Aborted` run state, but the existing read service does not expose the proposal’s outcome reason, history, provenance, or retry policy. |
| No secret or browser-chain access | **PASS by absence and contract** | No frontend source exists. The proposal requires an allowlisted, redacted projection and prohibits keys, credentials, endpoint values, calldata, raw transactions, signer access, and browser RPC. |

### Scope alignment note

`PRODUCT_SPEC.md` and `PRODUCT_DESIGN_SPEC.md` describe consumer-friendly
Phase 2 dashboard/readiness surfaces, while `PLAN_Frontend.md` currently says
Phase 2 has one-way Telegram alerts and no web dashboard. This is a planning
contradiction for Lead/PM resolution before implementation. It does not permit
Phase 1 UI work, and this artifact intentionally remains a future contract
proposal rather than resolving the product decision.

### Closure verdict

- Frontend-owned Phase 1 blockers: **ZERO**.
- Shared blockers: Backend/Database must provide an accepted `v1` projection
  with snapshot consistency, string-safe serialization, field provenance and
  expiry, typed readiness blockers, backend-owned retryability, and complete
  finality/reorg/abort history. Lead/PM must resolve the Phase 2 scope wording.
- Overall Phase 1 release/deployment status remains owned by the integrated
  engineering gate and is not changed by this frontend review.
- Frontend implementation integration status: **NOT ELIGIBLE**.

## 14. Handoff Status

- Artifact: `docs/frontend-phase2-read-model-api-contract.md`
- Worktree: `/home/Junayd/W3/MintBot/.kilo/worktrees/frontend-engineer-wsl`
- Branch: `frontend-engineer-wsl`
- Commit: none; no direct user authorization was provided for a mutating Git
  commit.
- Implementation changes: no product implementation; this is a proposal and
  live-document update only.
- Validation performed before handoff: native WSL `pwd`, branch, and status
  checks; actual `origin/main` revision/ancestry and frontend-tree checks;
  required product/recovery/frontend/engineering documents and current
  Backend/Database contracts read; documentation whitespace, conflict-marker,
  and secret-pattern checks. No tests or runtime tooling are required for this
  documentation-only proposal.
- Integration status: **NOT ELIGIBLE** for frontend implementation integration
  until the Lead accepts the contract and Backend/Database dependencies are
  delivered with fixtures and redaction/finality evidence.
