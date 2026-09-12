# W3 Recovery Inventory

> Live recovery record. Update this file whenever a fragment is integrated, archived, validated, or removed. Do not mark a fragment cleaned until its useful contents are accounted for.

## Recovery policy

- `main` is the release branch, not automatically the most complete fragment.
- `phase1-integration` is the Product Owner-selected canonical Phase 1 source pending final merge approval.
- Do not prune, force-reset, rewrite history, or delete recovered folders while an item is uncertain.
- Keep secrets and resolved RPC values out of source, logs, summaries, and recovery archives.
- Require Product Owner confirmation before merging recovered implementation into `main`.

## Current baseline

| Item | State |
| --- | --- |
| Main branch | `64a0068`; two local commits ahead of `origin/main` (`84451d0`, `64a0068`) |
| Main repair | `public-mempool.ts` restored from canonical implementation and committed as `84451d0` |
| Canonical Phase 1 source | `phase1-integration` at `cc6aee2`, clean and equal to `origin/phase1-integration` |
| Canonical PR | PR #6, open, merge state `DIRTY`; isolated candidate resolves its single `packages/engine/src/types.ts` conflict |
| CTO PR | PR #7, open from `cto-restored`; `cto-2` is an exact clean duplicate worktree at `b29fdd0` |
| Git integrity | Reachable objects repaired from a fresh GitHub mirror; no reachable object is missing |
| GitHub | Authenticated as `0xspitFire`; private repository readable; push dry-run succeeds |
| Runtime | Project-pinned Node `20.19.1` used from an isolated portable runtime; pnpm `9.15.4` |

## Surviving worktrees and branches

| Source/location | Role | Branch / commit | Classification | Unique work and conflicts | Validation | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| Project root | Main | `main` / `64a0068` | Current baseline, incomplete | Broadcaster repair and recovery documentation are local. Main lacks the integrated Backend, Database, hardened engine, CI, and operations stack. | Install passes; typecheck/build fail on viem client typing; lint cannot start because ESLint is undeclared; no tracked tests are found. | Keep. Do not push until approved. |
| `.kilo/recovered-phase1-integration` | Integration | `phase1-integration` / `cc6aee2` | Canonical recovery source | 118-file Phase 1 delta over main. Conflicts with current main in `packages/engine/src/types.ts`; fork/runtime release evidence remains incomplete. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, and 95 tests pass. Seven fork tests skip without Anvil/fixtures. Runtime health fails closed as intended without production config. | Keep until merged and post-merge validated. |
| `C:\Users\hamid\AppData\Local\Temp\kilo\w3-phase1-main-candidate` | Integration candidate | `recovery/phase1-main-candidate` / `04ae291` | Ready for Product Owner merge decision | `main` plus `phase1-integration`; retained both `CHAIN_NOT_VERIFIED` and `INVALID_CONFIG` error types. No unresolved conflicts. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, and 95 tests pass. Seven fork tests skip; health and strict fork launcher fail closed without production configuration. | Keep until final merge decision and post-merge validation. |
| `.kilo/recovered-backend-engineer` | Backend | `backend-engineer` / `370d7c0` | Already integrated | Tip is an ancestor of `phase1-integration`. | Worktree clean; published remotely. | Retain through merge; later removable after ancestry recheck. |
| `.kilo/recovered-blockchain-engineer` | Blockchain | `blockchain-engineer` / `157368e` | Already integrated by equivalent commit | Tip is patch-equivalent to canonical `b99ac68`. | Worktree clean; published remotely. | Retain through merge. |
| `.kilo/recovered-database-engineer` | Database | `database-engineer` / `f84bb64` | Already integrated by equivalent commit | Tip is patch-equivalent to canonical `c6e1106`. | Worktree clean; published remotely. | Retain through merge. |
| `.kilo/recovered-devops-engineer` | DevOps | `devops-engineer` / `d62bf48` | Integrated with context adaptation | Canonical `2f1558c` carries the same 78-line runtime/recovery change adapted to the integrated stack. | Worktree clean; published remotely. | Retain through merge. |
| `.kilo/recovered-engineers` | Engineering Lead | `engineers` / `b94180d` | Superseded integration line | `b94180d` is patch-equivalent to canonical `f45ccfe`. Report-only `a71d9bc` is not in canonical history, but canonical later blocker/status documents supersede it. Previously accidental deletions were restored; worktree is clean. | Published remotely after object refetch. | Keep as historical integration branch through merge. |
| `.kilo/recovered-cto` | CTO | `cto-restored` / `b29fdd0` | Already integrated | Tip is an ancestor of canonical Phase 1 and contains `CTO_Brief.md`. | Worktree clean; published remotely. | Keep while PR #7 remains open. |
| `.kilo/worktrees/cto-2` | CTO | `cto-2` / `b29fdd0` | Exact duplicate | Same commit and tree as `cto-restored`; Agent Manager associates it with PR #7. | Worktree clean. | Keep until PR #7 disposition is decided. |
| `.kilo/recovered-frontend-engineer` | Frontend | `frontend-engineer` / `43ad380` | Duplicate baseline | Initial commit only; no frontend implementation, consistent with Phase 1 scope. | Worktree clean; published remotely. | Removable after canonical merge and documentation check. |
| `.kilo/recovered-product-design-spec` | Product Design | `product-design-spec` / `43ad380` | Duplicate baseline | Branch has no design-spec commit. The historical design file survived only in the stale archive. | Worktree clean; published remotely. | Keep until archived design document is curated. |
| Local refs only | Misc. stale branches | `chemical-bittersweet`, `cto`, `lead-engineer`, `recovered-product-design-spec` at `3e44906` | Obsolete duplicates | All point to the former `main` tip and contain no branch-only commit. | No registered worktrees. | Delete only after final integration and Product Owner cleanup approval. |

