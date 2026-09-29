#!/usr/bin/env bash
# Stop hook: fast typecheck of packages with uncommitted .ts changes only.
# `pnpm typecheck` (ordered builds) remains the full gate. Exit 2 asks Claude to fix errors once.
input=$(cat)
printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
pkgs=$( { git diff --name-only HEAD -- packages; git ls-files --others --exclude-standard -- packages; } 2>/dev/null \
  | grep -E '^packages/[^/]+/.*\.ts$' | cut -d/ -f2 | sort -u)
[ -z "$pkgs" ] && exit 0
fail=0
for p in $pkgs; do
  [ -f "packages/$p/tsconfig.json" ] || continue
  if ! out=$(cd "packages/$p" && pnpm exec tsc --noEmit -p tsconfig.json 2>&1); then
    { echo "Typecheck failed in packages/$p:"; printf '%s\n' "$out" | head -30; } >&2
    fail=1
  fi
done
[ "$fail" -eq 1 ] && exit 2
exit 0
