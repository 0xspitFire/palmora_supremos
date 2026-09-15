# Phase 1 CLI Contract Handoff

> Product Design handoff · 2026-09-14
> Scope: contract-only; no UI or execution implementation
> Implementation integration: **NOT ELIGIBLE**

This handoff defines the operator-facing contract for the Phase 1 Execution
Foundation. It is a design contract for the CLI, copy, state presentation, and
future read models. It does not define signing, broadcasting, chain truth,
schema internals, or product scope independently.

## Artifact index

- Primary handoff: `docs/product-design-phase1-cli-contract.md`
- Live design guidance: `Product_Designer_SKILLS.md`
- Canonical product sequence and state language: `PRODUCT_DESIGN_SPEC.md`
- Canonical product scope and acceptance criteria: `PRODUCT_SPEC.md`
- Recovery and evidence constraints: `RECOVERY_INVENTORY.md`
- Historical design input reviewed: `/home/Junayd/W3/recovery-input/stale-worktree-archive/product-design-spec/PRODUCT_DESIGN_SPEC.md`

The canonical root specifications take precedence over the historical archive.
The historical archive supplied useful CLI, recovery, and copy patterns only.

## 1. Scope And Boundary

Phase 1 is a CLI-only safe execution foundation. The CLI is the only operator
surface that can approve, arm, run, or kill work in this phase. There is no
Phase 1 web execution surface, dashboard control, web route, or two-way Telegram
control to build from this handoff.

The CLI is not authoritative. Backend application state, Database records, and
Blockchain/engine facts are authoritative. CLI output renders those records and
must not infer success, readiness, finality, retryability, or spend from local
flags.

The canonical operator path is:

```text
health -> reconcile when required -> resolve/validate/prepare
       -> approve -> arm -> run -> summary
```

`kill` is available at any point. It is a safety stop, not a cancellation of
transactions already submitted. No one-step live mint command is part of the
contract. A convenience command may exist only when it cannot bypass the same
approval, arm, admission, reservation, signer, reconciliation, and finality
boundaries.

## 2. Copy And Output Rules

### 2.1 Human-readable status grammar

Use the canonical grammar for each non-terminal presentation:

```text
[STATE] · [subject] · [what happens next]
```

Every explanatory error answers three questions in order:

```text
What happened -> Why it matters -> Safe next action
```

Do not use a generic `success`, `done`, `continue`, `submit`, `force`, or
`retry` label for a spend-affecting result. Use scoped verbs such as `Run check
again`, `Inspect`, `Exclude wallet`, `Reconcile`, and `ARM LIVE CAMPAIGN`.

### 2.2 Mode is separate from lifecycle state

Show the control mode on every run and every command result:

- `Dry run`: preparation only; no signing, broadcast, live nonce mutation, or mint claim.
- `Approval required`: exact scope is awaiting explicit operator acknowledgement.
- `Live`: bounded live spend may occur only after all Backend gates pass.
- `Blocked`: a required gate, dependency, or recovery condition prevents the action.

`Dry run`, `Approval required`, `Live`, and `Blocked` are control labels, not
new campaign or transaction states. A dry run must never be rendered as
`Minted`, `Confirmed`, or a successful live execution.

### 2.3 Machine-readable response envelope

Human copy and JSON output use the same authoritative values. At minimum, a
response includes:

- canonical `id` and related campaign/run IDs;
- canonical state and explicit mode;
- `nextAction` and `retryable`;
- `createdAt`, `updatedAt`, and `checkedAt` where applicable;
- `freshUntil` or evidence age where a gate depends on freshness;
- typed `blockingReason` and source/evidence IDs where applicable;
- wallet counts and per-wallet records for execution summaries.

Do not include private keys, passphrases, provider credentials, raw provider
payloads, raw calldata, or secret endpoint values in copy, JSON, logs, or error
messages.

## 3. Command Contract

The public names below are the design contract. The current adapter's internal
`execute` operation may remain an implementation detail, but the operator
command is `run` and it must use the persisted run snapshot.

