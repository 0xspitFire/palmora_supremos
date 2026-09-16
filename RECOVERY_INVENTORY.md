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
| Main branch | native WSL clone at `~/W3/MintBot`, synchronized with `origin/main` at `57e1e95` |
| Main repair | `public-mempool.ts` restored from canonical implementation and committed as `84451d0` |
| Canonical Phase 1 source | `phase1-integration` plus reviewed closure patches, merged into `main` through candidate `57e1e95` |
| Canonical PR | PR #6, merged; isolated candidate resolved its single `packages/engine/src/types.ts` conflict |
| CTO PR | PR #7, merged from `cto-restored`; duplicate `cto-2` checkout removed and branch retained |
| Git integrity | Reachable objects repaired from a fresh GitHub mirror; no reachable object is missing |
| GitHub | Authenticated as `0xspitFire`; private repository readable; push dry-run succeeds |
| Runtime | Native WSL Node `20.19.1`, npm `10.8.2`, pnpm `9.15.4`, Git `2.53.0`, Foundry/Anvil `1.8.1`; `~/.foundry/bin` is on login-shell PATH |
| Recovery bundle | `/home/Junayd/W3-rsync-recovery.bundle`; verified complete and imported under `refs/recovery/*` in the native clone |
| Approved artifact input | `/home/Junayd/W3/recovery-input/`; report hashes match Windows source and stale archive is checksum-equivalent |
| Windows fallback | `C:\Users\hamid\AGravity\W3` remains intact as a fallback; its `Rets/` secrets were not copied into the active clone |
| Old rsync copy | `~/W3/MintBot-rsync-preserved` is an intentional operational backup, not a usable checkout; it contains `Rets/` including the archive reference and must remain isolated from development |
| Agent Manager | Completed specialist sessions are stopped; one idle CTO session remains. Seven orphaned worktree-only records remain as UI metadata, while no corresponding physical Git worktrees remain. |

## Surviving worktrees and branches

