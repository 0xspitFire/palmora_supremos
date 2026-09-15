# Backup And Restore Evidence

## Contract

- SQLite snapshots are created with the database backup API, encrypted with
  AES-256-GCM, and accompanied by a SHA-256 sidecar.
- The encrypted keystore is backed up separately; it is never combined with a
  database dump or written into CI artifacts.
- `BACKUP_RETENTION_DAYS` is exactly `30`.
- Restore occurs on an isolated host with the kill switch already engaged.
- Restore evidence includes checksum, encryption-header validation, SQLite
  integrity, schema version, and post-restore chain reconciliation.
- The backup encryption key is injected by the approved secret mechanism and
  is never written to this repository, a command argument, a log, or evidence.

## Reproducible Non-Production Drill

Run from the native WSL worktree only:

```text
pnpm ops:environment
pnpm ops:recovery-drill
```

The drill creates temporary non-production paths and an ephemeral key, runs
the backup script, restores the encrypted snapshot into a temporary database,
checks SQLite integrity, verifies the kill switch, and removes all temporary
files on completion.

## Redacted Evidence Record

| Field | Value |
| --- | --- |
| Worktree | `/home/Junayd/W3/MintBot/[MANAGED_WORKTREE]` |
| Backup operation | `[PASS_OR_BLOCKED]` |
| Restore operation | `[PASS_OR_BLOCKED]` |
| Snapshot reference | `[REDACTED_FILENAME]` |
| SHA-256 | `[REDACTED_CHECKSUM]` |
| Schema version | `[SCHEMA_VERSION]` |
| Kill switch | `engaged` |
| Retention | `30 days` |
| Raw secrets accessed by evidence collector | `none` |

Production acceptance is blocked until the encrypted keystore backup,
off-host retention, isolated restore, credential rotation/revocation, and
post-restore reconciliation are witnessed by the Lead and Product Owner.