| Command | Data source | Allowed action | Blocked or unsafe action |
|---|---|---|---|
| `approve <campaign-id>` | Backend campaign, readiness, evidence, and policy snapshot | Record an explicit acknowledgement of the exact prepared scope | Does not arm, reserve, sign, broadcast, or create an unbounded spend permission |
| `arm <campaign-id> --mode dry-run\|live` | Backend canonical campaign plus approval, health, readiness, and freshness gates | Create an immutable run/intent snapshot and move `Ready -> Armed` | No mode change, scope change, signing, or broadcast after arm |
| `run <run-id>` | Persisted run/intent plus Backend admission and engine facts | Execute the already armed snapshot, or prepare it when mode is `Dry run` | Cannot create a campaign, change scope, bypass kill/caps, or submit a duplicate run |
| `summary <run-id>` | Database/Backend canonical run, attempts, receipts, reservations, and events | Read and explain current or terminal results | Cannot mutate state, retry, release evidence, or imply finality |
| `health` | Runtime probes, Backend state, chain verification, and recovery status | Readiness inspection | Cannot clear kill, arm, run, or declare transaction success |
| `reconcile [<run-id>]` | Durable intents/attempts plus Blockchain/engine observations | Reconcile and append authoritative recovery facts | Cannot sign, broadcast, choose a fresh nonce, or convert unknown to failed/success |
| `kill` | File sentinel plus shared Backend runtime control | Engage the global stop and block future spend checkpoints | Cannot recall submitted transactions or silently delete reservations/history |

### 3.1 `approve <campaign-id>`

In Phase 1, approval is an append-only operator acknowledgement of a prepared
campaign. It is not a new campaign lifecycle state and it is not permission to
broadcast. There is no Phase 1 opportunity proposal flow; do not use this
command to imply a Phase 2/4 score or discovery decision.

The review must show:

- campaign ID, target contract, strategy, chain, and schedule;
- selected wallet count and wallet identifiers safe for display;
- quantity and maximum mint value;
- estimated gas, gas ceiling, buffer, per-mint cap, and rolling daily cap;
- chain verification/readiness status and broadcaster route;
- per-wallet or justified wallet-class simulation result, source block, check time, and expiry;
- excluded wallets and their reasons;
- current kill-switch and runtime health state;
- the consequence that approval records this scope but does not arm or spend.

The operator must type the displayed campaign ID. Approval is rejected when the
campaign is not `Ready`, a required check is stale or unknown, a simulation
failed, or a hard chain/policy gate is blocked.

Required copy:

```text
READY · camp_123 · Approval required
Ethereum · SeaDrop public · 8 wallets
Mint value: 0.64 ETH · Gas ceiling: 0.09 ETH · Daily remaining: 1.20 ETH
Simulation: 8/8 pass · checked 00:42 ago · valid until 00:02:18

This records approval of this exact scope only. It does not arm, sign, or send
transactions. Type camp_123 to record approval.
```

After the acknowledgement, keep the campaign in `Ready` and show:

```text
READY · camp_123 · Approval recorded; arm remains required
No transaction was signed or sent. Next: ARM DRY RUN or ARM LIVE CAMPAIGN.
```

If the review cannot be approved:

```text
BLOCKED · camp_123 · Simulation for W04 is stale
Live arm is unavailable. Run the check again or exclude W04; no transaction
will be sent.
```

Failed simulation is a hard block. The only recovery choices are inspect the
typed reason, exclude the affected wallet where policy permits, or run the
setup check again. There is no general force option.

### 3.2 `arm <campaign-id> --mode ...`

Arm is the commitment boundary for a future run. It creates a run and immutable
intent snapshot only after Backend admission. The snapshot includes the exact
wallet scope, policy, evidence, simulation IDs, chain verification, fee
policy, and requested mode. Later configuration changes cannot rewrite what was
armed.

`ARM DRY RUN` and `ARM LIVE CAMPAIGN` are distinct final controls:

- `ARM DRY RUN` permits preparation only and must not sign, broadcast, mutate live nonce state, or claim a mint.
- `ARM LIVE CAMPAIGN` requires explicit live mode, prior approval, a typed campaign ID, current health, completed startup reconciliation, fresh required evidence, and every live safety gate.

