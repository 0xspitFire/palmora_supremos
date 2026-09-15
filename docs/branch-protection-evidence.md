# Branch Protection Evidence

## Scope

This record applies to the protected integration branch (`phase1-integration`),
not `main`. DevOps does not change repository protection settings; a repository
administrator must apply and verify them remotely.

## Required Settings

| Setting | Required value | Evidence |
| --- | --- | --- |
| Pull request before merge | Enabled | Pending admin verification |
| Required checks | `environment`, `verify`, `anvil`, `docker` | Mapped in `docs/ci-required-checks.md` |
| Up-to-date branch | Required | Pending admin verification |
| Force pushes | Disabled | Pending admin verification |
| Branch deletion | Disabled | Pending admin verification |
| Ordinary bypass actors | None | Pending admin verification |

The `anvil` check is the strict archive replay gate. It must not be satisfied
by a skipped, todo, or vanilla-Anvil-only run. The Ethereum strict replay is a
release-candidate dependency until its approved fixture is available.

## Redacted Verification Record

| Field | Value |
| --- | --- |
| Branch | `phase1-integration` |
| Repository | `[REPOSITORY_REFERENCE]` |
| Verification actor | `[REDACTED_ADMIN_ID]` |
| Verification time (UTC) | `[UTC_TIMESTAMP]` |
| Required checks observed | `environment`, `verify`, `anvil`, `docker` |
| Pull request required | `[PENDING]` |
| Up-to-date required | `[PENDING]` |
| Force pushes allowed | `[PENDING]` |
| Deletion allowed | `[PENDING]` |
| Secret values observed | `none` |

The administrator may use the repository provider's branch-protection API or
UI to verify the settings. Do not paste access tokens, resolved endpoints,
workflow secret values, or other credentials into this file or a handoff.

## Blocker

Remote verification is not claimed by this branch because it requires an
authenticated repository-administration action outside the worktree.
