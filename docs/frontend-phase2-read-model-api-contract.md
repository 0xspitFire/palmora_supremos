# Phase 2 Read-Model/API Contract

> Contract document version: `1.0.0-contract`
> Wire contract namespace: `mintbot.read-model/v1`
> Status: product/design contract accepted; implementation blocked by dependencies
> Date: 2026-09-18
> Consumer owner: Frontend
> Authoritative owners: Product/Design for scope and copy; Backend and Database
> for projections; Blockchain/CTO for chain truth; DevOps for transport safety

## 1. Decision Summary

This document defines the versioned, read-only contract that a future Phase 2
web client may consume. It is an API/read-model handoff, not a web
implementation. It does not add routes, a browser execution surface, browser
RPC access, a signer, key access, secret access, transaction construction, or
any client-side safety override.

The Backend/store remains authoritative for every fact. The client renders the
projection and may not infer eligibility, readiness, spend, success, finality,
retryability, or permission from other fields. Phase 1 remains CLI-only.
Acceptance of this contract is not authorization to start Phase 2 UI
implementation or any execution operation.

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

### In scope for this contract

- Read-only projections for the future Phase 2 intelligence, readiness,
  calendar, reminder, alert, and operational-status views.
- A future read-only run/transaction projection so staged finality and recovery
  can be displayed without making the web client an execution engine.
- Stable wire names, versioning, amount serialization, provenance, freshness,
  blocker, retry, finality, reorg, abort, and redaction rules.
- Product/design acceptance scenarios and explicit Backend, Database,
  Blockchain/CTO, DevOps, and Notification dependencies.

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

- The document version is `1.0.0-contract` for the accepted product/design
  baseline. Implementation eligibility remains blocked until the dependency
  gates in §11 are evidenced; accepting the wire contract does not authorize
  frontend implementation or execution.
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

### Phase 2 default policies

Unless a later Product Owner decision versions these policies, Backend/Database
must apply and expose:

- readiness evidence freshness: 5 minutes;
- discovery and calendar evidence freshness: 15 minutes;
- critical alert delivery: immediate, without reminder grouping;
- non-critical reminders: grouped before delivery and linked to each source
  record;
- read-model projections and alert-delivery records: retained for 30 days;
- audit events: retained for 90 days.

The applicable policy version is required on each freshness-bearing record. A
retention period controls projection availability only; it does not authorize
deletion of execution facts that the product specification requires to remain
auditable.

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

Phase 2 resources may expose only these safe actions:

```ts
type Phase2SafeAction =
  | "Inspect"
  | "View reason"
  | "Refresh read model"
  | "Wait for reconciliation"
  | "No safe action";
```