Live arm is allowed only when all of the following are authoritative and
current:

- campaign is `Ready` and the approval snapshot matches the requested scope;
- store is durable and atomic across processes;
- startup is `Ready`, not `Cold`, `Reconciling`, or `Blocked`;
- required chain, signer, engine, and backup dependencies are ready;
- kill switch is not engaged;
- chain identity and execution verification pass;
- every selected wallet is funded, eligible, constructible, and simulation-OK under the applicable freshness policy;
- fee, value, per-mint, daily, and gas policies are within bounds;
- Robinhood-specific operational evidence is accepted and execution-enabled, if that chain is ever enabled.

Arm does not mean `Active`, and it does not mean a transaction has been
submitted. Durable spend reservations are created at the run admission boundary
before signing/broadcast, not inferred from the CLI review.

Required dry-run copy:

```text
READY · camp_123 · Dry run approval recorded
ARM DRY RUN will prepare 8 wallets without signing or broadcasting.
No live nonce, balance, reservation, or mint result will be changed.
Next: ARM DRY RUN.
```

Required live confirmation copy:

```text
READY · camp_123 · Approval required
ARM LIVE CAMPAIGN will authorize bounded future spend for 8 wallets.
Mint value: 0.64 ETH · Gas ceiling: 0.09 ETH · Per-mint cap: 0.80 ETH
Daily remaining: 1.20 ETH · Simulation: 8/8 pass · checked 00:42 ago
Chain: Ethereum · Route: private orderflow with configured fallback

Live submissions may be irreversible and a failed transaction may consume gas.
The kill switch stops future admission but cannot recall submitted transactions.
Type camp_123 to confirm ARM LIVE CAMPAIGN.
```

Successful arm copy:

```text
ARMED · camp_123 · Run run_7F2 is waiting for its trigger
No transaction has been signed or sent. Next: run run_7F2.
```

Blocked Robinhood copy:

```text
BLOCKED · camp_123 · Robinhood Chain 4663 execution gate is not passing
SeaDrop-v1 compatibility evidence is not enablement. No transaction will be
sent. Resolve the named verification, recovery, or finality gate first.
```

Blocked paid Robinhood copy:

```text
BLOCKED · camp_123 · Paid-mint policy is not approved for Robinhood 4663
An explicit value and exposure policy is required. No live arm is available.
```

### 3.3 `run <run-id>`

Run executes only the immutable run that was created by `arm`. It must not
accept new contract, wallet, quantity, fee, cap, or mode values. Repeating the
same run command is idempotent: it returns the existing run/summary or a
state-conflict response and never creates a second submission.

For `Dry run`, the engine prepares the complete pipeline minus signing and
broadcast. It must not consume live nonces or report `Minted`, `Confirmed`, or
live `success`.

For `Live`, Backend performs durable atomic reservation before any signing or
broadcast. Pending exposure counts toward caps. Admission checks the kill
switch before reservation, before signing, and immediately before every wallet
broadcast. Wallet admission is cancellation-aware and serialized at the
irreversible boundary. One wallet's failure does not stop other wallets unless
a typed safety or adaptive stop applies.

Run transitions use the canonical campaign lifecycle:

```text
Ready -> Armed -> Active -> Completed
                    |-> Failed
                    |-> Aborted
```

`Cancelled` is reserved for user cancellation before active execution. A kill
switch, spend-cap breach, or adaptive safety stop produces `Aborted`. Technical
or execution inability produces `Failed`. Do not create a `Partial` lifecycle
state; retain partial results at wallet and transaction level.

Required start copy:

```text
ACTIVE · run_7F2 · 3 of 8 wallets admitted · Other wallets continue
Live spend is bounded by the recorded reservation and cap policy.
Next: monitor run_7F2 or use kill if a safety stop is required.
```

Required dry-run result copy:

```text
PREPARED · run_7F2 · Dry run checked 8 wallets
0 signed · 0 submitted · 0 minted · 0 live spend
Next: inspect the preparation result; live arm remains a separate action.
```

Required isolated failure copy:

