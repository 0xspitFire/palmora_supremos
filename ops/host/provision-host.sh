#!/usr/bin/env bash
# MintBot production host provisioning (T-045). Run ONCE as root on the VM:
#
#   sudo bash provision-host.sh            apply everything below (safe to run again)
#   sudo bash provision-host.sh --check    only report what would change; changes nothing
#
# It prepares the machine: packages, time, swap, the service accounts and groups, the folders with their owners and modes,
# the narrow read permission that lets the backup account read the database, and the two systemd service files.
# It does NOT install the application code, does NOT create or read any secret, does NOT start the service and does NOT
# release the kill switch. Afterwards run verify-host.sh and keep its report as evidence.
set -euo pipefail

MODE=apply
case "${1:-}" in
  --check) MODE=check ;;
  "") ;;
  *) echo "Usage: sudo bash provision-host.sh [--check]" >&2; exit 2 ;;
esac

NODE_VERSION="${MINT_BOT_NODE_VERSION:-20.19.1}"
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
say "2/8 Node.js $NODE_VERSION (official build from nodejs.org, checksum verified)"
CURRENT_NODE="$(/usr/bin/node --version 2>/dev/null || true)"
if [ "$CURRENT_NODE" = "v$NODE_VERSION" ]; then note "node $CURRENT_NODE is already at /usr/bin/node"; else
  note "found: ${CURRENT_NODE:-no node}; installing v$NODE_VERSION"
  if [ "$MODE" = check ]; then note "would download node-v$NODE_VERSION-linux-x64.tar.xz, verify its SHA-256 against nodejs.org's list and link /usr/bin/node"; CHANGES=$((CHANGES + 1)); else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
    curl -fsSL --max-time 300 -o "$TMP/$TARBALL" "https://nodejs.org/dist/v${NODE_VERSION}/$TARBALL"
    curl -fsSL --max-time 60 -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
    EXPECTED="$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
    ACTUAL="$(sha256sum "$TMP/$TARBALL" | cut -d' ' -f1)"
    [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "STOP: the download does not match nodejs.org's checksum." >&2; exit 1; }
    note "checksum verified: $ACTUAL"
    mkdir -p /opt/node
    tar -xJf "$TMP/$TARBALL" -C /opt/node
    ln -sfn "/opt/node/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/bin/node
    note "installed $(/usr/bin/node --version)"
  fi
fi

# --- 3. Swap ------------------------------------------------------------------------------------------------------------
say "3/8 Swap file (${SWAP_SIZE_MB} MB safety cushion for updates)"
if [ "$(swapon --show --noheadings | wc -l)" -gt 0 ]; then note "swap is already on"; else
  if [ "$MODE" = check ]; then note "would create /swapfile (${SWAP_SIZE_MB} MB), enable it and keep it across restarts"; CHANGES=$((CHANGES + 1)); else
    [ -e /swapfile ] || { fallocate -l "${SWAP_SIZE_MB}M" /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi
if [ ! -f /etc/sysctl.d/99-mint-bot.conf ]; then
  if [ "$MODE" = check ]; then note "would set low swappiness"; CHANGES=$((CHANGES + 1)); else
    printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-mint-bot.conf; sysctl -q -p /etc/sysctl.d/99-mint-bot.conf
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
  if [ ! -d "$1" ]; then act install -d -o "${2%%:*}" -g "${2##*:}" -m "$3" "$1"; else
    [ "$(stat -c '%U:%G %a' "$1")" = "${2} ${3#0}" ] || act bash -c "chown '$2' '$1' && chmod '$3' '$1'"
  fi
}
ensure_dir /opt/mint-bot root:root 0755
ensure_dir /opt/mint-bot/releases root:root 0755
ensure_dir /etc/mint-bot root:root 0755
# Non-secret settings only. Backup credentials live in /etc/mint-bot/secrets (read by systemd, never by the application).
ensure_dir /etc/mint-bot/secrets root:root 0700
# The host secret store (Telegram, provider addresses, monitor address). The application's loader insists on a folder
# named Rets and on a file only its owner can read; /etc is read-only to the service, so it cannot change the file.
ensure_dir /etc/mint-bot/Rets root:mintbot 0750
ensure_dir /var/lib/mint-bot mintbot:mintbot 0750
ensure_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700
ensure_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750
ensure_dir /var/log/mint-bot mintbot:mintbot 0750
if [ ! -f /var/lib/mint-bot/killswitch ]; then
  act install -o mintbot -g mintbot -m 0600 /dev/null /var/lib/mint-bot/killswitch
  note "kill switch ENGAGED (the service refuses to start without this file; releasing it is a deliberate, separate step)"
