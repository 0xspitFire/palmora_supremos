#!/usr/bin/env bash
# MintBot release installer (T-047). Run as root on the production VM, never while the service is running.
#
#   sudo bash install-release.sh <release.tar.gz> <sha256>   install a release built by build-release.sh and make it current
#   sudo bash install-release.sh --rollback                  make the previous release current again (code only)
#   sudo bash install-release.sh --list                      show installed releases and which one is current
#
# A release is unpacked into /opt/mint-bot/releases/<commit>, owned by root and changeable by nobody else, proven to start
# (the programs load and the database library opens a scratch database, run as the unprivileged account), and only then
# linked as /opt/mint-bot/current. Nothing is ever deleted here: old releases stay so a rollback is always possible. The
# service is not started, the kill switch is not touched, and no secret is read. A rollback never touches data.
set -euo pipefail

RELEASES=/opt/mint-bot/releases
CURRENT=/opt/mint-bot/current
PREVIOUS_FILE="$RELEASES/.previous"
HISTORY_FILE="$RELEASES/.history"

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
stop() { echo "STOP: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || stop "run this as root: sudo bash install-release.sh ..."
[ -d "$RELEASES" ] && [ ! -L "$RELEASES" ] || stop "$RELEASES is missing; run provision-host.sh first."
id mintbot >/dev/null 2>&1 || stop "the mintbot account does not exist; run provision-host.sh first."

current_target() { [ -L "$CURRENT" ] && readlink "$CURRENT" || true; }

service_running() { systemctl is-active --quiet mint-bot.service || systemctl is-active --quiet mint-bot-backup.service; }

# Only ever an ordinary folder directly under $RELEASES, named by the commit.
valid_release_dir() { # path
  local dir="$1"
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(dirname "$dir")" = "$RELEASES" ] && [[ "$(basename "$dir")" =~ ^[0-9a-f]{40}$ ]]
}

link_current() { # release dir
  local target="$1"
  ln -sfn "$target" "$CURRENT.new"
  mv -Tf "$CURRENT.new" "$CURRENT"
}

record() { # old new
  [ -z "$1" ] || printf '%s\n' "$1" > "$PREVIOUS_FILE"
  printf '%s %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-none}" "$2" >> "$HISTORY_FILE"
  chmod 0644 "$PREVIOUS_FILE" "$HISTORY_FILE" 2>/dev/null || true
}

# A release must start for real: the programs load and the database library works, as the unprivileged service account.
smoke_test() { # dir
  local dir="$1"
  runuser -u mintbot -- env -i PATH=/usr/bin:/bin HOME=/nonexistent sh -c "cd '$dir' && /usr/bin/node packages/cli/dist/index.js --help >/dev/null 2>&1" || return 1
  runuser -u mintbot -- env -i PATH=/usr/bin:/bin HOME=/nonexistent sh -c "cd '$dir' && /usr/bin/node --input-type=module -e \"import('./packages/database/dist/index.js').then((m) => { const db = m.openDatabase(':memory:'); db.close(); })\"" >/dev/null 2>&1 || return 1
  runuser -u mintbot -- env -i PATH=/usr/bin:/bin HOME=/nonexistent sh -c "cd '$dir' && /usr/bin/node --check scripts/backup-service.mjs && /usr/bin/node --check packages/cli/dist/orchestrator-service.js" >/dev/null 2>&1
}

case "${1:-}" in
  --list)
    say "Installed releases"
    for dir in "$RELEASES"/*/; do
      [ -d "$dir" ] || continue
      name="$(basename "$dir")"
      mark=""; [ "$(current_target)" = "${dir%/}" ] && mark="   <- current"
      printf '   %s  %s%s\n' "$name" "$(grep -m1 '^built_at=' "$dir/RELEASE" 2>/dev/null | cut -d= -f2-)" "$mark"
    done
    echo "Previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
    exit 0
    ;;
  --rollback)
    service_running && stop "stop the MintBot service first (systemctl stop mint-bot.service), then roll back."
    [ -f "$PREVIOUS_FILE" ] || stop "there is no previous release recorded."
    PREV="$(cat "$PREVIOUS_FILE")"
    valid_release_dir "$PREV" || stop "the recorded previous release ($PREV) is not a valid release folder."
    NOW="$(current_target)"
    [ "$NOW" != "$PREV" ] || stop "the previous release is already current."
    smoke_test "$PREV" || stop "the previous release does not start: $PREV. Nothing was changed."
    link_current "$PREV"
    record "$NOW" "$PREV"
    say "Rolled back"
    note "current is now $PREV (was ${NOW:-none}). Data was not touched. Start the service yourself when ready."
    exit 0
    ;;
  ""|-*) stop "usage: install-release.sh <release.tar.gz> <sha256> | --rollback | --list" ;;
esac

TARBALL="$1"; EXPECTED="${2:-}"
[ -f "$TARBALL" ] && [ ! -L "$TARBALL" ] || stop "$TARBALL is not a file."
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || stop "give the 64-character SHA-256 that build-release.sh printed."
service_running && stop "stop the MintBot service first (systemctl stop mint-bot.service), then install."
[ -f /var/lib/mint-bot/killswitch ] || stop "the kill switch file is missing; installing a release never runs with the kill switch released."

say "1/5 Checking the file"
ACTUAL="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
[ "$ACTUAL" = "$EXPECTED" ] || stop "the file's SHA-256 is $ACTUAL, not the expected $EXPECTED. Nothing was installed."
note "checksum matches"
# Look inside before unpacking anything: only a 'release/' tree, no absolute or parent paths, no links that leave it.
LISTING="$(tar -tzf "$TARBALL")" || stop "the file is not a readable release archive."
if grep -vE '^release(/|$)' <<<"$LISTING" | grep -q .; then stop "the archive has files outside the release folder."; fi
if grep -qE '(^|/)\.\.(/|$)' <<<"$LISTING"; then stop "the archive has a parent-folder path."; fi

say "2/5 Unpacking (owned by root)"
STAGE="$(mktemp -d "$RELEASES/.incoming.XXXXXX")"
chmod 0755 "$STAGE"   # mktemp makes it root-only; the unprivileged account must be able to reach the release to prove it starts
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$TARBALL" -C "$STAGE" --no-same-owner --no-same-permissions
[ -d "$STAGE/release" ] || stop "the archive did not contain a release folder."
COMMIT="$(grep -m1 '^commit=' "$STAGE/release/RELEASE" 2>/dev/null | cut -d= -f2- || true)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || stop "the release has no valid commit marker."
chown -R root:root "$STAGE/release"
chmod -R u=rwX,go=rX "$STAGE/release"
chmod 0755 "$STAGE/release"
# Nothing in the tree may be changeable by anyone but root, set-id, or a link pointing out of it.
[ -z "$(find "$STAGE/release" \( ! -user root -o -perm /022 -o -perm /6000 \) ! -type l -print -quit)" ] || stop "the unpacked release has a file that is not root-only writable, or is set-id."
# A link is fine if, followed to the end, it stays inside the release (a link whose target was pruned away is harmless);
# one that leaves the release, loops, or cannot be resolved is refused.
BAD_LINK=""
while IFS= read -r -d '' link; do
  resolved="$(realpath -m "$link" 2>/dev/null || true)"
  case "$resolved" in "$STAGE/release"/*|"$STAGE/release") ;; *) BAD_LINK="$link"; break ;; esac
done < <(find "$STAGE/release" -type l -print0)
[ -z "$BAD_LINK" ] || stop "the release has a link that points outside itself: $BAD_LINK"
note "unpacked: commit $COMMIT"

say "3/5 Proving it starts (as the unprivileged account)"
smoke_test "$STAGE/release" || stop "the release does not start (programs or database library failed to load). Nothing was installed."
note "programs load and the database library opens a scratch database"

say "4/5 Putting it in place"
TARGET="$RELEASES/$COMMIT"
if [ -e "$TARGET" ]; then
  [ -d "$TARGET" ] && [ ! -L "$TARGET" ] || stop "$TARGET exists and is not a plain folder."
  cmp -s "$STAGE/release/RELEASE" "$TARGET/RELEASE" || note "a release for this commit is already installed (built at a different time); keeping the installed one"
  note "release $COMMIT is already installed"
else
  mv "$STAGE/release" "$TARGET"
  note "installed $TARGET"
fi
valid_release_dir "$TARGET" || stop "$TARGET is not a valid release folder."

say "5/5 Making it current"
OLD="$(current_target)"
if [ "$OLD" = "$TARGET" ]; then note "it is already current"; else
  link_current "$TARGET"
  record "$OLD" "$TARGET"
  note "current -> $TARGET (previous: ${OLD:-none})"
fi
echo
echo "Done. The service was not started and the kill switch was not changed."
echo "Roll back with: sudo bash install-release.sh --rollback"