```text
FAILED · run_7F2 · W04 failed: NONCE_CONFLICT · Other wallets continued
Retry is available only if the persisted error, nonce, reservation, and cap
state make it safe. Reconcile before any retry; no generic retry is offered.
```

Required kill or cap stop copy:

```text
ABORTED · run_7F2 · Kill switch stopped future wallet admission
Submitted: 3 · Not submitted: 5
Already-submitted transactions cannot be recalled and may still settle.
Next: reconcile submitted work before considering any recovery action.
```

### 3.4 `summary <run-id>`

Summary is a read-only reconstruction from canonical Backend/Database records.
It must not be a local success counter or a replacement for the durable audit
record. Show aggregate counts first, then per-wallet details.

The summary includes:

- run, campaign, intent, mode, and current canonical state;
- selected wallet count and counts by `Ready`, `Executing`, `Minted`, `Failed`, and `Skipped`;
- transaction state per wallet, including every attempt, replacement, hash, nonce, and receipt reference that is safe to display;
- chain-specific finality stage and whether the result is authoritative;
- submitted, final, reorged, failed, and unresolved counts;
- actual gas/value versus the frozen ceiling and cap consumption;
- reservation state, including pending exposure that remains held;
- simulation/evidence age and source block for readiness-related context;
- typed reason, continuation result, and retryability for each failure;
- last reconciliation time and the next safe action.

Required all-dry-run copy:

```text
PREPARED · run_7F2 · Dry run complete
8/8 prepared · 0 signed · 0 submitted · 0 live spend
This is not a mint result. Next: inspect preparation or arm live explicitly.
```

Required partial failure copy:

```text
FAILED · run_7F2 · 7 wallets reached Ethereum final; 1 wallet failed
W04: NONCE_CONFLICT · Other wallets continued · Retry: unavailable pending
reconciliation
```

Required unresolved copy:

```text
ACTIVE · run_7F2 · 1 submitted transaction has an unknown outcome
The receipt is not authoritative yet. No new nonce or duplicate broadcast will
be issued. Next: reconcile run_7F2.
```

Required reorg copy:

```text
REORGED · run_7F2 · W07 was downgraded during reconciliation
Earlier inclusion is not final success. Accounting remains under review.
Next: reconcile again under the chain confirmation policy.
```

### 3.5 `health`

Health is read-only operational readiness, not execution proof. It reports
whether the required dependencies can safely admit a live run. It must not
declare a mint successful and must not clear a kill switch.

The check report names each result and its age/reference without exposing
values:

- process and runtime state;
- durable store and cross-process atomicity;
- chain ID and endpoint identity/health;
- signer availability through the signer boundary;
- backup/recovery readiness;
- startup reconciliation state and unresolved executions;
- chain verification and evidence freshness;
- kill-switch state;
- notification delivery as an operational signal.

Phase 1 has no Telegram control surface. If notification readiness is displayed
before its Phase 2 dependency is active, label it `Not required for Phase 1`
rather than making a false Phase 1 product dependency. Any dependency required
by the live runtime remains blocking when absent or stale.

Required ready copy:

```text
READY · runtime · Live admission checks pass
Kill switch: clear · Startup: Ready · Reconciliation: current
This is operational readiness, not proof that a transaction will succeed.
Next: review and arm an eligible campaign.
```

Required blocked copy:

```text
BLOCKED · runtime · 2 live-admission checks need attention
Reconciliation is required and chain verification is stale. No live arm or run
will be admitted. Next: reconcile, refresh the named checks, then run health.
```

Required killed copy:

```text
BLOCKED · runtime · Kill switch active
New spend checkpoints are blocked. Already-submitted transactions may still
settle. Next: inspect affected runs and reconcile; clearing the switch requires
the recovery procedure.
```

### 3.6 `reconcile [<run-id>]`

Reconcile is a safe recovery command that may write authoritative observations
to the durable record, but it never signs or broadcasts. Startup enters
`Reconciling` and must complete reconciliation before live work is accepted.

Reconciliation searches by transaction hash and `(wallet, nonce)`, retains all
attempts and replacement relationships, and applies the chain profile's finality
policy. A missing receipt, endpoint timeout, or contradictory response remains
`unknown` until evidence resolves it. It is never silently converted to
`Failed`, `Confirmed`, or `Minted`.