## Archived stale filesystem snapshots

The broken, unregistered `.kilo/worktrees/*` copies were byte-for-byte archived, excluding `.git`, `node_modules`, and generated `dist`, under `stale-worktree-archive/` before removal.

| Archive | Classification | Notes |
| --- | --- | --- |
| `stale-worktree-archive/product-design-spec` | Unique historical document plus superseded code | Contains a longer historical `PRODUCT_DESIGN_SPEC.md` with a different hash from the canonical root design spec. Preserve for curation. |
| `stale-worktree-archive/engineers` | Superseded snapshot | Older alternate source and planning documents; every non-generated path was preserved before the broken copy was removed. |
| `stale-worktree-archive/blockchain-engineer` | Superseded snapshot | Older blockchain implementation; later specialist and canonical branches contain evolved versions. |
| `stale-worktree-archive/database-engineer` | Superseded snapshot | Older database implementation; recovered branch adds later migration and integration work. |
| `stale-worktree-archive/backend-engineer` | Superseded snapshot | Older backend implementation; recovered branch contains later CLI and readiness work. |
| `stale-worktree-archive/devops-engineer` | Superseded snapshot | Older DevOps implementation; recovered branch and canonical integration contain later gates. |
| `stale-worktree-archive/frontend-engineer` | Duplicate snapshot | No unique non-generated content found relative to the recovered frontend baseline. |
| `stale-worktree-archive/cto` | Duplicate/superseded snapshot | Product specs and CLI file match surviving root versions; recovered CTO branch has the later brief. |

Do not commit the whole archive as product source. Curate unique historical documents, then obtain cleanup approval.

## Untracked root fragments

| Fragment | Classification | Required action |
| --- | --- | --- |
| `Robinhood Technical Report` | Unique, valuable technical evidence | Preserve and decide a safe tracked documentation filename during integration. It contains public transaction evidence but no secret endpoint value. |
| `Ref Hashes` | Duplicate subset | The five public failed-transaction references are already explained in `Robinhood Technical Report`; keep until report curation is complete. |
| `seadrop-test/` | Obsolete/uncertain scratch repository | Unborn nested Git repository with default Foundry `Counter` files and damaged/incomplete submodules. No project SeaDrop test implementation was found. Preserve until Product Owner approves deletion. |
| `stale-worktree-archive/` | Recovery backup | Keep until all unique documents are curated and canonical integration is accepted. |

## Protected recovery commits

The following previously dangling commits are protected under `refs/recovery/dangling/*` so normal maintenance cannot collect them:

| Recovery ref suffix | Commit | Classification |
| --- | --- | --- |
| `database-pr-merge-abb0b85` | `abb0b85` | Historical PR merge; database work is integrated in canonical history. |
| `backend-pr-merge-2ae9f3f` | `2ae9f3f` | Historical PR merge; backend work is integrated in canonical history. |
| `blockchain-pre-rebase-ccd9af8` | `ccd9af8` | Pre-rebase blockchain snapshot; later branch/canonical work supersedes it. |
| `devops-pre-rebase-d051cf0` | `d051cf0` | Pre-rebase DevOps snapshot; later branch/canonical work supersedes it. |
| `devops-original-8882c9b` | `8882c9b` | Original DevOps snapshot before rebase. |
| `initial-pre-amend-73dc451` | `73dc451` | Initial commit before amend; `43ad380` is the surviving amended baseline. |
| `cto-pr-merge-f11c0ec` | `f11c0ec` | Historical CTO PR merge; CTO brief is integrated in canonical history. |
| `engineers-wip-0bc7d16` | `0bc7d16` | Historical WIP snapshot adding `Rets` ignores that later branches contain in expanded form. |

Original incomplete WIP commit `ad16926` lost its stash-index parent during the earlier prune. Its surviving snapshot tree is byte-identical to first parent `cc02f95`, so it contains no unique working-tree content. Its hash remains documented here, but no ref points to the structurally broken commit.

## Validation record

### Canonical `phase1-integration`

- `pnpm install --frozen-lockfile`: pass under Node `20.19.1` and pnpm `9.15.4`.
- `pnpm ops:clean-checkout`: pass.
- `pnpm lint`: pass.
- `pnpm ops:secret-boundary`: pass.
- `pnpm ops:policy`: pass with CI-equivalent conservative environment values.
- `pnpm ops:negative-cases`: pass.
- `pnpm ops:recovery-drill`: pass using temporary non-production paths.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- `pnpm test -- --reporter=dot`: 95 pass, 7 skip.
- `pnpm test:fork`: command exits successfully but all 7 fork tests skip because Anvil and approved fixtures are unavailable. This is not fork evidence.
- `pnpm ops:health`: expected fail-closed result without production secret-store, store, RPC, verification, reconciliation, and finality configuration.

### Isolated `recovery/phase1-main-candidate`

- `pnpm install --frozen-lockfile`: pass under Node `20.19.1` and pnpm `9.15.4`.
- `pnpm ops:clean-checkout`: pass before and after validation.
- `pnpm lint`: pass.
- `pnpm ops:secret-boundary`: pass.
- `pnpm ops:policy`: pass with CI-equivalent conservative environment values.
- `pnpm ops:negative-cases`: pass.
- `pnpm ops:recovery-drill`: pass using temporary non-production paths.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- `pnpm test -- --reporter=dot`: 95 pass, 7 skip across 12 passed test files and 2 skipped fork files.
- `pnpm test:fork`: 7 tests skip because Anvil and approved fixtures are unavailable. This is not fork evidence.
- `pnpm ops:fork-replay`: fail closed because the candidate has no copied `Rets/MINT_BOT_SECRETS.env` reference. The secret was intentionally not copied.
- `pnpm ops:health`: fail closed because production secret-store, store, RPC, verification, reconciliation, and finality configuration is absent.

### Current `main`

- `pnpm install --frozen-lockfile`: pass.
- `pnpm typecheck`: fail with five viem client account-type errors in `packages/engine/src/mint-engine.ts`.
- `pnpm build`: fail on the same errors.
- `pnpm lint`: fail because the declared command requires ESLint but ESLint is not installed.
- `pnpm test`: no test files found; exits zero because the config permits no tests.
- `pnpm test:fork`: no fork files found; exits zero.

## Pending decisions and gates

1. Obtain Product Owner approval before merging `recovery/phase1-main-candidate` into `main` or pushing it.
2. Curate the untracked Robinhood report and historical product-design document.
3. Recreate and commit the nine live role skill documents.
4. Decide PR #7 disposition and remove only obsolete local branches/worktrees afterward.
5. Keep Robinhood execution disabled until strict fork, sequencer/feed correlation, restart/replacement/reorg/kill-switch, backup/restore, finality, and Product Owner evidence gates pass.