else note "kill switch file present (engaged)"; fi

# Settings for the unit: paths and switches only, no secret. The owner adds the wallet addresses and other options later.
ENV_FILE=/etc/mint-bot/mint-bot.env
if [ ! -f "$ENV_FILE" ]; then
  if [ "$MODE" = check ]; then note "would write $ENV_FILE"; CHANGES=$((CHANGES + 1)); else
    cat > "$ENV_FILE" <<'EOF'
# MintBot production settings (not secret). Credentials never go in this file.
MINT_BOT_SERVICE_MODE=dry-run
MINT_BOT_STATE_PATH=/var/lib/mint-bot/mintbot.sqlite
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
MINT_BOT_HOST_ID=REPLACE-WITH-STABLE-HOST-ID
EOF
    chown root:root "$ENV_FILE"; chmod 0644 "$ENV_FILE"
  fi
else note "$ENV_FILE already exists (left as it is)"; fi

# --- 6. Backup account may read the database, nothing else ---------------------------------------------------------------
say "6/8 Narrow read permission for the backup account"
ACL_TEXT="$(getfacl -p /var/lib/mint-bot 2>/dev/null || true)"
if grep -qx 'user:mintbot-backup:--x' <<<"$ACL_TEXT" && grep -qx 'default:user:mintbot-backup:r--' <<<"$ACL_TEXT"; then
  note "mintbot-backup: already allowed to pass through /var/lib/mint-bot and read new database files"
elif [ "$MODE" = check ]; then
  note "would let mintbot-backup pass through /var/lib/mint-bot and read the database files created there (read only)"; CHANGES=$((CHANGES + 1))
else
  CHANGES=$((CHANGES + 1))
  # Applied after the folders above exist, so the backup and status folders do not inherit it.
  setfacl -m u:mintbot-backup:--x /var/lib/mint-bot
  setfacl -d -m u:mintbot-backup:r-- /var/lib/mint-bot
  note "mintbot-backup: traverse /var/lib/mint-bot, read new database files; it owns only backups/ and backup-status/"
fi
# Database files that already exist (a restored copy, for example) get the same read permission.
if [ "$MODE" = apply ]; then
  for file in /var/lib/mint-bot/mintbot.sqlite /var/lib/mint-bot/mintbot.sqlite-wal /var/lib/mint-bot/mintbot.sqlite-shm; do
    [ ! -e "$file" ] || setfacl -m u:mintbot-backup:r-- "$file"
  done
fi

# --- 7. Service files ---------------------------------------------------------------------------------------------------
say "7/8 systemd service files (installed, not started)"
for unit in mint-bot.service mint-bot-backup.service mint-bot-backup.timer; do
  SOURCE="$RELEASE_UNITS_DIR/$unit"
  [ -f "$SOURCE" ] || { echo "STOP: $SOURCE not found. Run this script from the repository's ops/host folder, or set MINT_BOT_UNITS_DIR." >&2; exit 1; }
  if ! cmp -s "$SOURCE" "/etc/systemd/system/$unit" 2>/dev/null; then act install -o root -g root -m 0644 "$SOURCE" "/etc/systemd/system/$unit"; else note "$unit is up to date"; fi
done
[ "$MODE" = check ] || systemctl daemon-reload

# --- 8. Summary ---------------------------------------------------------------------------------------------------------
say "8/8 Summary"
if [ "$MODE" = check ]; then echo "Check only: $CHANGES change(s) would be made. Nothing was changed."; else echo "Done. $CHANGES change(s) applied."; fi
cat <<'EOF'

Next steps (not done by this script):
  1. Put the application release in /opt/mint-bot/releases/<commit> and point /opt/mint-bot/current at it.
  2. Put the secrets in place (the owner does this; never paste them into chat):
       /etc/mint-bot/Rets/MINT_BOT_SECRETS.env  owner mintbot, mode 0600
       /etc/mint-bot/secrets/backup-encryption-key, r2-access-key-id, r2-secret-access-key  owner root, mode 0600
  3. Replace MINT_BOT_HOST_ID in /etc/mint-bot/mint-bot.env.
  4. Run: sudo bash verify-host.sh --acl-selftest   and keep the report.
The service is not started and the kill switch is engaged.
EOF
