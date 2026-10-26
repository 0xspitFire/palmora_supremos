#!/usr/bin/env bash
# MintBot release installer (T-047). Run as root on the production VM, never while the service is running.
#
#   sudo bash install-release.sh <release.tar.gz> <sha256>   install a release built by build-release.sh and make it current
#   sudo bash install-release.sh --rollback                  make the previous release current again (code only)
#   sudo bash install-release.sh --list                      show installed releases and which one is current
#
# A release is unpacked into /opt/mint-bot/releases/<commit>, owned by root and changeable by nobody else, proven to start
# (the programs load and the database library opens a scratch database) inside a sandbox with no network and no access to the
# state, log or secret folders, and only then linked as /opt/mint-bot/current. Nothing is ever deleted here except the
# installer's own temporary folder: old releases stay so a rollback is always possible. The service is not started, the kill
# switch is not touched, and no secret is read. A rollback never touches data.
set -euo pipefail

RELEASES=/opt/mint-bot/releases
CURRENT=/opt/mint-bot/current
PREVIOUS_FILE="$RELEASES/.previous"
HISTORY_FILE="$RELEASES/.history"
VERSION_COUNTER="$RELEASES/.version-counter"
MAX_UNPACKED_BYTES=$((2 * 1024 * 1024 * 1024))

say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
stop() { echo "STOP: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || stop "run this as root: sudo bash install-release.sh ..."
[ -d "$RELEASES" ] && [ ! -L "$RELEASES" ] || stop "$RELEASES is missing; run provision-host.sh first."
id mintbot >/dev/null 2>&1 || stop "the mintbot account does not exist; run provision-host.sh first."

current_target() { [ -L "$CURRENT" ] && readlink "$CURRENT" || true; }

# Anything but inactive/failed (including activating and deactivating) counts as running.
service_running() {
  local unit state
  for unit in mint-bot.service mint-bot-backup.service; do
    state="$(systemctl is-active "$unit" 2>/dev/null || true)"
    case "$state" in inactive|failed|unknown|"") ;; *) return 0 ;; esac
  done
  return 1
}

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

write_file_atomically() { # path content
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$1"
}

