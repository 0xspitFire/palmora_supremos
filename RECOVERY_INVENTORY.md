# W3 Recovery Inventory

> Live recovery record. Update this file whenever a fragment is integrated, archived, validated, or removed. Do not mark a fragment cleaned until its useful contents are accounted for.

## Recovery policy

- `main` is the release branch, not automatically the most complete fragment.
- `phase1-integration` was the Product Owner-selected canonical Phase 1 source and is now merged into `main`.
- Do not prune, force-reset, rewrite history, or delete recovered folders while an item is uncertain.
- Keep secrets and resolved RPC values out of source, logs, summaries, and recovery archives.
- Require Product Owner confirmation before future recovered implementation merges or live enablement.

## Current baseline

| Item | State |
| --- | --- |
| Main branch | `853ee41`; synchronized with `origin/main` |
| Main repair | `public-mempool.ts` restored from canonical implementation and committed as `84451d0` |
| Canonical Phase 1 source | `phase1-integration` at `cc6aee2`, merged into `main` through candidate `f72d83a` |
| Canonical PR | PR #6, merged; isolated candidate resolved its single `packages/engine/src/types.ts` conflict |
| CTO PR | PR #7, merged from `cto-restored`; duplicate `cto-2` checkout removed and branch retained |
| Git integrity | Reachable objects repaired from a fresh GitHub mirror; no reachable object is missing |
| GitHub | Authenticated as `0xspitFire`; private repository readable; push dry-run succeeds |
| Runtime | Project-pinned Node `20.19.1` used from an isolated portable runtime; pnpm `9.15.4` |
| Agent Manager | All stale session records were stopped; orphaned worktree-only metadata remains because the API exposes no record-only delete and `.kilo/agent-manager.json` is not to be edited manually |

## Surviving worktrees and branches

