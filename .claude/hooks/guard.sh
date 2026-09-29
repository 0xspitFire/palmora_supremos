#!/usr/bin/env bash
# PreToolUse(Bash) guard. Exit 2 blocks the call and shows stderr to Claude.
# Blocks destructive git/worktree commands and any command that references secret paths.
cmd=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).tool_input?.command??""))}catch{}})')
[ -z "$cmd" ] && exit 0

block() { echo "Blocked by .claude/hooks/guard.sh: $1. Ask the human to run it or approve another way." >&2; exit 2; }
has() { printf '%s' "$cmd" | grep -Eq -- "$1"; }

has '\bgit\b.*\bpush\b.*(--force|--mirror|--delete|[[:space:]]-[a-zA-Z]*f\b|[[:space:]]\+[^[:space:]])' && block "force or deleting push"
has '\bgit\b.*\breset\b.*--hard' && block "git reset --hard"
has '\bgit\b.*\bclean\b.*[[:space:]]-[a-zA-Z]*f' && block "git clean -f"
has '\bgit\b.*\bbranch\b.*([[:space:]]-[a-zA-Z]*[dD]\b|--delete)' && block "branch deletion"
has '\bgit\b.*\bworktree\b.*\b(prune|remove\b.*(--force|[[:space:]]-f\b))' && block "forced worktree removal or prune"
has '\brm\b.*[[:space:]]-[a-zA-Z]*[rR].*(worktrees|MintBot-wt)' && block "rm -r on a worktree folder"
has '(^|[^A-Za-z0-9_.-])(\./)?Rets(/|[[:space:]]|$)|W3/Rets' && block "secret path Rets"
has '(^|[^A-Za-z0-9_])secrets/' && block "secret path secrets/"
has '\.(env|key)([[:space:]]|$)|keystore/|wallets\.(enc|json)' && block "secret file (.env, .key, keystore, wallets)"
exit 0