next_install_version() { # release manifest
  local manifest="$1" declared current_major current_minor current_build major minor
  declared="$(grep -m1 '^product_version=' "$manifest" | cut -d= -f2- || true)"
  [[ "$declared" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || stop "the release has no valid product_version marker."
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
  current_major=0; current_minor=0; current_build=0
  if [ -f "$VERSION_COUNTER" ]; then
    IFS=. read -r current_major current_minor current_build < "$VERSION_COUNTER"
    [[ "${current_major:-}" =~ ^[0-9]+$ && "${current_minor:-}" =~ ^[0-9]+$ && "${current_build:-}" =~ ^[0-9]+$ ]] || stop "the installed version counter is invalid."
  fi
  # Product certification (major) and default-operation changes (minor) are
  # explicit source decisions. Builds advance the patch within that line; a
  # new major/minor line starts at patch 1.
  if [ "$major" -lt "$current_major" ] || { [ "$major" -eq "$current_major" ] && [ "$minor" -lt "$current_minor" ]; }; then
    stop "the release product version $declared is older than installed line $current_major.$current_minor."
  fi
  if [ "$major" -ne "$current_major" ] || [ "$minor" -ne "$current_minor" ]; then
    printf '%s.%s.1' "$major" "$minor"
  else
    printf '%s.%s.%s' "$major" "$minor" "$((current_build + 1))"
  fi
}

record() { # old new
  [ -z "$1" ] || write_file_atomically "$PREVIOUS_FILE" "$1"
  printf '%s %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-none}" "$2" >> "$HISTORY_FILE"
  chmod 0644 "$HISTORY_FILE" 2>/dev/null || true
}

# Runs a command from a release folder as the unprivileged account in a sandbox: no network, no access to the state, log or secret
# folders, read-only system, private temporary folder, no new privileges. The release's own code runs here BEFORE it is trusted, so
# it must not be able to reach the kill switch or any secret. (Tests in a container without systemd may set
# MINT_BOT_ALLOW_UNSANDBOXED_SMOKE=1; that is never used on the real host.)
smoke_run() { # dir command...
  local dir="$1"; shift
  if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemd-run --quiet --wait --pipe --collect --working-directory="$dir" -p User=mintbot -p PrivateNetwork=yes -p NoNewPrivileges=yes \
      -p PrivateTmp=yes -p ProtectHome=yes -p ProtectSystem=strict -p LimitCORE=0 \
      -p "InaccessiblePaths=-/etc/mint-bot -/var/lib/mint-bot -/var/log/mint-bot -/root" \
      /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent "$@"
  elif [ "${MINT_BOT_ALLOW_UNSANDBOXED_SMOKE:-}" = 1 ]; then
    echo "   WARNING: testing the release WITHOUT the sandbox (container tests only)" >&2
    ( cd "$dir" && runuser -u mintbot -- env -i PATH=/usr/bin:/bin HOME=/nonexistent "$@" )
  else
    echo "systemd-run is not available, so the release cannot be tested safely." >&2
    return 1
  fi
}

# A release must start for real: the programs load, the database library opens a scratch database, and the backup service's
# cloud-storage library resolves.
smoke_test() { # dir
  local dir="$1"
  smoke_run "$dir" /usr/bin/node packages/cli/dist/index.js --help >/dev/null 2>&1 || return 1
  smoke_run "$dir" /usr/bin/node --input-type=module -e "import('./packages/database/dist/index.js').then((m) => { const db = m.openDatabase(':memory:'); db.close(); })" >/dev/null 2>&1 || return 1
  smoke_run "$dir/scripts" /usr/bin/node --input-type=module -e "await import('@aws-sdk/client-s3')" >/dev/null 2>&1 || return 1
  smoke_run "$dir" /usr/bin/node --check scripts/backup-service.mjs >/dev/null 2>&1 || return 1
  smoke_run "$dir" /usr/bin/node --check packages/cli/dist/orchestrator-service.js >/dev/null 2>&1
}

case "${1:-}" in
  --list)
    say "Installed releases"
    for dir in "$RELEASES"/*/; do
      [ -d "$dir" ] || continue
      name="$(basename "$dir")"
      mark=""; [ "$(current_target)" = "${dir%/}" ] && mark="   <- current"
      printf '   %s  %s%s\n' "$name" "$(grep -m1 '^built_at=' "$dir/RELEASE" 2>/dev/null | cut -d= -f2- || true)" "$mark"
    done
    echo "Previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
    exit 0
    ;;
  --rollback)
    exec 9>"$RELEASES/.lock"; flock -n 9 || stop "another install or rollback is running."
    service_running && stop "stop the MintBot service first (systemctl stop mint-bot.service), then roll back."
    [ -f /var/lib/mint-bot/killswitch ] || stop "the kill switch file is missing; a rollback never runs with the kill switch released."
    [ -f "$PREVIOUS_FILE" ] || stop "there is no previous release recorded."
    PREV="$(cat "$PREVIOUS_FILE")"
    valid_release_dir "$PREV" || stop "the recorded previous release ($PREV) is not a valid release folder."
    NOW="$(current_target)"
    [ "$NOW" != "$PREV" ] || stop "the previous release is already current."
    [ -z "$(find "$PREV" \( ! -user root -o -perm /022 \) ! -type l -print -quit)" ] || stop "the previous release ($PREV) has a file that is not root-only writable."
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
exec 9>"$RELEASES/.lock"; flock -n 9 || stop "another install or rollback is running."
service_running && stop "stop the MintBot service first (systemctl stop mint-bot.service), then install."
[ -f /var/lib/mint-bot/killswitch ] || stop "the kill switch file is missing; installing a release never runs with the kill switch released."

STAGE="$(mktemp -d "$RELEASES/.incoming.XXXXXX")"
chmod 0755 "$STAGE"   # mktemp makes it root-only; the unprivileged account must be able to reach the release to prove it starts
trap 'rm -rf "$STAGE"' EXIT

say "1/5 Checking the file"
# Work from a private copy, so the file cannot be swapped between the checksum and the unpacking.
COPY="$STAGE/release.tar.gz"
install -m 0600 -o root -g root "$TARBALL" "$COPY"
ACTUAL="$(sha256sum "$COPY" | cut -d' ' -f1)"
[ "$ACTUAL" = "$EXPECTED" ] || stop "the file's SHA-256 is $ACTUAL, not the expected $EXPECTED. Nothing was installed."
note "checksum matches"
# Look inside before unpacking anything: only a 'release/' tree, no absolute or parent paths, only ordinary files, folders and
# links (no hard links, devices or pipes), and a sane total size.
LISTING="$(tar -tzf "$COPY")" || stop "the file is not a readable release archive."
# (counts, not pipes: under pipefail a closed pipe on a huge listing must not let a refusal pass)
[ "$(grep -cvE '^release(/|$)' <<<"$LISTING" || true)" = 0 ] || stop "the archive has files outside the release folder."
if grep -qE '(^|/)\.\.(/|$)' <<<"$LISTING"; then stop "the archive has a parent-folder path."; fi
VERBOSE="$(tar -tvzf "$COPY")" || stop "the file is not a readable release archive."
if [ "$(cut -c1 <<<"$VERBOSE" | grep -cvE '^[-dl]$' || true)" != 0 ]; then stop "the archive has an entry that is not an ordinary file, folder or link (a hard link, device or pipe, for example)."; fi
UNPACKED_BYTES="$(awk '$1 ~ /^-/ { total += $3 } END { print total + 0 }' <<<"$VERBOSE")"
[ "$UNPACKED_BYTES" -le "$MAX_UNPACKED_BYTES" ] || stop "the release would unpack to $UNPACKED_BYTES bytes, above the $MAX_UNPACKED_BYTES limit."

say "2/5 Unpacking (owned by root)"
tar -xzf "$COPY" -C "$STAGE" --no-same-owner --no-same-permissions
[ -d "$STAGE/release" ] || stop "the archive did not contain a release folder."
COMMIT="$(grep -m1 '^commit=' "$STAGE/release/RELEASE" 2>/dev/null | cut -d= -f2- || true)"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || stop "the release has no valid commit marker."
# Judged before the permissions are normalised, so a set-id or group/world-writable file is refused, not silently fixed.
[ -z "$(find "$STAGE/release" \( -perm /6000 -o -perm /022 \) ! -type l -print -quit)" ] || stop "the archive has a file that is set-id or writable by group or others."
chown -R root:root "$STAGE/release"
chmod -R u=rwX,go=rX "$STAGE/release"
chmod 0755 "$STAGE/release"
# Nothing in the tree may be changeable by anyone but root, set-id, or anything other than an ordinary file, folder or link.
[ -z "$(find "$STAGE/release" \( ! -user root -o -perm /022 -o -perm /6000 \) ! -type l -print -quit)" ] || stop "the unpacked release has a file that is not root-only writable, or is set-id."
[ -z "$(find "$STAGE/release" ! -type f ! -type d ! -type l -print -quit)" ] || stop "the unpacked release has an entry that is not an ordinary file, folder or link."
# A link is fine if, followed to the end, it stays inside the release (a link whose target was pruned away is harmless);
# one that leaves the release, loops, or cannot be resolved is refused.
BAD_LINK=""
while IFS= read -r -d '' link; do
  resolved="$(realpath -m "$link" 2>/dev/null || true)"
  case "$resolved" in "$STAGE/release"/*|"$STAGE/release") ;; *) BAD_LINK="$link"; break ;; esac
done < <(find "$STAGE/release" -type l -print0)
[ -z "$BAD_LINK" ] || stop "the release has a link that points outside itself: $BAD_LINK"
note "unpacked: commit $COMMIT"

say "3/5 Proving it starts (as the unprivileged account, in a sandbox)"
smoke_test "$STAGE/release" || stop "the release does not start (programs or libraries failed to load). Nothing was installed."
note "programs load, the database library opens a scratch database, and the cloud-storage library resolves"

say "4/5 Putting it in place"
TARGET="$RELEASES/$COMMIT"
DIGEST_FILE="$RELEASES/.sha256-$COMMIT"
if [ -e "$TARGET" ]; then
  [ -d "$TARGET" ] && [ ! -L "$TARGET" ] || stop "$TARGET exists and is not a plain folder."
  # The folder name comes from the file's own marker, so tie it to the exact file that was installed.
  [ "$(cat "$DIGEST_FILE" 2>/dev/null || true)" = "$EXPECTED" ] || stop "a different build of commit $COMMIT is already installed ($TARGET). Nothing was changed. Ask for help before replacing it."
  note "release $COMMIT is already installed (the same file)"
else
  INSTALL_VERSION="$(next_install_version "$STAGE/release/RELEASE")"
  printf 'version=%s\n' "$INSTALL_VERSION" >> "$STAGE/release/RELEASE"
  mv -T "$STAGE/release" "$TARGET"
  write_file_atomically "$DIGEST_FILE" "$EXPECTED"
  write_file_atomically "$VERSION_COUNTER" "$INSTALL_VERSION"
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
