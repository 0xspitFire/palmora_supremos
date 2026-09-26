# Engineering Review — Current State

Review date: 2026-09-26
Canonical baseline: `origin/main@1164403`
Scope: Phase 1 Execution Foundation, Phase 2 Intelligence MVP, and deferred live-readiness gates.

## Executive Verdict

**Phase 1:** Complete for the Product Owner-approved local/controlled-testing scope. Production/live readiness remains deferred.

**Phase 2:** Integrated and corrective controls are merged. Read-only web, read-model, scheduler, database, Telegram, and operational boundaries are present. Further feature hardening may continue through protected PRs.

**Production/live execution:** NO-GO. No live transaction has been broadcast. Turnkey Verifiable Cloud attestation is conditionally waived pending waitlist access.

## Current Scorecard

| Area | Status | Current evidence |
| --- | --- | --- |
| Blockchain | Complete for local scope | Turnkey policy/signing boundary, Ethereum and Robinhood characterization, staged finality, receipt/recovery tests, and no-broadcast canaries are integrated. |
| Backend | Complete for approved Phase 2 scope | Orchestration, read-only API projections, readiness, reconciliation, notification contracts, dry-run enforcement, and mode guards are integrated. |
| Database | Complete for approved Phase 2 scope | Normalized migrations, durable jobs/read models, reservations, backup evidence, recovery projections, and invariant tests are integrated. |
| Frontend | Complete for approved read-only scope | Read-model client and read-only intelligence/readiness surfaces are integrated without browser RPC or signer access. |
| DevOps | Complete for local/CI scope | Protected CI, WSL runner, Docker, SQLite, service/backup configuration, redaction, and Telegram transport checks are integrated. |
| Security | Pass with conditional attestation | Secret boundary, redaction, policy, signer, custody, and protected merge checks pass. TVC Boot/App Proofs remain waived. |
| Product alignment | Pass | Phase 1 CLI-only and Phase 2 read-only web/Telegram boundaries match the approved specification. |
| Live readiness | Deferred | Production host, off-host backup, live wallet rotation, finality operations, and live broadcast approval remain outside the local exit. |

## Audit Findings Disposition

### Fleet Simulation and Gas Evidence — Fixed

Per-wallet simulation, funding, gas, and policy evidence are now represented in the durable/read-model path. Turnkey non-broadcast canaries passed for three wallets with recovered addresses matching the configured wallet map.

### Spend Caps and Reservations — Fixed for Current Scope

Spend reservations are durable, scoped, and tested. Phase 2 GET projections use read-only calculations and do not refresh or mutate spend summaries.

### Kill Switch and Admission — Fixed for Current Scope

Phase 2 scheduling is forced to dry-run/read-only mode. Live mode and job/run mode mismatches are rejected. Live mutation controls remain Phase 3 work.

### Signer Boundary — Fixed

Production Turnkey signing uses the `Signer` interface and validates the returned transaction’s chain, nonce, target, value, calldata, fee fields, and recovered address. The engine does not need raw wallet keys.

### Dry-Run Semantics — Fixed

Dry-run does not sign, broadcast, mutate live nonce state, or report a live-success result. Logs use transaction digests rather than raw serialized transactions.

### Reconciliation, Replacement, and Reorgs — Fixed for Integrated Scope

Durable attempt, receipt, reconciliation, recovery, and staged-finality projections are present. Successful completion requires the configured final reconciliation/finality result; intermediate confirmation is not treated as final settlement.

### CLI and Operator Workflow — Fixed for Local Scope

Wallet generation/import/listing, dry-run, health, kill-switch, Turnkey import, signer health, and protected CI workflows are implemented. Production service deployment remains deferred.

### Backend, Database, and Telegram — Fixed for Approved Phase 2 Scope

The Backend and Database remain authoritative. Phase 2 provides read-only projections and one-way Telegram delivery. Telegram credentials are host-secret-only and no mutation commands are exposed.

### Robinhood Execution — Intentionally Deferred

Robinhood characterization is recorded and strict replay evidence exists, but execution remains disabled until separate operational, sequencer, finality, backup, and live-rehearsal gates are approved.

### Turnkey Verifiable Cloud Attestation — Conditionally Waived

Turnkey secure-enclave custody is accepted temporarily as HSM-equivalent. Boot/App Proof retrieval is deferred until Verifiable Cloud access and `TURNKEY_APP_NAME` are available. The waiver is recorded outside git and does not authorize live broadcasting.

## Validation Evidence

The current integrated work has recorded the following evidence:

- Lint: pass.
- Typecheck: pass.
- Build: pass.
- Full Phase 2 corrective suite: 393 passed, 20 explicit fork skips.
- Secret-boundary checks: pass.
- Policy checks: pass.
- Negative safety cases: pass.
- Recovery drill: pass.
- Protected CI: `environment`, `verify`, `anvil`, and `docker` pass on the integrated corrective line.
- Ethereum strict replay: pass when approved fixture references are injected.
- Robinhood strict replay: pass for characterization cases; execution remains disabled.
- Turnkey organization authentication: pass.
- Turnkey policy/interface creation: pass.
- Encrypted wallet import: pass.
- Turnkey signer health: HTTP 200.
- Turnkey non-broadcast signing canaries: 3/3 pass.
- End-to-end Turnkey CLI dry-run: 3/3 wallet simulations pass.
- Blockchain broadcasts: zero.

## Phase 1 Exit Status

Phase 1 is complete for the approved local/controlled-testing boundary.

The following remain deferred and do not invalidate that local exit:

- Production host/service-account provisioning.
- Persistent production SQLite deployment.
- Encrypted off-host backup and isolated restore.
- Live wallet rotation and funding.
- Live transaction broadcast authorization.
- Turnkey Verifiable Cloud proof retrieval.
- Production finality/reconciliation operations.

## Phase 2 Exit Status

Phase 2 is integrated for the approved read-only web plus one-way Telegram scope.

Hard boundaries remain enforced:

- No browser RPC.
- No signer or wallet-key access from frontend code.
- No execution mutation endpoints.
- No Telegram commands, callbacks, approvals, arm, kill, or retry mutations.
- No discovery path may submit or sign transactions.
- Read models preserve `unknown`, `stale`, `blocked`, `partial`, and `unavailable` as distinct states.

## Remaining Human Actions

1. Keep the Turnkey attestation waiver active until Verifiable Cloud access is granted.
2. Provide `TURNKEY_APP_NAME` through the host secret store when available, then rerun the attestation verifier.
3. Choose and provision the production host/service account, persistent SQLite path, kill-switch ownership, and off-host backup destination before live deployment.
4. Approve live wallet rotation and funding only after production evidence is green.
5. Retain the single-owner Telegram recipient policy; any future recipient access-code mechanism requires a separate product decision.

## Remaining Engineering Actions

- Maintain protected PR review and CI for all future changes.
- Keep Phase 3 execution controls separate from Phase 2 read-only APIs.
- Add production host/backup/finality evidence when live readiness is reopened.
- Revisit TVC proof collection when Turnkey waitlist access is granted.

## Final Recommendation

**Phase 1 local exit: GO.**

**Phase 2 approved read-only development: GO.**

**Production/live execution: NO-GO until the deferred human-owned operational and custody evidence is complete.**
