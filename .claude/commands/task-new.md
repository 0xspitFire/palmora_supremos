---
description: Create a new task file in tasks/active/ from tasks/TEMPLATE.md with the next id.
argument-hint: <title>
disallowed-tools: Bash, NotebookEdit
---

Create a new MintBot task titled: $ARGUMENTS

Existing task files:
!`ls tasks/active tasks/done 2>/dev/null`

1. Next id: the highest `T-NNN` in `tasks/active/` and `tasks/done/` plus one, zero-padded to three digits (first task is `T-001`). Ignore `.review.md` and `.security.md` files.
2. Ask the human for the goal and the done condition if $ARGUMENTS does not make them clear. Do not invent them.
3. Read `tasks/TEMPLATE.md`, every task file in `tasks/active/` (headers and "Files likely touched" only), and `Docs/Live/ARCHITECTURE.md`.
4. Propose, for the human to confirm:
   - risk level: `funds` if it can change what is signed, sent, or spent; `guardrail` if it touches caps, reservations, kill switch, simulation, admission, custody, chain config, or a path listed in `Docs/Live/security-requirements.md`; otherwise `low`;
   - files likely touched (from ARCHITECTURE.md ownership), and a branch name `task/<slug>`;
   - depends on and blocks: overlap with active tasks' files or outputs.
5. Write `tasks/active/T-NNN.md` from the template with status `active`. Leave "Plan" empty.
6. Reply with the path, the proposed fields, and any open questions. Do not start implementation.
