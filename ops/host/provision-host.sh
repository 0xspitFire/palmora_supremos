#!/usr/bin/env bash
# MintBot production host provisioning (T-045). Run ONCE as root on the VM:
#
#   sudo bash provision-host.sh            apply everything below (safe to run again)
#   sudo bash provision-host.sh --check    only report what would change; changes nothing
#
# It prepares the machine: packages, time, swap, the service accounts and groups, the folders with their owners and modes,
# the narrow read permission that lets the backup account read the database, and the three systemd unit files.
# It does NOT install the application code, does NOT create or read any secret, does NOT start the service and does NOT
# release the kill switch. Afterwards run verify-host.sh and keep its report as evidence.
set -euo pipefail

MODE=apply
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  *) echo "Usage: sudo bash provision-host.sh [--check]" >&2; exit 2 ;;
esac

# Node 20.19.1 for linux-x64. This SHA-256 is pinned here (it matched nodejs.org and an independent mirror when it was
# recorded on 2026-10-22), so a changed download is refused even if the website itself were tampered with later.
DEFAULT_NODE_VERSION="20.19.1"
DEFAULT_NODE_SHA256="b6c4cedfc81fc544b9993bc8a3628b5c0aa7a169fbaa293460abc0418d0fabb6"
NODE_VERSION="${MINT_BOT_NODE_VERSION:-$DEFAULT_NODE_VERSION}"
if [ "$NODE_VERSION" = "$DEFAULT_NODE_VERSION" ]; then NODE_SHA256="$DEFAULT_NODE_SHA256"; else NODE_SHA256="${MINT_BOT_NODE_SHA256:-}"; fi
[ -n "$NODE_SHA256" ] || { echo "STOP: a different Node version needs its checksum in MINT_BOT_NODE_SHA256 (from two independent sources)." >&2; exit 1; }
SWAP_SIZE_MB="${MINT_BOT_SWAP_MB:-2048}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_UNITS_DIR="${MINT_BOT_UNITS_DIR:-$HERE/../systemd}"