The broader `safeAction` values above describe possible future Backend or CLI
guidance. They are not permission to render a Phase 2 mutation control.

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
  nextAction: Phase2SafeAction;
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
  safeAction: Phase2SafeAction;
};
```

The UI renders a retry or refresh affordance only when `allowed` is true and
the operation is a Phase 2 read operation (`refresh_read` or `reconcile`).
Mutation kinds (`replace`, `resubmit`, and `rerun`) may describe backend/CLI
history, but a Phase 2 projection must return `allowed = false` and
`No safe action` for them. A future Phase 3 mutation contract must version and
authorize those operations separately. The client never derives retryability
from `state`, the presence of a transaction hash, or an RPC timeout. The
default for omitted or unknown retry policy is `allowed = false`, `kind =
"none"`, and `No safe action`.

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

type ReminderReadModelCommon = {
  id: string;
  kind:
    | "mint_opening_soon"
    | "eligibility_deadline"
    | "wallet_underfunded"
    | "reconciliation_required";
  subjectId: string;
  sourceEventIds: string[];
  message: string;
  dueAt: string | null;
  freshness: Freshness;
  provenance: Provenance[];
  nextAction: Phase2SafeAction;
};

type ReminderReadModel = ReminderReadModelCommon & (
  | {
      urgency: "critical";
      state: "due" | "expired" | "suppressed";
    }
  | {
      urgency: "reminder";
      state: "due" | "grouped" | "expired" | "suppressed";
    }
);

type ImmediateAlertDelivery = "queued" | "sent" | "failed" | "suppressed";

type TelegramAlertCommon = {
  id: string;
  channel: "telegram";
  direction: "outbound";
  eventType:
    | "opportunity_high_score"
    | "readiness_changed"
    | "eligibility_found"
    | "mint_opening_soon"
    | "eligibility_deadline"
    | "wallet_underfunded"
    | "execution_started"
    | "execution_succeeded"
    | "execution_failed"
    | "execution_aborted"
    | "kill_switch_engaged"
    | "spend_cap_threshold"
    | "health_blocked"
    | "unresolved_submission"
    | "reorg_detected";
  sourceEventIds: string[];
  subjectId: string;
  canonicalReadPath: string;
  state: string;
  attempts: string;
  createdAt: string;
  deliveredAt: string | null;
  message: string;
  freshness: Freshness;
  provenance: Provenance[];
  nextAction: Phase2SafeAction;
};

type TelegramAlertReadModel = TelegramAlertCommon & (
  | {
      urgency: "critical" | "status";
      delivery: ImmediateAlertDelivery;
    }
  | {
      urgency: "reminder";
      delivery: ImmediateAlertDelivery | "grouped";
    }
);
```

## 6. Phase 2 Read-Only Resources

All paths below are accepted Phase 2 resource shapes under
`/api/v1/read-model`. They are `GET` only and are not implemented by this
documentation change.

| Resource | Purpose | Initial phase use | Safe primary action |
|---|---|---|---|
| `/home` | Attention items, readiness counts, candidate opportunities, reminders, and system summary | Phase 2 | `Inspect` |
| `/opportunities` | Paginated evidence-backed candidate summaries | Phase 2 discovery; extensible for Phase 4 | `Inspect` |
| `/opportunities/{id}` | Full available evidence, score inputs, risks, gates, and freshness | Phase 2 read-only detail; Phase 4 expands evidence | `Inspect` |
| `/calendar` | Upcoming mint records, source authority, timing, price, supply, and readiness summary | Phase 2 | `Inspect` |
| `/campaigns/{id}/readiness` | Per-wallet readiness matrix for one campaign/drop | Phase 2 read-only readiness | `Inspect` or `Refresh read model` |
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
- `reminders`: `ReminderReadModel[]`; critical items are not grouped and
  non-critical items retain their grouped state and source IDs.
- `alerts`: `TelegramAlertReadModel[]` with persisted delivery state, never
  delivery-as-execution proof.
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

The scoring model may retain a six-hour recency-decay factor for historical
records, but the Phase 2 discovery freshness policy is 15 minutes. Once the
opportunity envelope is stale, the client labels the score `Stale`, keeps it
inspectable for evidence, and does not present it as a current recommendation
or trigger a new reminder until Backend refreshes the projection.

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

### Reminders and one-way Telegram alerts

Reminders use `ReminderReadModel`. Critical reminders, including a blocked
runtime, kill-switch engagement, cap threshold, or unresolved submitted work,
are delivered immediately. Non-critical opening, deadline, eligibility, and
underfunded reminders may be grouped; grouping retains every source ID and does
not change the underlying state or due time. A reminder with `urgency: "critical"`
must not have `state: "grouped"`; only `urgency: "reminder"` may be grouped.

Phase 2 Telegram alerts use `TelegramAlertReadModel` and are outbound-only.
The notifier may send the following event types: `opportunity_high_score`,
`readiness_changed`, `eligibility_found`, `mint_opening_soon`, `eligibility_deadline`,
`wallet_underfunded`, `execution_started`, `execution_succeeded`,
`execution_failed`, `execution_aborted`, `kill_switch_engaged`,
`spend_cap_threshold`, `health_blocked`, `unresolved_submission`, and
`reorg_detected`. Each message carries a redacted
canonical read path, source event, authoritative state, and freshness. It may
not contain a command, callback, approval, arm, execution, pause, kill, retry,
or other mutation affordance.