| Source/location | Role | Branch / commit | Classification | Unique work and conflicts | Validation | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| Project root | Main | `main` / `853ee41` | Integrated Phase 1 baseline, not live-ready | Broadcaster repair, recovery documentation, Backend, Database, hardened engine, CI, and operations stack are now published. Robinhood execution remains gated. | Main install, typecheck, build, lint, secret boundary, policy, negative cases, recovery drill, and 95 tests pass. Seven fork tests skip; strict fork replay fails without Anvil. Clean-checkout is intentionally blocked by preserved untracked recovery artifacts. | Keep. Synchronized with `origin/main`. |
| `.kilo/recovered-phase1-integration` (removed) | Integration | `phase1-integration` / `cc6aee2` | Integrated canonical source | Its 118-file Phase 1 delta is included in `main` through merge candidate `f72d83a`; fork/runtime release evidence remains incomplete. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, and 95 tests pass. Seven fork tests skip without Anvil/fixtures. | Worktree removed; branch retained. |
| `C:\Users\hamid\AppData\Local\Temp\kilo\w3-phase1-main-candidate` (removed) | Integration candidate | `recovery/phase1-main-candidate` / `f72d83a` | Merged into main | Candidate contains `main` plus `phase1-integration`; both `CHAIN_NOT_VERIFIED` and `INVALID_CONFIG` are retained. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, and 95 tests pass. Seven fork tests skip; health and strict fork launcher fail closed without production configuration. | Worktree removed; branch retained. |
| `.kilo/recovered-backend-engineer` (removed) | Backend | `backend-engineer` / `370d7c0` | Already integrated | Tip is an ancestor of `phase1-integration` and therefore `main`. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-blockchain-engineer` (removed) | Blockchain | `blockchain-engineer` / `157368e` | Already integrated by equivalent commit | Tip is patch-equivalent to canonical `b99ac68`. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-database-engineer` (removed) | Database | `database-engineer` / `f84bb64` | Already integrated by equivalent commit | Tip is patch-equivalent to canonical `c6e1106`. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-devops-engineer` (removed) | DevOps | `devops-engineer` / `d62bf48` | Integrated with context adaptation | Canonical `2f1558c` carries the same 78-line runtime/recovery change adapted to the integrated stack. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-engineers` (removed) | Engineering Lead | `engineers` / `b94180d` | Superseded integration line | `b94180d` is patch-equivalent to canonical `f45ccfe`. Report-only `a71d9bc` is not in canonical history, but canonical blocker/status documents supersede it. Previously accidental deletions were restored; worktree is clean. | Published remotely after object refetch. | Worktree removed; branch retained. |
| `.kilo/recovered-cto` (removed) | CTO | `cto-restored` / `b29fdd0` | Already integrated | Tip is an ancestor of canonical Phase 1 and contains `CTO_Brief.md`; PR #7 is merged. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/worktrees/cto-2` (removed) | CTO | `cto-2` / `b29fdd0` | Exact duplicate | Same commit and tree as merged `cto-restored`; Agent Manager associated it with PR #7. | Worktree clean. | Worktree removed; branch retained. |
| `.kilo/recovered-frontend-engineer` (removed) | Frontend | `frontend-engineer` / `43ad380` | Duplicate baseline | Initial commit only; no frontend implementation, consistent with Phase 1 scope. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-product-design-spec` (removed) | Product Design | `product-design-spec` / `43ad380` | Duplicate baseline | Branch has no design-spec commit. The historical design file survives in the stale archive. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| Local refs only | Misc. stale branches | `chemical-bittersweet`, `cto`, `lead-engineer`, `recovered-product-design-spec` at `3e44906` | Obsolete duplicates | All point to the former `main` tip and contain no branch-only commit. | No registered worktrees. | Preserve until final branch-retention review; delete only with explicit approval. |

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
| `lib/` | Removed duplicate | The untracked root `lib/seadrop` contained 168 files, all byte-identical to files in the complete `seadrop-test/lib/seadrop` submodule, with no root-only content. It was removed after comparison. |
| `seadrop-test/` | Valuable external fixture source, not integrated | Unborn nested Git repository with a default Foundry `Counter` harness and a complete SeaDrop submodule containing upstream Solidity/Hardhat/Foundry tests. No project-specific W3 fork test is wired to it. Preserve for fixture curation. |
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

- The tracked tree is identical to the validated `recovery/phase1-main-candidate` at `f72d83a`, with only the recovery-inventory update added afterward.
- `pnpm install --frozen-lockfile`: pass.
- `pnpm typecheck`: pass after forced reconciliation of generated dependencies.
- `pnpm build`: pass.
- `pnpm lint`: pass after removing generated `.ignored_*` dependency copies.
- `pnpm ops:secret-boundary`: pass.
- `pnpm ops:policy`: pass with CI-equivalent conservative environment values.
- `pnpm ops:negative-cases`: pass.
- `pnpm ops:recovery-drill`: pass with `sqlite-backup-restore` and kill switch engaged.
- `pnpm test -- --reporter=dot`: 95 pass, 7 skip across 12 passed test files and 2 skipped fork files.
- `pnpm ops:clean-checkout`: intentionally fails in the project root because preserved untracked recovery artifacts remain.
- `pnpm test:fork`: 7 tests skip because Anvil and approved fixtures are unavailable.
- `pnpm ops:fork-replay`: fails because the Anvil binary is unavailable.
- `pnpm ops:health`: fails closed with missing secret-store, store, RPC, chain-verification, reconciliation, and finality configuration.

## Pending decisions and gates

1. Curate the untracked Robinhood report and historical product-design document.
2. Decide whether to retain or delete obsolete local branches after a final branch-list review.
3. Curate or explicitly retire the nested `seadrop-test/` fixture repository and the stale-worktree archive.
4. Install/configure Anvil and approved archive fixtures before treating fork replay as evidence.
5. Keep Robinhood execution disabled until strict fork, sequencer/feed correlation, restart/replacement/reorg/kill-switch, backup/restore, finality, and Product Owner evidence gates pass.
