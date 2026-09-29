---
description: Run the quality gate for a finished task in order - typecheck, lint, tests, reviewer, then security-reviewer when risk requires it. Stops on the first failure.
argument-hint: <task-id>
---

Run the gate for task $0. Stop at the first failing step, report it, and do not continue.

Task file: `tasks/active/$0.md` (stop if missing). Current branch and changes:
!`git branch --show-current`
!`git status --short`

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. If the task file's gates include `pnpm ops:fork-replay`, run it.
5. Invoke the `reviewer` subagent with the task id. Stop if `tasks/active/$0.review.md` says `Verdict: changes requested`.
6. Security review is required if the task's risk level is `guardrail` or `funds`, or if any changed file matches a path in the "Paths that require security review" list in `Docs/Live/security-requirements.md`. Check changed files with `git diff --name-only main...HEAD` plus `git status --short`. If required, invoke the `security-reviewer` subagent with the task id. Stop if `tasks/active/$0.security.md` says `Verdict: fail`.

Do not fix anything during the gate. Do not re-run a passed step to check it again.

Append to the "Notes" section of the task file:

```
Gate <date> at <short commit> (+ uncommitted changes: yes|no): typecheck <pass|fail>, lint <pass|fail>, test <pass|fail>, fork <pass|fail|n/a>, reviewer <verdict>, security <verdict|not required>
```

If every step passed, set the task status to `gated`. Reply with the gate line and, on failure, the first failing output (trimmed) and the file to fix.