| Source/location | Role | Branch / commit | Classification | Unique work and conflicts | Validation | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| Project root | Main | `main` / `57e1e95` | Integrated Phase 1 baseline, not live-ready | CTO source of truth, Database 015/identity, Backend reservation metadata, Blockchain Robinhood evidence, Lead closure status, and Frontend read-model contract are published. Robinhood execution remains gated. | Main install, typecheck, build, lint, secret boundary, policy, negative cases, recovery drill, and 151 tests pass. Strict Robinhood replay passes 6 tests and strict Ethereum replay passes. `Fixtures/` remains intentionally untracked. | Keep. Synchronized with `origin/main`. |
| `.kilo/recovered-phase1-integration` (removed) | Integration | `phase1-integration` / `cc6aee2` | Integrated canonical source | Its 118-file Phase 1 delta and reviewed closure patches are included in `main` through `57e1e95`; production runtime evidence remains incomplete. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, and 151 tests pass. | Worktree removed; branch retained. |
| `C:\Users\hamid\AppData\Local\Temp\kilo\w3-phase1-main-candidate` (removed) | Integration candidate | `recovery/cto-main-candidate` / `57e1e95` | Merged into main | Candidate contains current `origin/main` plus Database, Backend, Blockchain, Lead, Frontend, and CTO closure patches. | Clean checkout; lint, secret boundary, policy, negative cases, recovery drill, typecheck, build, 151 tests, strict Robinhood replay, and strict Ethereum replay pass. | Worktree removed; branch retained. |
| `.kilo/recovered-backend-engineer` (removed) | Backend | `backend-engineer` / `370d7c0` | Already integrated | Earlier Backend tip is an ancestor of canonical work; closure commits were cherry-picked as reviewed equivalents. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-blockchain-engineer` (removed) | Blockchain | `blockchain-engineer` / `157368e` | Already integrated by equivalent commit | Earlier tip plus final Robinhood commits are represented in `main`. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-database-engineer` (removed) | Database | `database-engineer` / `f84bb64` | Already integrated by reviewed closure patches | Database 015 and wallet-scoped identity are represented in `main` as equivalent cherry-picked commits. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-devops-engineer` (removed) | DevOps | `devops-engineer` / `d62bf48` | Integrated with context adaptation | Canonical DevOps gates are already in `main`; no later unique DevOps code remained. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-engineers` (removed) | Engineering Lead | `engineers` / `b94180d` | Superseded integration line | Reviewed Lead closure status commits are represented in `main`; the old report-only line is retained only for provenance. | Published remotely after object refetch. | Worktree removed; branch retained. |
| `.kilo/recovered-cto` (removed) | CTO | `cto-restored` / `b29fdd0` | Already integrated | CTO brief is included in canonical history; WSL source-of-truth continuation is published through `cto-wsl`. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/worktrees/cto-2` (removed) | CTO | `cto-2` / `b29fdd0` | Exact duplicate | Same commit and tree as merged `cto-restored`; no unique CTO work remained. | Worktree clean. | Worktree removed; branch retained. |
| `.kilo/recovered-frontend-engineer` (removed) | Frontend | `frontend-engineer` / `43ad380` | Contract-only Phase 1 work | Phase 2 read-model contract is now published; no Phase 1 web UI was added. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| `.kilo/recovered-product-design-spec` (removed) | Product Design | `product-design-spec` / `43ad380` | Contract-only Phase 1 work | Product Design contract is now published through the integrated branch; web UI remains deferred. | Worktree clean; published remotely. | Worktree removed; branch retained. |
| Local refs removed | Misc. stale branches | `chemical-bittersweet`, `cto`, `cto-2`, `lead-engineer`, `recovered-product-design-spec`, `recovery/phase1-main-candidate` | Verified obsolete duplicates | All were merged, duplicated, or ancestor commits; useful content is in `main`, remote branches, the bundle, or imported recovery refs. | Deleted with non-forcing `git branch -d` after bundle verification. | Branch refs removed; remote specialist branches and `refs/recovery/*` retained. |

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
| `seadrop-test/` | Separate WSL fixture source, not integrated | `~/W3/seadrop-test` has the copied Counter harness without parent Git metadata and independently cloned `forge-std` and SeaDrop upstream repositories. Its two Foundry tests pass. No project-specific W3 fork test is wired to it. |
| `stale-worktree-archive/` | Recovery backup | Copied to `~/W3/recovery-input/stale-worktree-archive/` outside the active clone; keep until historical documents are curated. |

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
- `pnpm test -- --reporter=dot`: 151 pass, 10 skip across 15 passed test files and 2 skipped fork files.
- `pnpm test:fork`: 6 Robinhood tests pass when the approved fixture reference is provided; Ethereum tests require separate fixture variables.
- `pnpm ops:fork-replay`: strict six-case Robinhood replay passes using `~/W3/Rets/archive-rpc.env` by reference.
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
- `pnpm test -- --reporter=dot`: 151 pass, 10 skip across 15 passed test files and 2 skipped fork files.
- `pnpm ops:clean-checkout`: intentionally fails in the project root because preserved untracked recovery artifacts remain.
- `pnpm test:fork`: 6 Robinhood tests pass; the Ethereum test passes when its separate archive RPC reference and fixture variables are configured.
- `pnpm ops:fork-replay`: passes strictly with 6 Robinhood tests after the environment/path fixes in the reviewed Blockchain closure commits. Anvil is available and the archive value remains outside the Vitest child environment.
- `pnpm ops:ethereum-fork`: passes strictly with the approved Ethereum fixture and archive reference.
- `pnpm ops:health`: fails closed with missing secret-store, store, RPC, chain-verification, reconciliation, and finality configuration.

### Native WSL `~/W3/MintBot`

- Fresh GitHub clone confirmed at `/home/Junayd/W3/MintBot`; `.git` is independent, non-shallow, and has no copied worktree registrations.
- `git fetch origin --tags`: pass; all remote specialist branches are visible.
- `git fsck --full --no-reflogs`: pass with no missing objects.
- `pnpm install --frozen-lockfile`: pass using native Node `20.19.1` and pnpm `9.15.4`.
- `pnpm ops:clean-checkout`: pass.
- `pnpm lint`: pass.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- `pnpm test -- --reporter=dot`: 151 pass, 10 skip.
- `pnpm ops:secret-boundary`: pass; no `Rets/` or secret paths are tracked or present in the active clone.
- `pnpm ops:policy`: pass with conservative CI-equivalent values.
- `pnpm ops:negative-cases`: pass.
- `pnpm ops:recovery-drill`: pass.
- `pnpm test:fork`: 6 Robinhood and 4 Ethereum tests require explicit fixture injection; the deterministic suite does not claim archive evidence without it.
- `pnpm ops:fork-replay`: passes strictly with 6 Robinhood tests; the archive value is read by reference from `~/W3/Rets/archive-rpc.env` and never passed to Vitest.
- `pnpm ops:ethereum-fork`: passes strictly with 4 Ethereum fork probes using the approved archive reference and `Fixtures/ethereum-seadrop-fixture.env` by reference.
- `pnpm ops:health`: expected fail-closed result without production configuration.
- `forge test --root ~/W3/seadrop-test`: 2 passed, 0 failed, 0 skipped.

## Pending decisions and gates

1. Curate the preserved Robinhood report and historical product-design document.
2. Decide whether to retain remote specialist branches after integration review.
3. Retain or publish `~/W3/seadrop-test` as the private `palmora-seadrop-fixture` repository.
4. Open Antigravity/VS Code through Remote-WSL and confirm future Agent Manager worktrees are created under the WSL filesystem.
5. Provide production secret-store, signer, RPC, backup, notification, and finality configuration for `ops:health`.
6. Keep Robinhood execution disabled until strict fork, sequencer/feed correlation, restart/replacement/reorg/kill-switch, backup/restore, finality, and Product Owner evidence gates pass.
