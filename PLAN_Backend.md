# Backend Engineering Plan

## Mandate

Build the application operating shell around the engine: orchestration, durable state, APIs, readiness, notifications, and jobs. Do not reimplement blockchain primitives, access keys, or let Telegram/UI become a security boundary.

## Phase plan

### Phase 1: CLI-compatible application boundary

- Define typed application commands for resolve, validate, prepare, simulate, arm dry-run, live arm, execute, health, and kill.
- Keep CLI dry-run default-on. Live arm requires explicit mode, frozen spend policy, evidence/simulation snapshot, and typed campaign identifier.
- Introduce run IDs generated with a collision-resistant scheme and persist the run before any execution admission.
- Build an engine adapter that passes immutable intents and reservation tokens, then translates engine facts into canonical application states.
- Normalize errors into stable taxonomy and safe operator copy. Redact calldata, credentials, passphrases, provider payloads, and key material before logs or notifications.

### Phase 2: Orchestrator and operational shell

- Implement one long-running orchestrator process with persistent jobs, T-minus scheduling against chain-time offset, idempotency keys, and bounded concurrency.
- On boot, enter `Reconciling`; reconcile every in-flight transaction by wallet/nonce/hash before accepting new live work. Unknown is not silently failed or succeeded.
- Add durable spend reservations covering worst-case mint value plus gas ceiling and buffer. Atomic reservation is required across workers and restarts; settle/release on authoritative outcome.
- Wire file and programmatic kill switch into a shared cancellation model. Check before reservation, signing, and every wallet broadcast. Mark remaining work `Aborted`; preserve submitted work.
- Add one-way Telegram channel with recorded delivery state for started, succeeded, failed, aborted, kill, cap, and underfunded events. Links target canonical run records.

### Phase 3: controlled operations

- Formalize Campaign and FireLane state machines. Separate proposal approval from `ARM LIVE CAMPAIGN`.
- Implement readiness as `(wallet, campaign)`, combining chain, balance, eligibility, proof, constructibility, simulation freshness, and gas policy with field-level reasons.
- Add adaptive stops and typed retry permission. Retry is never generic; it is allowed only when persisted nonce, cap, and error state make it safe.
- Add calendar registry and eligibility sweeps with source authority, verification time, expiry, and unknown distinct from ineligible.
- Add two-way Telegram only after authenticated operator identity, scoped immutable IDs, replay protection, explicit second confirmation, consequence copy, and durable audit events.

### Phase 4-5

- Implement opportunity lifecycle `discovered → evaluating → scored → notified → approved → promoted | rejected | expired`; retain evidence, score inputs, model version, confidence, freshness, risks, and gate results.
- Build deterministic `v1-rules` scoring as a replaceable service. Score expresses desirability; safety gates express permission and always win.
- Add tracked-wallet ingestion consumers, convergence deduplication, replication verdict handling, and operator-approved campaign promotion.
- Add analytics jobs over immutable facts: FIFO lots, realized versus floor-marked unrealized estimates, coverage, gas/fee cost, false positives, and attribution.

## Service contracts

- `ExecutionCoordinator`: accepts a validated campaign and returns run identity plus state transitions; never signs.
- `ReadinessService`: returns per-wallet checks, freshness, source block, and blocking reason.
- `SpendLedger`: `reserve`, `settle`, `release`, and `available`; all atomic and chain/campaign scoped.
- `NotificationDispatcher`: idempotent event delivery with retry/backoff and delivery status.
- `OpportunityService`: evidence collection, score snapshot, gate evaluation, and disposition transitions.
- `Query API`: read-mostly local API over the store for future CLI/web parity; no multi-user auth or tenancy in V1.

## Canonical state rules

Use PM/design labels exactly: campaign `Draft`, `Validating`, `Ready`, `Armed`, `Active`, `Paused`, `Completed`, `Failed`, `Aborted`, `Cancelled`; wallet readiness `Unknown`, `Unfunded`, `Funded`, `Eligible`, `Ready`, `Executing`, `Minted`, `Failed`, `Skipped`; execution `Prepared`, `Signed`, `Submitted`, `Pending`, `Confirmed`, `Reorged`, `Replaced`, `Failed`.

`Failed` means technical/execution completion failure. `Aborted` means kill, cap, or adaptive stop ended remaining work. Partial wallet results survive either state. Notifications are not authoritative proof of execution.

## API and event behavior

Every command is idempotent or carries an idempotency key. Every response includes canonical ID, state, next action, timestamps, retryability, and blocking reason where relevant. Emit auditable events for approval, arm, reservation, simulation, admission, broadcast attempt, reconciliation, state transition, kill, and notification delivery.

The UI and Telegram consume these records. They must not infer blockchain truth, mutate local success state, or bypass backend guards.

## Tests and done criteria

- Unit tests for state guards, reservations under concurrency, daily UTC boundaries, idempotency, retry classification, readiness freshness, scoring, and notification deduplication.
- Integration tests for restart after submission, mid-fleet kill, partial failure, reorg downgrade, Telegram failure, and safe redaction.
- Exit requires unattended scheduled execution that survives restart, reconstructs from records, cannot overspend pending exposure, and reports truthful per-wallet results.

## Challenges and decisions

- SQLite/WAL is the default for personal scale, but must pass Windows and VPS locking, backup, corruption, and restart tests before being locked.
- The scoring formula references undefined `N0`; expose sample coverage until a versioned baseline is decided. Never display it as calibrated probability.
- Do not call floor value profitability. Use `realized`, `unrealized floor-marked estimate`, or `unknown` with source, fees, coverage, and freshness.
- Telegram `/approve` semantics must be finalized before Phase 3: proposal approval and live arm remain separate, and live spend requires explicit confirmation.

## Dependencies and outputs

Consumes blockchain facts and engine outcomes; consumes schema/repository interfaces from Database; supplies stable API/event/read models to CLI, future Frontend, and Notifications. Signing and low-level chain truth remain outside Backend ownership.
