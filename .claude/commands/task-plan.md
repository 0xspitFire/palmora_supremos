---
description: Plan a task without changing code. Reads the task, ARCHITECTURE.md, and DECISIONS.md, then writes the plan into the task file only.
argument-hint: <task-id>
disallowed-tools: Bash, Write, NotebookEdit
---

Plan task $0. This is planning only: the only file you may edit is `tasks/active/$0.md`. Do not change code, config, docs, or Git state.

1. Read `tasks/active/$0.md`. If it does not exist, stop and say so.
2. Read `Docs/Live/ARCHITECTURE.md`, and the `Docs/Live/DECISIONS.md` entries relevant to the files in scope. If risk is `guardrail` or `funds`, also read `Docs/Live/security-requirements.md`.
3. Read the code in "Files likely touched" at the level needed to plan: exported signatures, the call sites, and existing tests. Cite `path:line`.
4. If an interface or design question is undecided, do not decide it: list it under "Open questions" and recommend invoking the architect subagent.
5. Write the "Plan" section of `tasks/active/$0.md`:
   - steps in order, each with the files it touches;
   - tests to add, including at least one negative fail-closed test for every guard touched;
   - gates required (confirm or correct the task's list) and how the done condition will be verified;
   - risks, and anything that needs human approval before implementation (see the escalation rule in `Docs/CLAUDE.md`).
   Update "Files likely touched", "Depends on", and "Open questions" if planning changed them. Set status to `planned`.
6. Reply with a short summary of the plan and the open questions, then stop and wait for approval.
