#!/usr/bin/env bash
# Dedicated MintBot host: Linux piped handlers can ignore RLIMIT_CORE=0.
# Install a persistent discard-only handler. Never removes an existing dump or
# journal record. Run --check to inspect policy, --apply only after review.
set -euo pipefail
MODE="${1:---check}"
[[ "$#" -le 1 && "$MODE" =~ ^--(check|apply)$ ]] || { echo 'Usage: core-dump-policy.sh [--check|--apply]' >&2; exit 2; }
TARGET=/etc/sysctl.d/99-mint-bot-no-coredumps.conf
EXPECTED='kernel.core_pattern = |/bin/false'
stop() { echo "STOP: $*" >&2; exit 1; }
[ -d /etc/sysctl.d ] && [ ! -L /etc/sysctl.d ] || stop 'ordinary root-owned sysctl directory required'
DIRECTORY_MODE="$(stat -c '%f:%u:%g' /etc/sysctl.d)" || stop 'cannot inspect sysctl directory'
[[ "$DIRECTORY_MODE" =~ ^([0-9a-fA-F]{4,8}):0:0$ ]] || stop 'sysctl directory ownership/mode mismatch'
RAW_MODE=$((16#${BASH_REMATCH[1]}))
[ "$RAW_MODE" -le 65535 ] && [ $((RAW_MODE & 0170000)) -eq 16384 ] && [ $((RAW_MODE & 0022)) -eq 0 ] || stop 'sysctl directory must be ordinary and not writable by others'
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  [ -f "$TARGET" ] && [ ! -L "$TARGET" ] || stop 'policy must be a regular non-link file'
  POLICY_METADATA="$(stat -c '%u:%g:%a' "$TARGET")" || stop 'cannot inspect policy metadata'
  [ "$POLICY_METADATA" = 0:0:644 ] || stop 'policy ownership/mode mismatch'
  POLICY_TEXT="$(cat "$TARGET")" || stop 'cannot read policy'
  [ "$POLICY_TEXT" = "$EXPECTED" ] || stop 'different existing policy requires review; refusing overwrite'
elif [ "$MODE" = --check ]; then
  stop 'persistent no-core policy is not installed'
fi
if [ "$MODE" = --apply ]; then
  CURRENT_UID="$(id -u)" || stop 'cannot inspect current user'
  [ "$CURRENT_UID" = 0 ] || stop 'root required for application'
  if [ ! -e "$TARGET" ]; then
    TEMPORARY="$(mktemp /etc/sysctl.d/.mint-bot-no-core.XXXXXX)"
    trap 'rm -f "$TEMPORARY"' EXIT
    printf '%s\n' "$EXPECTED" > "$TEMPORARY"
    chmod 0644 "$TEMPORARY"
    # Exclusive link publication cannot overwrite an owner-created policy.
    ln "$TEMPORARY" "$TARGET"
    rm -f "$TEMPORARY"
    trap - EXIT
  fi
  sysctl --load "$TARGET" >/dev/null
fi
CURRENT_PATTERN="$(cat /proc/sys/kernel/core_pattern)" || stop 'cannot read kernel core handler'
[ "$CURRENT_PATTERN" = '|/bin/false' ] || stop 'kernel handler does not match the installed discard-only policy'
echo 'CORE_PAYLOAD_STORAGE_DISABLED; existing payloads and journal metadata preserved'