Required in-progress copy:

```text
RECONCILING · runtime · 2 in-flight runs are being checked
No new live spend will be admitted while reconciliation is in progress.
Next: wait for authoritative results and run summary.
```

Required resolved copy:

```text
RECONCILED · run_7F2 · 7 final, 1 failed, 0 unresolved
Attempts and receipts were preserved in the canonical record.
Next: inspect the summary; retry only where the typed policy permits it.
```

Required unknown copy:

```text
BLOCKED · run_7F2 · Receipt outcome remains unknown
The endpoint did not provide authoritative evidence. No duplicate nonce or
automatic retry will be issued. Next: restore endpoint health and reconcile.
```

### 3.7 `kill`

`kill` engages the global file-based and programmatic stop. It is intentionally
usable when the normal API or operator surface is unavailable. It blocks future
admission checkpoints, including between individual wallet submissions, and
marks remaining work `Aborted` when a run is safety-stopped.

Kill does not:

- recall or reverse a transaction already submitted to a chain;
- turn a submitted transaction into a failed transaction merely because the stop was engaged;
- delete attempts, receipts, reservations, logs, or audit history;
- authorize a later retry or clear itself automatically.

Unadmitted wallet work is recorded as `Skipped` with a kill reason. Submitted
work remains visible through its actual `Submitted`, `Included`, `Posted to
Ethereum`, `Ethereum final`, `Reorged`, `Replaced`, or `Failed` path. Unsubmitted
reservations may be released according to the durable ledger; submitted
exposure remains held until authoritative settlement or reconciliation.

Required copy:

```text
ABORTED · global run control · Kill switch engaged
No new spend will pass an admission checkpoint.
Submitted transactions cannot be recalled and may still settle.
Next: inspect affected runs and reconcile submitted work.
```

Repeated kill requests return the already-engaged state without creating a new
ambiguous action. A clear/reset action is not part of ordinary CLI operation;
it requires the documented recovery approval and a fresh health/reconciliation
cycle.

## 4. Canonical State, Finality, Freshness, And Retry

### 4.1 Lifecycle labels

Use the exact labels below in user-facing output. Do not introduce `Partial`,
`Success`, or `Confirmed` as a substitute campaign result.

Campaign:

```text
Draft -> Validating -> Ready -> Armed -> Active -> Completed
                                          |-> Failed
                                          |-> Aborted
                                          |-> Cancelled
```

Wallet in campaign:

```text
Unknown -> Unfunded -> Funded -> Eligible -> Ready -> Executing -> Minted
                                                               |-> Failed
                                                               |-> Skipped
```

Transaction/execution:

```text
Prepared -> Signed -> Submitted -> Included -> Posted to Ethereum -> Ethereum final
                    |-> Replaced  |-> Reorged |-> Failed
```

`Failed` is technical or execution inability. `Aborted` is a safety, kill, cap,
or adaptive stop ending remaining work. `Cancelled` is pre-active user
cancellation. Partial wallet results survive every terminal campaign outcome.

### 4.2 Robinhood finality

Display Robinhood as:

```text
Robinhood Chain 4663 · ETH · Direct to sequencer · First-come ordering
```

Do not use Ethereum mempool, Flashbots, bundle, or queue-jumping language for
Robinhood. `Included` and `Posted to Ethereum` are intermediate observations,
not success. Only `Ethereum final` permits the product to report a successful
Robinhood mint or move the wallet to `Minted`.

Positive SeaDrop-v1 characterization is evidence, not execution enablement. An
unverified, stale, or operationally blocked 4663 gate hides live arm and says
that no transaction will be sent. Paid Robinhood mints remain blocked until an
explicit value and exposure policy is approved.

For a Robinhood FREE mint, show zero mint value and separately identify the
independent worst-case L2 execution-gas reserve, L1 data-gas reserve, and
priority-fee policy component. Do not present the priority component as a
guarantee of ordering.

### 4.3 Freshness and unknowns

