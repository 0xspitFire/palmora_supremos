---
description: Decide whether two tasks may run at the same time, using the parallelism rules in CONTRIBUTING.md. Read-only.
argument-hint: <task-id-a> <task-id-b>
disallowed-tools: Bash, Edit, Write, NotebookEdit
---

Decide whether tasks $0 and $1 may run in parallel. Read `tasks/active/$0.md` and `tasks/active/$1.md` (stop if either is missing), and `Docs/Live/ARCHITECTURE.md` for ownership of the listed files.

Both may run at the same time only if all four hold:

1. **No output dependency:** neither consumes the other's output ("Depends on", "Blocks", or one needs a type, migration, contract, or result the other produces).
2. **Disjoint files:** their "Files likely touched" do not overlap, including shared files implied by the change (package `index.ts` exports, migrations, `package.json`, lockfile, shared test fixtures).
3. **No unresolved decision:** no open question in either task, and no pending architect decision, affects either one.
4. **No live back-and-forth:** neither needs repeated clarification from, or coordination with, the other while running.

Reply with:

```
Parallel: yes | no
1. Output dependency: ok | conflict: <reason>
2. Files: ok | overlap: <paths>
3. Decisions: ok | unresolved: <question>
4. Coordination: ok | needed: <reason>
Recommendation: <run in parallel with one worktree for the second task | run <id> first, then <id>>
```

If any rule fails, the answer is no. Do not modify any file.
