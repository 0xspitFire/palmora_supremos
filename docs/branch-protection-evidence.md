# Branch Protection Evidence

## Scope

This record applies to the protected integration branch (`phase1-integration`),
not `main`. DevOps does not change repository protection settings; a repository
administrator must apply and verify them remotely.

## Required Settings

| Setting | Required value | Evidence |
| --- | --- | --- |
| Pull request before merge | Enabled | **Not configured** in the 2026-09-15 read-only query |
| Required checks | `environment`, `verify`, `anvil`, `docker` | Mapped in `docs/ci-required-checks.md`; **not configured** |
| Up-to-date branch | Required | **Not configured** in the 2026-09-15 read-only query |
| Force pushes | Disabled | **Not verified**; protection is not configured |
| Branch deletion | Disabled | **Not verified**; protection is not configured |
| Ordinary bypass actors | None | **Not verified**; protection is not configured |

The `anvil` check is the strict archive replay gate. It must not be satisfied
by a skipped, todo, or vanilla-Anvil-only run. The local Ethereum and Robinhood
strict replays now pass; remote required-check evidence remains pending.

## Redacted Verification Record

| Field | Value |
| --- | --- |
| Branch | `phase1-integration` |
| Repository | `[REPOSITORY_REFERENCE]` |
| Verification actor | `[REDACTED_ADMIN_ID]` |
| Verification time (UTC) | `[UTC_TIMESTAMP]` |
| Required checks observed | `environment`, `verify`, `anvil`, `docker` |
| Pull request required | `false` observed; administrator action required |
| Up-to-date required | `false` observed; administrator action required |
| Force pushes allowed | `not applicable until protection is configured` |
| Deletion allowed | `not applicable until protection is configured` |
| Secret values observed | `none` |

The administrator may use the repository provider's branch-protection API or
UI to verify the settings. Do not paste access tokens, resolved endpoints,
workflow secret values, or other credentials into this file or a handoff.

## Blocker

The 2026-09-15 read-only query found no protection configuration on
`phase1-integration`. An authenticated repository administrator must configure
the required settings, then rerun the redacted verification record. This is a
release blocker and is not changed by local test results.