Readiness is always evaluated for `(wallet, campaign)`, not as a permanent
wallet property. Every readiness or evidence result carries checked time,
source block/source ID, expiry or freshness policy, and the exact blocker.

- `Unknown` eligibility is not `Ineligible`.
- Missing or expired simulation is not `Ready`.
- A failed simulation is a hard block, not a retryable execution error.
- Stale chain, funding, eligibility, policy, or runtime data blocks live arm according to its gate policy.
- A dry run can show preparation facts, but cannot refresh live permission by itself.
- Health and summary show age and source; they never hide stale data behind a green aggregate.

Freshness copy uses the safe next action:

```text
BLOCKED · W04 · Simulation expired 00:18 ago
Live arm is unavailable. Run check again or exclude W04; no force option exists.
```

### 4.4 Retry permission

Retryability is a typed Backend decision, not a button implied by an error.
Retry is available only when the durable record proves that the wallet, nonce,
reservation, cap, fee policy, and error class make the specific retry safe.

- Simulation failure: inspect, exclude, or rerun setup simulation only.
- Timeout, `already known`, missing receipt, or advanced nonce: reconcile by hash and nonce before any retry.
- Replacement: preserve every hash and use only the bounded same-nonce policy.
- Reorg: downgrade and reconcile accounting; do not retry from a client guess.
- Unknown outcome: block new work for the affected exposure; never issue a fresh nonce automatically.
- Immutable terminal results: no retry unless Backend explicitly marks a scoped recovery action as valid.

Use this copy whenever retry is not safe:

```text
FAILED · W04 · Retry unavailable because the submission outcome is unresolved
No second nonce will be issued. Next: reconcile the attempt and review the
authoritative record.
```

## 5. Phase Boundary

### Phase 1: CLI-only execution foundation

Allowed:

- CLI wallet maintenance, preparation, approval acknowledgement, explicit arm, run, summary, health, reconcile, and kill;
- Backend/Database durable records and engine integration needed to make those commands safe;
- structured logs and local operational evidence.

Blocked:

- web execution routes, dashboard arm/run controls, browser signing, or client-side chain calls;
- two-way Telegram commands;
- opportunity discovery, scoring-driven execution, calendar controls, replication, analytics, or a Phase 1 web execution surface;
- any shortcut that bypasses Backend admission or the immutable run snapshot.

### Phase 2: read-only intelligence and readiness

Phase 2 may deliver consumer-friendly web intelligence/readiness views and
one-way Telegram alerts when their read models and dependencies are accepted.
These surfaces are read-only/read-mostly:

- they may display campaign/readiness/run/health records, freshness, gates, evidence, and alerts;
- they may link to canonical records;
- they may not approve, arm, run, pause, kill, mutate policy, sign, broadcast, or infer success;
- Telegram delivery is not execution proof and cannot become a security boundary.

If a Phase 2 surface shows an unavailable control, omit it or label the feature
as unavailable. Do not render an empty or disabled execution dashboard as if
Phase 1 web controls exist.

### Phase 3: controlled operations

Phase 3 introduces campaign/fire-lane operational views and narrowly scoped
Backend mutations for `Approve proposal`, `ARM LIVE CAMPAIGN`, `Pause lane`, and
`Kill all`. Each action remains explicit, scoped to an immutable campaign/run,
confirmation-gated, auditable, and subject to the same state, freshness,
reservation, retry, kill, and finality rules.

`Approve proposal` in Phase 3 means proposal approval/campaign creation. It is
not live spend. `ARM LIVE CAMPAIGN` remains a separate commitment and typed
confirmation. Web and Telegram call Backend transitions; neither calls an RPC
or signs directly.

## 6. Decisions

