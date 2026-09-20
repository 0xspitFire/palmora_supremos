# Service And Host Evidence

## Phase 2 Status

**Status:** operational scaffolding prepared, not enabled. The tree now contains
`packages/cli/src/orchestrator-service.ts`, a durable scheduler, loopback health
and metrics endpoints, redacted rotating logs, encrypted-backup status output,
and the outbound-only Telegram notifier. The checked-in unit/config templates
are proposals for local WSL/host provisioning; no production/live readiness or
execution-gate approval is implied.

The service remains blocked until the host contract below is supplied and the
existing safety gates, startup reconciliation, and human approvals are accepted.

## Required Host Contract

| Area | Required control | Redacted evidence |
| --- | --- | --- |
| Account | Dedicated unprivileged service account | `[PENDING_HOST_PROVISIONING]` |
| State | Persistent SQLite WAL path outside the release tree | `[PENDING_HOST_PROVISIONING]` |
| Custody | Encrypted keystore path outside the release tree | `[PENDING_HOST_PROVISIONING]` |
| Kill switch | Existing before service start; reset requires recovery approval | `[PENDING_DRILL]` |
| Time | UTC clock and NTP synchronization | `[PENDING_HOST_PROVISIONING]` |
| Supervision | Restart-on-failure with bounded restart policy | `[PENDING_UNIT_REVIEW]` |
| Health | Status-only liveness/readiness probe; no operator booleans | `[PENDING_DRILL]` |
| Logs | Structured JSON, redacted, rotated, disk-bounded | `[PENDING_HOST_PROVISIONING]` |
| Alerts | Process, RPC, reconciliation, disk, backup, cap, kill, notification | `[PENDING_HOST_PROVISIONING]` |
| Rollback | Immutable release artifact rollback without deleting state/evidence | `[PENDING_DRILL]` |

## Service Acceptance Drill

Before enabling a service, run `pnpm ops:environment`, install the pinned
artifact, engage the kill switch, run `pnpm ops:health`, restart the process,
and reconcile all in-flight work before clearing the switch. Capture only
exit codes, named checks, timestamps, schema versions, and redacted artifact
names. A health or notification result is not transaction execution evidence.

## Backup Timer Contract

The checked-in host timer template invokes `pnpm ops:backup` with explicit state and
backup paths, retain encrypted snapshots for exactly 30 days, and preserve the
checksum sidecar. The encryption key is injected by the host secret mechanism
only for the process lifetime. A corresponding restore drill must verify the
checksum, encryption header, SQLite integrity, schema version, engaged kill
switch, and post-restore chain reconciliation in an isolated host.

No resolved host credential or secret value is present in this repository; the
checked-in service/timer files are non-secret templates only. Provisioning and
acceptance remain Lead/Product Owner gates.
