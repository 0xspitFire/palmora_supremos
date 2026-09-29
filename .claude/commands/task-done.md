---
description: Close a gated task - verify the definition of done, update the checklist if relevant, move the task files to tasks/done/, and list branches and worktrees for human cleanup. Deletes nothing.
argument-hint: <task-id>
---

Close task $0. Never delete branches, worktrees, or files; only list them for the human.

State:
!`git branch --show-current`
!`git status --short`
!`git worktree list`
!`git branch --merged main --format='%(refname:short) %(committerdate:short)'`

1. Read `tasks/active/$0.md`. Verify the definition of done from `CONTRIBUTING.md`:
   - the last gate line in "Notes" shows every step passed, and nothing changed since (compare the commit and uncommitted state with the gate line; if different, stop and ask for `/gate $0` again);
   - `tasks/active/$0.review.md` says `Verdict: approve`; if security was required, `tasks/active/$0.security.md` says `Verdict: pass`;
   - the done condition is met; the task file lists decisions made (D-NNN) and remaining open questions.
   If anything fails, stop and list what is missing.
2. If the task changed a validation item, update `Docs/Live/checklist.md` with the new state and an evidence pointer.
3. Set status to `done`, add the close date, then move `tasks/active/$0.md` and any `$0.review.md` and `$0.security.md` to `tasks/done/` with `mv`.
4. Cleanup proposal for the human (do not act on it):
   - this task's branch and worktree, if any, with the exact commands to remove them once merged;
   - any merged branch whose last commit is older than 7 days (stale rule in `CONTRIBUTING.md`).
5. Reply with what moved, what changed in the checklist, and the cleanup list.