1. Phase 1 remains CLI-only; no web execution surface is authorized.
2. The public operator sequence is explicit: `approve -> arm -> run -> summary`.
3. Approval records acknowledgement of a frozen prepared scope; it does not arm or broadcast.
4. Arm creates the immutable run/intent snapshot. Live arm requires typed campaign-ID confirmation and all current gates.
5. Run executes only an already armed snapshot. A one-step live mint shortcut is not an acceptable product path.
6. Dry run never signs, broadcasts, mutates live nonce state, or reports a mint.
7. Backend/Database records and Blockchain/engine facts remain authoritative; CLI output is a projection.
8. Kill blocks future admission and marks remaining work `Aborted`; submitted transactions remain observable and may settle.
9. Unknown and stale outcomes remain visible and block unsafe actions. They are never guessed into success or failure.
10. Retry is typed and scoped; reconciliation precedes retry for ambiguous submissions, replacements, and reorgs.
11. Robinhood 4663 remains execution-blocked until integrated operational evidence passes. Compatibility evidence alone cannot enable it, and `Ethereum final` is the only success boundary.
12. Phase 2 is read-only/read-mostly intelligence and readiness; Phase 3 adds controlled web and two-way Telegram mutations through Backend.

## 7. Acceptance Scenarios

### Scenario 1: dry run has no spend consequence

Given a prepared campaign with eight selected wallets
When the operator approves, arms in dry-run mode, and runs the run ID
Then every result is `Prepared` or an explicit typed preparation failure
And no wallet is signed, broadcast, or marked `Minted`
And the summary says `0 signed`, `0 submitted`, and `0 live spend`.

### Scenario 2: live arm is separate from approval

Given a current `Ready` campaign and matching approval snapshot
When the operator invokes live arm without typing the displayed campaign ID
Then the action is blocked
And no run is armed and no transaction is signed or sent.

When the operator types the exact ID and all gates pass
Then the campaign/run becomes `Armed`
And the copy says no transaction has yet been signed or sent.

### Scenario 3: stale simulation blocks live arm

Given W04 has an expired simulation
When the operator reviews or arms the campaign
Then the action says `BLOCKED`, names W04 and the check age
And offers only inspect, exclude where permitted, or run the check again
And no force action is shown.

### Scenario 4: unknown eligibility remains unknown

Given eligibility proof for W02 is unavailable
When readiness or summary is rendered
Then W02 is `Unknown`, not `Ineligible`
And live arm is blocked with the missing proof/read path as the next action.

### Scenario 5: per-wallet failure is isolated

Given eight wallets are admitted and W04 receives a typed nonce error
When the run continues
Then W04 is `Failed`, other wallets continue, and all attempt facts remain
visible
And retry is shown only if Backend marks the specific error safe.

### Scenario 6: kill stops future admission only

Given three wallets are submitted and five remain unadmitted
When the operator invokes `kill`
Then the run/campaign is `Aborted`, five wallets are recorded as `Skipped`,
and no later wallet crosses an admission checkpoint
And the copy states that the three submitted transactions cannot be recalled.

### Scenario 7: cap breach is durable

Given concurrent workers approach the per-mint or daily cap
When the next reservation would exceed the cap
Then the atomic reservation is refused, remaining work is `Aborted`,
and pending exposure is included in cap accounting
And no process-local counter or CLI retry can overspend the cap.

### Scenario 8: ambiguous receipt does not create a duplicate

Given a broadcast timeout or `already known` response
When the operator runs or repeats `reconcile`
Then attempts are matched by hash and wallet/nonce
And the outcome remains `unknown` until authoritative evidence exists
And no fresh nonce or duplicate broadcast is issued automatically.

### Scenario 9: Robinhood staged finality is truthful

Given a Robinhood transaction is `Included` or `Posted to Ethereum`
When the operator reads the run summary
Then the result says it is waiting for `Ethereum final`
And the wallet is not `Minted` and the run is not reported as successful.

### Scenario 10: reorg downgrades prior observation

Given a previously observed inclusion or finality record changes during
reconciliation
When the Blockchain/Backend record reports a reorg
Then the state is `Reorged`, accounting is reconciled, and prior evidence is
retained
And no success or retry is inferred by the CLI.

### Scenario 11: restart blocks new live work

Given an in-flight run exists when the process starts
When the runtime begins recovery
Then health reports `Reconciling`/`Blocked` and live arm/run is unavailable
until every candidate has an authoritative reconciliation result
And unknown work is not silently failed or succeeded.

### Scenario 12: health is not execution proof

Given all runtime health checks pass
When the operator runs `health`
Then the output says operational readiness only
And it does not report any transaction as successful or arm a campaign.