Delivery states (`queued`, `grouped`, `sent`, `failed`, and `suppressed`) are
notification facts only. The alert shape forbids `grouped` for `critical` and
`status` urgency. A `sent` alert does not prove submission, inclusion,
posting, finality, or success; a `failed` alert does not alter the source
record. Delivery is idempotent by source event and channel, and critical
alerts are never silently downgraded into a grouped reminder.

Backend assigns `urgency` from the source event. `critical` events are delivered
immediately and may not use `grouped`; `reminder` events may be grouped while
preserving all source IDs; `status` events retain their source timing and are
not treated as reminders. At minimum, kill-switch, spend-cap, blocked-health,
unresolved-submission, reorg, execution-failed, and execution-aborted events
are `critical`; opportunity, eligibility, opening, deadline, and ordinary
underfunded reminders are `reminder` unless a Backend policy marks them
critical.

Required Telegram copy is concise, plain-language, and state-first:

```text
OPPORTUNITY · Project name · Worth inspecting (score 78, medium confidence)
Opening: 2026-09-18 14:00 UTC · Gate: Not evaluated
Next: Open the read-only opportunity record.

REMINDER · Project name · Eligibility found for 3 wallets
Checked 03:12 ago · Readiness is not execution permission.
Next: Inspect the readiness record.

ALERT · Project name · Readiness changed: 3 wallets pass current checks
Checked 00:42 ago · A passing check is not execution permission.
Next: Inspect each wallet's evidence.

ALERT · Project name · Mint opens in 15 minutes
Calendar source checked 02:10 ago · The opening time is not a guarantee.
Next: Inspect the calendar record.

ALERT · run_7F2 · W04 failed: NONCE_CONFLICT
Other wallets continued · Retry is unavailable pending reconciliation.
Next: Inspect the canonical run record.

ALERT · runtime · Kill switch engaged
Submitted transactions cannot be recalled and may still settle.
Next: Inspect affected runs and reconcile.
```

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
  nextAction: Phase2SafeAction;
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
- `simulation = fail` is a hard block. Phase 2 exposes `View reason` only;
  exclusion or validation through a future Backend flow may be described as
  guidance but is not an active control. There is no force/override action.
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

The accepted wire execution status codes and labels are:

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

Every non-terminal presentation follows `[STATE] · [subject] · [what happens
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
| critical alert | Immediate outbound alert with current state, source time, and canonical read link | Grouping, suppressing, or treating delivery as execution proof |
| non-critical reminder | Grouped reminder preserving every source ID, due time, and freshness | Dropping source records or changing their state by grouping |

The default freshness windows are 5 minutes for readiness and 15 minutes for
discovery/calendar data. When a window expires, retain the last-known value as
`Stale` with its observed time and expiry; do not count it as ready or use it
to imply that an opening is safe.

Required primary copy includes:

```text
READY · readiness · 8 of 10 wallets pass the current checks
Checked 00:42 ago · readiness refreshes after 5 minutes
Next: Inspect each wallet's evidence.

UNKNOWN · W02 · Eligibility could not be verified
No eligibility authority responded. This wallet is not counted as ready.
Next: Inspect the missing evidence; no execution action is available.

STALE · calendar · Opening time was last verified 18 minutes ago
The last-known time remains visible, but it is not an action guarantee.
Next: Refresh the read model.

BLOCKED · W04 · Simulation failed
This wallet cannot be treated as ready. No force option exists.
Next: Inspect the reason; a future Backend flow may allow a new check.