CHANGES=0
say()  { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
# Runs a command, or only prints it in --check mode.
act() {
  CHANGES=$((CHANGES + 1))
  if [ "$MODE" = check ]; then note "would run: $*"; else "$@"; fi
}

[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo bash provision-host.sh" >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || { echo "STOP: this script is written for Ubuntu (found ${ID:-unknown})." >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "STOP: expected an x86-64 machine (found $(uname -m))." >&2; exit 1; }
# Provisioning follows paths inside folders the service can write, so it never runs while the service is running.
if [ "$MODE" = apply ] && { systemctl is-active --quiet mint-bot.service || systemctl is-active --quiet mint-bot-backup.service; }; then echo "STOP: stop the MintBot service first (systemctl stop mint-bot.service), then run this again." >&2; exit 1; fi
echo "MintBot host provisioning, mode: $MODE, Ubuntu ${VERSION_ID:-?}"

# --- 1. Packages, security updates, time -------------------------------------------------------------------------------
say "1/8 Packages, automatic security updates, UTC time"
MISSING=""
for pkg in acl curl ca-certificates xz-utils sqlite3 unattended-upgrades; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  note "missing packages:$MISSING"
  act apt-get update -qq
  act env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $MISSING
else note "all required packages are installed"; fi
if [ "$(timedatectl show -p Timezone --value 2>/dev/null)" != "UTC" ]; then act timedatectl set-timezone UTC; else note "time zone is UTC"; fi
if [ "$(timedatectl show -p NTP --value 2>/dev/null)" != "yes" ]; then act timedatectl set-ntp true; else note "network time is on"; fi
if [ ! -f /etc/apt/apt.conf.d/20auto-upgrades ] || ! grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
  note "turning on automatic security updates"
  if [ "$MODE" = check ]; then note "would write /etc/apt/apt.conf.d/20auto-upgrades"; CHANGES=$((CHANGES + 1)); else
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  fi
else note "automatic security updates are on"; fi

# --- 2. Node.js ---------------------------------------------------------------------------------------------------------
say "2/8 Node.js $NODE_VERSION (official build, checksum pinned in this script)"
NODE_DIR="/opt/node/node-v${NODE_VERSION}-linux-x64"
node_ok() {
  [ "$(/usr/bin/node --version 2>/dev/null || true)" = "v$NODE_VERSION" ] || return 1
  # The program both service accounts run must belong to root, wherever the link points.
  local real tree; real="$(readlink -f /usr/bin/node)"; tree="$(dirname "$(dirname "$real")")"
  [ -f "$real" ] && [ "$(stat -c '%U' "$real")" = root ] && [ -z "$(find "$tree" \( ! -user root -o -perm /022 \) ! -type l -print -quit 2>/dev/null)" ]
}
if node_ok; then note "node v$NODE_VERSION is installed and owned by root"; else
  note "installing v$NODE_VERSION (found: $(/usr/bin/node --version 2>/dev/null || echo none))"
  if [ "$MODE" = check ]; then note "would download node-v$NODE_VERSION-linux-x64.tar.xz, require SHA-256 $NODE_SHA256, unpack as root and link /usr/bin/node"; CHANGES=$((CHANGES + 1)); else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
    if [ -n "${MINT_BOT_NODE_TARBALL:-}" ]; then
      # A copy you downloaded yourself (for example when the connection is unreliable). It must still match the pinned checksum.
      [ -f "$MINT_BOT_NODE_TARBALL" ] || { echo "STOP: MINT_BOT_NODE_TARBALL ($MINT_BOT_NODE_TARBALL) is not a file." >&2; exit 1; }
      cp "$MINT_BOT_NODE_TARBALL" "$TMP/$TARBALL"
    else
      curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --max-time 600 -o "$TMP/$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/$TARBALL" \
        || { echo "STOP: could not download Node from nodejs.org. Try again, or download $TARBALL elsewhere and run with MINT_BOT_NODE_TARBALL=/path/to/it." >&2; exit 1; }
    fi
    ACTUAL="$(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)"
    [ "$ACTUAL" = "$NODE_SHA256" ] || { echo "STOP: the Node download ($ACTUAL) does not match the pinned checksum ($NODE_SHA256). Nothing was installed." >&2; exit 1; }
    note "checksum matches the pinned value: $ACTUAL"
    install -d -o root -g root -m 0755 /opt/node
    rm -rf "$NODE_DIR"
    tar -xJf "$TMP/$TARBALL" -C /opt/node --no-same-owner --no-same-permissions
    chown -R root:root "$NODE_DIR"
    [ -z "$(find "$NODE_DIR" ! -user root -print -quit)" ] || { echo "STOP: the unpacked Node tree is not entirely owned by root." >&2; exit 1; }
    ln -sfn "$NODE_DIR/bin/node" /usr/bin/node
    node_ok || { echo "STOP: node did not install correctly." >&2; exit 1; }
    note "installed $(/usr/bin/node --version), owned by root"
  fi
fi

# --- 3. Swap ------------------------------------------------------------------------------------------------------------
say "3/8 Swap file (${SWAP_SIZE_MB} MB safety cushion for updates)"
if [ "$(swapon --show --noheadings | wc -l)" -gt 0 ]; then note "swap is already on"; else
  if [ "$MODE" = check ]; then note "would create /swapfile (${SWAP_SIZE_MB} MB), enable it and keep it across restarts"; CHANGES=$((CHANGES + 1)); else
    CHANGES=$((CHANGES + 1))
    if [ ! -e /swapfile ]; then install -m 0600 -o root -g root /dev/null /swapfile; fallocate -l "${SWAP_SIZE_MB}M" /swapfile; mkswap /swapfile >/dev/null; fi
    [ ! -L /swapfile ] && [ "$(stat -c '%U:%G %a' /swapfile)" = "root:root 600" ] || { echo "STOP: /swapfile is a link or has the wrong owner or mode." >&2; exit 1; }
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi
if [ ! -f /etc/sysctl.d/99-mint-bot.conf ]; then
  if [ "$MODE" = check ]; then note "would set low swappiness"; CHANGES=$((CHANGES + 1)); else
    CHANGES=$((CHANGES + 1))
    printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-mint-bot.conf; sysctl -q -p /etc/sysctl.d/99-mint-bot.conf || true
  fi
fi

# --- 4. Accounts and groups ---------------------------------------------------------------------------------------------
say "4/8 Service accounts (no password, no login shell, no sudo)"
ensure_group() { getent group "$1" >/dev/null || act groupadd --system "$1"; }
ensure_account() {
  if ! getent passwd "$1" >/dev/null; then
    ensure_group "$1"
    act useradd --system --gid "$1" --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$1"
  fi
  if [ "$MODE" = apply ] || getent passwd "$1" >/dev/null; then
    [ "$(getent passwd "$1" | cut -d: -f7)" = /usr/sbin/nologin ] || act usermod --shell /usr/sbin/nologin "$1"
    [ "$(passwd -S "$1" 2>/dev/null | cut -d' ' -f2)" = L ] || act passwd -l "$1"
  fi
}
ensure_account mintbot
ensure_account mintbot-backup
ensure_group mintbot-status
for account in mintbot mintbot-backup; do
  if getent passwd "$account" >/dev/null && ! id -nG "$account" | tr ' ' '\n' | grep -qx mintbot-status; then act usermod -aG mintbot-status "$account"; fi
done
# The backup account must never be able to read the application's files, and neither may be an administrator.
if getent passwd mintbot-backup >/dev/null && id -nG mintbot-backup | tr ' ' '\n' | grep -qx mintbot; then echo "STOP: mintbot-backup is in the mintbot group. Remove it with: gpasswd -d mintbot-backup mintbot" >&2; exit 1; fi
for admin_group in sudo adm google-sudoers; do
  for account in mintbot mintbot-backup; do
    if getent group "$admin_group" | cut -d: -f4 | tr ',' '\n' | grep -qx "$account"; then echo "STOP: $account is in the $admin_group group." >&2; exit 1; fi
  done
done
note "mintbot, mintbot-backup and mintbot-status are in place"

# --- 5. Folders and permissions -----------------------------------------------------------------------------------------
say "5/8 Folders, owners and modes"
ensure_dir() { # path owner:group mode
  # A link in place of a folder could redirect root's changes somewhere else: stop instead of following it.
  [ ! -L "$1" ] || { echo "STOP: $1 is a symbolic link, not a folder." >&2; exit 1; }
  if [ ! -d "$1" ]; then act install -d -o "${2%%:*}" -g "${2##*:}" -m "$3" "$1"; else
    [ "$(stat -c '%U:%G %a' "$1")" = "${2} ${3#0}" ] || act bash -c "chown -h '$2' '$1' && chmod '$3' '$1'"
  fi
}
ensure_dir /opt/mint-bot root:root 0755
ensure_dir /opt/mint-bot/releases root:root 0755
ensure_dir /etc/mint-bot root:root 0755
# Backup credentials (root-only files, handed to the backup service by systemd; the application never sees them).
ensure_dir /etc/mint-bot/secrets root:root 0700
# The host secret store (Telegram, provider addresses, monitor address). The application's loader insists on a folder
# named Rets and on a file only its owner can read; /etc is read-only to the service, so it cannot change the file.
ensure_dir /etc/mint-bot/Rets root:mintbot 0750
ensure_dir /var/lib/mint-bot mintbot:mintbot 0750
# The database lives alone in its own folder, so the backup account's read permission can never reach any other file.
ensure_dir /var/lib/mint-bot/db mintbot:mintbot 0750
ensure_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700
ensure_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750
# 0700: the application re-tightens its log folder to owner-only at start (observability.ts), so provisioning matches it.
ensure_dir /var/log/mint-bot mintbot:mintbot 0700
if [ -L /var/lib/mint-bot/killswitch ]; then echo "STOP: the kill switch path is a symbolic link." >&2; exit 1; fi
if [ ! -f /var/lib/mint-bot/killswitch ]; then
  act install -o mintbot -g mintbot -m 0600 /dev/null /var/lib/mint-bot/killswitch
  note "kill switch ENGAGED (the service refuses to start without this file; releasing it is a deliberate, separate step)"
else note "kill switch file present (engaged)"; fi

# Settings for the units: paths and switches only, no secret. The owner adds the wallet addresses and other options later.
# The application reads the MINT_BOT_* names and the backup job reads STORE_PATH, BACKUP_DIR and BACKUP_STATUS_PATH, so both are set.
SETTINGS_FILE=/etc/mint-bot/mint-bot.env
if [ ! -f "$SETTINGS_FILE" ]; then
  if [ "$MODE" = check ]; then note "would write $SETTINGS_FILE"; CHANGES=$((CHANGES + 1)); else
    CHANGES=$((CHANGES + 1))
    cat > "$SETTINGS_FILE" <<'EOF'
# MintBot production settings (not secret). Credentials never go in this file.
MINT_BOT_SERVICE_MODE=dry-run
MINT_BOT_STATE_PATH=/var/lib/mint-bot/db/mintbot.sqlite
MINT_BOT_BACKUP_DIR=/var/lib/mint-bot/backups
MINT_BOT_BACKUP_STATUS_PATH=/var/lib/mint-bot/backup-status/status.json
MINT_BOT_LOG_PATH=/var/log/mint-bot/orchestrator.log
MINT_BOT_JOBS_PATH=/var/lib/mint-bot/jobs.json
MINT_BOT_RESTART_COUNTER_PATH=/var/lib/mint-bot/restarts
KILL_SWITCH_PATH=/var/lib/mint-bot/killswitch
MINT_BOT_REQUIRE_STARTUP_KILL_SWITCH=true
MINT_BOT_HEALTH_PORT=8780
MINT_BOT_BIND_HOST=127.0.0.1
MINT_BOT_BACKUP_SCHEDULER=systemd
SECRET_STORE_PATH=/etc/mint-bot/Rets/MINT_BOT_SECRETS.env
# The backup job reads these names:
STORE_PATH=/var/lib/mint-bot/db/mintbot.sqlite
BACKUP_DIR=/var/lib/mint-bot/backups
BACKUP_STATUS_PATH=/var/lib/mint-bot/backup-status/status.json
# Fill in before the service runs (none of these is secret):
MINT_BOT_HOST_ID=REPLACE-WITH-STABLE-HOST-ID
# Off-host backups to Cloudflare R2, once the bucket exists. The two credentials are NOT here; they are root-only files.
# MINT_BOT_OFFHOST_BACKUP_REQUIRED=true
# R2_ACCOUNT_ID=
# R2_BUCKET_NAME=
# R2_OBJECT_PREFIX=
# R2_JURISDICTION=
# Independent on-chain wallet watcher (D-059 item 6, D-060 item 4). Public addresses only; the per-chain RPC addresses are secrets
# named WATCHER_RPC_1, WATCHER_RPC_8453 and WATCHER_RPC_4663 in the application secret store, never here.
# MINT_BOT_WATCHER_ENABLED=true
# MINT_BOT_TREASURY_ADDRESS=
# MINT_BOT_WATCH_FLEET=[{"chainId":1,"addresses":["0x..."]},{"chainId":8453,"addresses":["0x..."]},{"chainId":4663,"addresses":["0x..."]}]
EOF
    chown root:root "$SETTINGS_FILE"; chmod 0644 "$SETTINGS_FILE"
  fi
else note "$SETTINGS_FILE already exists (left as it is)"; fi

# --- 6. Backup account may read the database, nothing else ---------------------------------------------------------------
say "6/8 Narrow read permission for the backup account"
# Pass-through only on the state folder; read access only inside the database folder, to files created there from now on.
STATE_ACL="$(getfacl -p /var/lib/mint-bot 2>/dev/null || true)"
DB_ACL="$(getfacl -p /var/lib/mint-bot/db 2>/dev/null || true)"
if grep -qx 'user:mintbot-backup:--x' <<<"$STATE_ACL" && ! grep -q '^default:' <<<"$STATE_ACL" \
   && grep -qx 'user:mintbot-backup:--x' <<<"$DB_ACL" && grep -qx 'default:user:mintbot-backup:r--' <<<"$DB_ACL"; then
  note "mintbot-backup: already allowed to pass through /var/lib/mint-bot and read new files in /var/lib/mint-bot/db only"
elif [ "$MODE" = check ]; then
  note "would let mintbot-backup pass through /var/lib/mint-bot and read the files created in /var/lib/mint-bot/db (read only)"; CHANGES=$((CHANGES + 1))
else
  CHANGES=$((CHANGES + 1))
  setfacl -k /var/lib/mint-bot                              # no inherited rule on the state folder itself
  setfacl -m u:mintbot-backup:--x /var/lib/mint-bot
  setfacl -m u:mintbot-backup:--x /var/lib/mint-bot/db
  setfacl -d -m u:mintbot-backup:r-- /var/lib/mint-bot/db
  note "mintbot-backup: pass through /var/lib/mint-bot; read files created in /var/lib/mint-bot/db; it owns only backups/ and backup-status/"
fi
# Database files that already exist in that folder (a restored copy, for example) get the same read permission,
# but only ordinary files owned by mintbot with a single name: never a link that could point at some other file.
if [ "$MODE" = apply ]; then
  for file in /var/lib/mint-bot/db/mintbot.sqlite /var/lib/mint-bot/db/mintbot.sqlite-wal /var/lib/mint-bot/db/mintbot.sqlite-shm; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    if [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c '%U %h' "$file")" = "mintbot 1" ]; then setfacl -m u:mintbot-backup:r-- "$file"; else echo "STOP: $file is not a plain file owned by mintbot." >&2; exit 1; fi
  done
fi

# --- 7. Service files ---------------------------------------------------------------------------------------------------
say "7/8 systemd unit files (installed, not started)"
for unit in mint-bot.service mint-bot-backup.service mint-bot-backup.timer; do
  SOURCE="$RELEASE_UNITS_DIR/$unit"
  [ -f "$SOURCE" ] || { echo "STOP: $SOURCE not found. Run this script from the repository's ops/host folder, or set MINT_BOT_UNITS_DIR." >&2; exit 1; }
  if ! cmp -s "$SOURCE" "/etc/systemd/system/$unit" 2>/dev/null; then act install -o root -g root -m 0644 "$SOURCE" "/etc/systemd/system/$unit"; else note "$unit is up to date"; fi
  [ ! -d "/etc/systemd/system/$unit.d" ] || { echo "STOP: /etc/systemd/system/$unit.d exists. A drop-in could change the reviewed hardening; remove it." >&2; exit 1; }
done
[ "$MODE" = check ] || systemctl daemon-reload

# --- 8. Summary ---------------------------------------------------------------------------------------------------------
say "8/8 Summary"
if [ "$MODE" = check ]; then echo "Check only: $CHANGES change(s) would be made. Nothing was changed."; else echo "Done. $CHANGES change(s) applied."; fi
cat <<'EOF'

Next steps (not done by this script):
  1. Put the application release in /opt/mint-bot/releases/<commit> and point /opt/mint-bot/current at it.
  2. Put the secrets in place (the owner does this; never paste them into chat):
       /etc/mint-bot/Rets/MINT_BOT_SECRETS.env  owner mintbot:mintbot, mode 0600
       /etc/mint-bot/secrets/backup-encryption-key, r2-access-key-id, r2-secret-access-key  owner root:root, mode 0600
  3. Replace MINT_BOT_HOST_ID in /etc/mint-bot/mint-bot.env.
  4. Run: sudo bash verify-host.sh --acl-selftest   and keep the report.
The service is not started and the kill switch is engaged.
EOF