### Scenario 13: Phase 2 cannot mutate execution

Given a Phase 2 read-only web or Telegram surface
When the operator views readiness, an active run, or an alert
Then it may show canonical records, freshness, and next safe actions
But it cannot approve, arm, run, pause, kill, sign, broadcast, or infer success.

### Scenario 14: Phase 3 controls remain Backend-gated

Given Phase 3 control surfaces exist
When the operator approves a proposal or confirms live arm
Then the action is scoped to a canonical ID and calls a Backend transition
And approval remains distinct from live arm, with consequence copy and an audit record.

## 8. Handoff Routing And Dependencies

All coordination routes through the Engineering Lead. This document is not an
implementation request and is **NOT ELIGIBLE** for integration until the Lead
accepts the contract and the owning specialists provide evidence.

| Owner | Receives from Product Design | Must provide/confirm | Dependency |
|---|---|---|---|
| Engineering Lead | Command names, copy, phase boundary, decisions, scenarios | Integration order, accepted API/event contract, explicit rejection of one-step live bypass, and final eligibility decision | PM/CTO scope and specialist evidence |
| Backend | State/action matrix, response envelope, approval/arm/run semantics, safe consequences | Idempotent command handlers, authoritative transitions, typed blocking/retryability, immutable snapshots, and no CLI bypass | Database repositories plus Blockchain facts |
| Database | Required summary/read-model fields and immutability expectations | Durable approval/policy/evidence snapshots, attempts/receipts/reservations/events, freshness/source fields, and reconstruction queries | Backend transition contract and chain facts |
| Blockchain | Finality labels, chain-specific route language, typed error/retry inputs | Per-wallet simulation evidence, attempts/replacements, receipt/reorg/finality facts, and Robinhood execution gate | Chain characterization and engine tests |
| Frontend | Phase 2 read-only and Phase 3 control boundary | No Phase 1 implementation; later screens consume the same read models and route all mutations through Backend | Accepted Backend/Database read models and Lead phase gate |

Required cross-team handoff fields are: data source, allowed action, blocked
action, canonical transition, freshness/unknown behavior, retryability,
explanatory copy, audit event, and test/evidence reference.

## 9. Current Repository Alignment Notes

These are handoff observations, not implementation changes:

- `packages/cli/src/index.ts` currently has `health`, `kill`, `reconcile`, and `arm` plumbing, but does not yet expose the complete `approve`, `run`, or `summary` contract.
- The current public `execute` operation maps to the contract's `run` concept; the operator-facing name must not permit scope or mode changes.
- The current `mint` convenience path accepts a live mode flag and combines arm plus execution. It is not an acceptable Phase 1 live contract until the Lead/Backend path proves the same explicit approval, arm, admission, reservation, signer, kill, reconciliation, and finality boundaries. Prefer removing or restricting the one-step live form.
- Backend/adapter technical labels such as `Pending` and `Confirmed` must map to the canonical user-facing transaction/finality labels without using generic success copy.
- `PLAN_Frontend.md` contains a no-Phase-2-dashboard statement that conflicts with the canonical root specs' Phase 2 read-only intelligence/readiness surfaces. The Lead should reconcile that plan; this handoff does not authorize any frontend implementation.
- No secrets, wallet material, provider credentials, or secret endpoint values are required by this contract.

## 10. Definition Of Handoff Complete

The Product Design slice is complete when the Engineering Lead can route this
artifact to Backend, Database, Blockchain, and Frontend with the following
understanding:

- Phase 1 has one explicit CLI control path and no web execution surface.
- Approval, arm, and run have separate consequences and immutable scope.
- Summary, health, and reconcile are truthful read/recovery views.
- Kill semantics state exactly what stops and what cannot be recalled.
- Canonical lifecycle, Robinhood finality, freshness, unknown, partial failure,
  and typed retry semantics are preserved.
- Phase 2 is read-only/read-mostly and Phase 3 is the first web/Telegram control
  phase.
- Integration remains **NOT ELIGIBLE** until the Lead accepts the contract and
  required implementation/test evidence exists.
