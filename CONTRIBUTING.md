# Contributing to MintBot

Only conventions that differ from common defaults. Project context lives in the local `Docs/` directory (not in Git).

## Work comes from tasks

- Every change starts from a task file `tasks/active/T-NNN.md` (local-only). Stay inside its scope.
- New decisions go in `Docs/Live/DECISIONS.md` (append-only). New open questions go in the task file, not chat.

## Git

- Default: one branch per task, `task/<slug>`, from current `origin/main`, in the main checkout. No worktree.
- Worktree only when two independent tasks really run at the same time, to test something risky in isolation, or for an urgent fix while another task holds the main tree. Path: `../MintBot-wt/<slug>`. `Docs/` and `CLAUDE.local.md` are not there; add a `CLAUDE.local.md` containing `@/home/Junayd/W3/MintBot/Docs/CLAUDE.md`.
- Branch and worktree lifetime: days, not weeks. Delete both once the task is merged.
- Commit messages start with the task id: `T-012: add exposure reservation test`. Tests ship with the code they cover.
- Squash merge; the squash title keeps the task id. No direct commits to `main`. Never force-push.
- Stale rule: a merged branch older than 7 days is listed by `/task-done` for cleanup approval.

## Parallel work

Two tasks may run at the same time only if all hold: neither consumes the other's output, they touch disjoint files, no unresolved decision affects either, and neither needs live back-and-forth. Otherwise run them in sequence. Check with `/parallel-check <a> <b>`.

## Definition of done

1. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass locally.
2. Every guard change has a negative, fail-closed test.
3. Required CI checks are green.
4. Review done: reviewer for every task; security-reviewer when the risk level is guardrail or funds, or the diff touches a path listed in `Docs/Live/security-requirements.md`.
5. Task file updated (status, decisions, open questions). `Docs/Live/checklist.md` updated if a validation item changed.
6. No secrets, `.env` values, or credential-bearing URLs anywhere in the diff.