ALERT · mint_opening_soon · Public mint opens in 15 minutes
Source checked 02:10 ago · Review the calendar record for current eligibility.
```

### Phase 2 no-mutation boundary

Every Phase 2 resource is `GET`-only. A browser refresh, filter, pagination
request, conditional read, or canonical record link cannot change server state.
The web client and Telegram notifier must not call or expose `POST`, `PATCH`,
`DELETE`, command, callback, or action URLs for approval, promotion, arm, run,
pause, kill, retry, exclusion, funding, validation, signing, broadcasting,
reservation, nonce, or policy changes. A displayed future next step is guidance
only. Phase 3 mutations require a separate reviewed namespace, authenticated
Backend transition, explicit confirmation, immutable scope, and audit event.

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

### Acceptance state

- Product Owner has approved the Phase 2 scope: single local operator,
  read-only web intelligence/readiness/calendar/reminder/status views, and
  outbound-only Telegram alerts under `mintbot.read-model/v1`.
- Product and Design copy, state vocabulary, freshness defaults, retention
  defaults, and no-mutation boundary are accepted in this document and the
  two root specifications.
- This is an accepted product/design contract baseline, not an implementation
  release. Frontend implementation and live execution remain **NOT ELIGIBLE**.

### Required dependency gates

| Gate | Owner | Required deliverable | Evidence required before frontend implementation |
|---|---|---|---|
| Phase 1 foundation | Engineering Lead | Recorded P1 exit decision and phase sequencing | P1 gate status is explicit; this document never authorizes capital or execution |
| Read-model adapter | Backend | `GET`-only `mintbot.read-model/v1` serializer, snapshot consistency, canonical state/finality mapping, typed issues, freshness, safe actions, and redacted health | Contract fixtures round-trip envelope, partial/stale/unknown states, and reject all mutation routes |
| Durable source records | Database | Opportunity, calendar, eligibility/readiness, simulation, lifecycle, finality/reorg, reminder, alert-delivery, provenance, policy, and retention records | Query fixtures are transactionally consistent, preserve history, and apply 5m/15m policy versions and 30d/90d retention |
| Chain truth | Blockchain/CTO | Chain verification, staged finality/reorg mapping, Robinhood blocked state, and source evidence | Ethereum and Robinhood fixtures prove only the required settlement stage is success; compatibility evidence does not enable execution |
| One-way notifications | Backend/Notifications | Idempotent outbound Telegram delivery, immediate critical alerts, grouped non-critical reminders, canonical read links, and delivery state | Event fixtures prove no inbound command/callback/mutation and delivery never stands in for execution proof |
| Safe transport and operations | DevOps | Authenticated server transport, TLS/origin policy, safe logs, snapshot observability, and deployment configuration without secret values | Redaction and access tests show no credentials, endpoint values, or secret-bearing URLs cross the read boundary |
| Consumer implementation | Future Frontend | Schema validation, responsive/accessibility behavior, and all required state fixtures | Review occurs only after every preceding gate is accepted; no Phase 2 code is part of this handoff |

An owner may provide evidence in a later implementation change, but a missing
gate keeps the corresponding surface unavailable and never justifies a client
fallback or execution shortcut.

### Assumptions

- V1 remains single-operator and non-SaaS; no tenancy or multi-user permission
  model is introduced here.
- Store records and reconciled chain observations are the source of truth.
- The initial asset is ETH on Ethereum/Robinhood. Additional assets require a
  new asset/unit contract decision, not a client convention.
- Readiness freshness is 5 minutes; discovery and calendar freshness are 15
  minutes. Backend/Database supply the active policy version and server age;
  the client never sets, extends, or waives a window.
- Critical alerts are immediate. Non-critical reminders may be grouped while
  preserving source IDs, due times, and freshness.
- Read-model projections and alert-delivery records are retained for 30 days;
  audit events are retained for 90 days. Retention does not erase execution
  facts that another product policy requires to remain auditable.
- A missing value is unknown, not zero. A high score is not permission. A
  notification is not execution proof.
- Phase 1 remains CLI-only. No web or Telegram mutation is authorized by this
  document; Phase 3 must introduce a separately reviewed Backend contract.

## 12. Acceptance Criteria and Scenarios

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
11. Policy fixtures apply 5-minute readiness freshness, 15-minute
    discovery/calendar freshness, immediate critical alerts, grouped
    non-critical reminders, 30-day read-model/alert retention, and 90-day audit
    retention, with policy versions visible.
12. Telegram fixtures prove outbound-only delivery, canonical read links,
    idempotency, redaction, and no execution proof from delivery state.

### Scenario 1: Home uses one authoritative snapshot

Given the Backend has attention, opportunity, readiness, calendar, reminder,
alert, and health records
When the client requests `GET /api/v1/read-model/home`
Then the response identifies one snapshot, server-generated freshness, and any
partial areas
And the client does not combine records from another snapshot or infer a
permission from counts.

### Scenario 2: Score never becomes permission

Given an opportunity has a high deterministic score and a blocking chain or
simulation gate
When its summary is rendered
Then score, confidence, evidence, risks, and gate remain separate
And the only Phase 2 action is `Inspect`; no promote, approve, arm, or execute
control is present.

### Scenario 3: Readiness freshness and unknown eligibility

Given a wallet/campaign readiness record was checked 4 minutes ago
When it is read
Then it may show the recorded decision with the 5-minute readiness policy

Given the same record is 6 minutes old or its eligibility authority is absent
When it is read
Then it shows `Stale` or `Unknown`, is not counted as ready, names the missing
evidence, and exposes only `Inspect` or `Refresh read model` when supplied.

### Scenario 4: Failed simulation is blocked

Given a wallet simulation has a typed failure
When readiness or an opportunity detail is rendered
Then the state is `Blocked`, the failed check and consequence are shown in plain
language, and no force, retry, exclusion, funding, or validation control is
rendered in Phase 2.

### Scenario 5: Calendar freshness is not an opening guarantee

Given a calendar source was verified 14 minutes ago
When the calendar is read
Then the opening and eligibility facts carry the 15-minute policy and source
authority

Given the source is 16 minutes old or externally supplied without current
verification
When the calendar is read
Then the last-known value is labeled `Stale` or `Unknown`, remains inspectable,
and cannot claim that a wallet is ready or that an opening is safe to act on.

### Scenario 6: Critical alerts are immediate and reminders are grouped

Given a kill-switch, cap-threshold, health-blocked, or unresolved-submission
event is persisted
When Telegram delivery is scheduled
Then an outbound alert is sent immediately with current state, source time, and
a canonical read-only link

Given non-critical opening, deadline, eligibility, or underfunded events occur
within the grouping window
When Telegram delivery is scheduled
Then a grouped reminder preserves every source event, due time, and freshness
And grouping does not alter any source state or create a command affordance.

### Scenario 7: Telegram delivery is not execution proof

Given an `execution_succeeded` notification is marked `sent`
When a user opens the alert
Then the message displays the authoritative run state and read link
And it does not claim submission, inclusion, posting, finality, or success from
delivery alone. A failed delivery leaves the run unchanged.

### Scenario 8: Unavailable and partial data fail closed

Given one dependency is unavailable while a prior snapshot exists
When a read model is returned
Then unaffected records remain visible, the issue says `Unavailable`, and
unsafe actions are suppressed
And missing balances, prices, counts, or costs are `Unknown`/`Unavailable`, not
zero or false.

### Scenario 9: Robinhood staged finality stays truthful

Given a Robinhood transaction is `Included` or `Posted to Ethereum`
When a run or alert is rendered
Then it says `Waiting for Ethereum finality`, keeps the stage visible, and does
not show `Minted`, `Success`, or settled PnL
And only `Ethereum final` permits a success claim.

### Scenario 10: Phase 2 cannot mutate

Given a Phase 2 web client or Telegram message
When it requests a refresh, follows a canonical link, filters, paginates, or
views an alert
Then only a read operation occurs
And no approval, promotion, arm, run, pause, kill, retry, exclusion, funding,
validation, reservation, nonce, signing, broadcast, or policy mutation is
possible through `v1`.

### Scenario 11: Redaction and retention are enforceable

Given a response, issue, notification, or telemetry payload is serialized
When redaction checks run
Then keys, credentials, endpoint values, raw calldata, signed bytes, provider
payloads, and secret paths are absent
And projection/alert records expire at 30 days while audit records remain for 90
days with policy evidence.

## 13. Baseline and Eligibility Review

Review date: 2026-09-18

### Review basis

- Baseline was verified as clean `origin/main` at `29d837c` before these
  documentation-only edits.
- The baseline has no `packages/web` tree and no tracked JSX/TSX frontend
  source. No frontend code, browser transport, or execution mutation was added
  by this handoff.
- Reviewed `Frontend_SKILLS.md`, `PRODUCT_SPEC.md`,
  `PRODUCT_DESIGN_SPEC.md`, `PLAN_Frontend.md`, `PLAN_Backend.md`,
  `PLAN_Database.md`, Backend read-model/application contracts, Database read
  models, and current chain/finality mappings.

### Checklist

| Check | Status | Evidence and limitation |
|---|---|---|
| Phase 1 has no frontend implementation | **PASS** | Phase 1 remains CLI-only; the baseline contains no web package and this change contains documentation only. |
| Phase 2 scope is reconciled | **PASS** | Product, Design, and Frontend Plan now agree on read-only web intelligence/readiness/calendar/reminder/status views and outbound-only Telegram alerts. |
| Canonical campaign and wallet-readiness states | **PASS as contract** | The contract preserves canonical campaign labels and wallet states, including `Unknown`, `Ready`, `Failed`, and `Skipped`; readiness remains per wallet and campaign. |
| Safety gates versus desirability score | **PASS as boundary** | Score, confidence, evidence, and gate are separate fields. Backend/Store permission and simulation policy remain authoritative. |
| Freshness and retention defaults | **PASS as contract** | Readiness is 5 minutes; discovery/calendar is 15 minutes; critical alerts are immediate; non-critical reminders are grouped; read-model/alert retention is 30 days; audit retention is 90 days. |
| Robinhood paid-mint block and staged finality | **PASS fail-closed** | Compatibility evidence does not enable execution; `Included` and `Posted to Ethereum` are not success; `Ethereum final` is required. Technical mapping fixtures remain a Backend/Blockchain dependency. |
| Reorg, abort, cancellation, and unknown outcomes | **PASS as required shape; dependency pending** | The contract requires history, typed reasons, provenance, and retry policy; Backend/Database must provide fixtures before implementation. |
| No secret or browser-chain access | **PASS by contract and absence** | The allowlisted projection prohibits keys, credentials, endpoint values, calldata, raw transactions, signer access, and browser RPC. |

### Eligibility verdict

- Product/design contract: **ACCEPTED BASELINE**.
- Frontend implementation: **NOT ELIGIBLE** until every dependency gate in §11
  has accepted fixtures and the Engineering Lead records the phase gate.
- Live execution or capital authorization: **NOT GRANTED** by this document.

## 14. Contract Handoff

- Artifact: `docs/frontend-phase2-read-model-api-contract.md`
- Baseline: clean `origin/main@29d837c` before docs changes.
- Reconciled documents: `PLAN_Frontend.md`, `PRODUCT_SPEC.md`, and
  `PRODUCT_DESIGN_SPEC.md`.
- Product Owner decision captured: one local operator; read-only web Phase 2;
  outbound-only Telegram; 5-minute readiness freshness; 15-minute
  discovery/calendar freshness; immediate critical alerts; grouped reminders;
  30-day read-model/alert retention; 90-day audit retention.
- Implementation changes: none. No frontend code, secrets, credentials, or
  execution authorization were added or requested.
- Required recipients: Engineering Lead, Backend, Database,
  Blockchain/CTO, DevOps/Notifications, and future Frontend implementation.
- Validation performed: baseline branch/status inspection; document and code
  contract review; scope, mutation, state, freshness, retention, and redaction
  consistency checks. Runtime tests are not applicable to this documentation
  handoff.
- Integration status: **NOT ELIGIBLE** until the dependency evidence in §11 is
  delivered and accepted. Any Phase 3 mutation must be separately versioned,
  authenticated, confirmation-gated, and audited.
