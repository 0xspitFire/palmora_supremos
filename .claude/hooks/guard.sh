#!/usr/bin/env bash
# PreToolUse(Bash) guard. Exit 2 blocks the call and shows stderr to Claude.
# Rules live in guard.mjs. Fail closed: any guard error other than a clean allow (0) blocks, including a
# check that runs past 8 s (the hook itself is killed at 10 s, and a killed hook does not block).
timeout 8 node "$(dirname "$0")/guard.mjs"
rc=$?
[ "$rc" -eq 0 ] && exit 0
[ "$rc" -ne 2 ] && echo "Blocked by .claude/hooks/guard.sh: guard.mjs failed (exit $rc), blocking by default." >&2
exit 2
