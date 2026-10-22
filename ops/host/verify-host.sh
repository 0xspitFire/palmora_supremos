#!/usr/bin/env bash
# MintBot production host evidence report (T-045). Read-only except for the optional self-test's own scratch folder.
#
#   sudo bash verify-host.sh                    report on identities, folders, services, network, time, memory and the kill switch
#   sudo bash verify-host.sh --acl-selftest     also prove the backup account can read a live database it does not own
#   sudo bash verify-host.sh --probe-outbound   also check that the host can reach the outside services over HTTPS
#
# It never reads a secret or an environment value, and prints no credential. The report is saved as
# /root/mintbot-host-evidence-<UTC time>.txt and its SHA-256 is printed, so the owner can witness and approve that exact file.
# Exit status is 1 if any check FAILS.
set -uo pipefail
umask 077

SELFTEST=0
PROBE=0
for arg in "$@"; do
  case "$arg" in
    --acl-selftest) SELFTEST=1 ;;
    --probe-outbound) PROBE=1 ;;
    *) echo "Usage: sudo bash verify-host.sh [--acl-selftest] [--probe-outbound]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo bash verify-host.sh" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/mintbot-host-evidence-$STAMP.txt"
exec > >(tee "$REPORT") 2>&1

PASS=0; FAIL=0; WARN=0
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'NOTE  %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

echo "MintBot host evidence report"
echo "Time (UTC): $STAMP"
echo "Host: $(hostname)   Kernel: $(uname -r)   OS: $(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
echo "Node: $(/usr/bin/node --version 2>/dev/null || echo 'not installed')"

section "1. Identities"
for account in mintbot mintbot-backup; do
  if getent passwd "$account" >/dev/null; then
    ok "$account exists: $(id "$account")"
    [ "$(getent passwd "$account" | cut -d: -f7)" = /usr/sbin/nologin ] && ok "$account has no login shell" || bad "$account has a login shell"
    [ "$(passwd -S "$account" 2>/dev/null | cut -d' ' -f2)" = L ] && ok "$account password is locked" || bad "$account password is not locked"
    [ ! -e "$(getent passwd "$account" | cut -d: -f6)/.ssh" ] && ok "$account has no SSH folder" || bad "$account has an SSH folder"
    for admin_group in sudo adm google-sudoers; do
      if getent group "$admin_group" | cut -d: -f4 | tr ',' '\n' | grep -qx "$account"; then bad "$account is in the $admin_group group"; else ok "$account is not in $admin_group"; fi
    done
  else bad "$account does not exist"; fi
done
if id -nG mintbot-backup 2>/dev/null | tr ' ' '\n' | grep -qx mintbot; then bad "mintbot-backup is in the mintbot group"; else ok "mintbot-backup is NOT in the mintbot group (it cannot read the application's files)"; fi
id -nG mintbot 2>/dev/null | tr ' ' '\n' | grep -qx mintbot-status && ok "mintbot is in mintbot-status" || bad "mintbot is not in mintbot-status"
id -nG mintbot-backup 2>/dev/null | tr ' ' '\n' | grep -qx mintbot-status && ok "mintbot-backup is in mintbot-status" || bad "mintbot-backup is not in mintbot-status"
[ ! -s /root/.ssh/authorized_keys ] && ok "root has no stored SSH keys" || warn "root has stored SSH keys (check they are yours)"

section "2. Folders (owner, mode)"
expect_dir() { # path owner:group mode
  if [ -d "$1" ]; then
    local actual; actual="$(stat -c '%U:%G %a' "$1")"
    [ "$actual" = "$2 ${3#0}" ] && ok "$1  $actual" || bad "$1  is $actual, expected $2 $3"
  else bad "$1 is missing"; fi
}
expect_dir /opt/mint-bot root:root 0755
expect_dir /opt/mint-bot/releases root:root 0755
expect_dir /etc/mint-bot root:root 0755
expect_dir /etc/mint-bot/secrets root:root 0700
expect_dir /etc/mint-bot/Rets root:mintbot 0750
expect_dir /var/lib/mint-bot mintbot:mintbot 0750
expect_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700
expect_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750
expect_dir /var/log/mint-bot mintbot:mintbot 0750
if [ -L /opt/mint-bot/current ]; then ok "/opt/mint-bot/current -> $(readlink /opt/mint-bot/current)"; else warn "/opt/mint-bot/current is not set yet (no release installed)"; fi
echo "Access list on /var/lib/mint-bot:"; getfacl -p /var/lib/mint-bot 2>/dev/null | sed 's/^/   /'
for secret_file in /etc/mint-bot/Rets/MINT_BOT_SECRETS.env /etc/mint-bot/secrets/backup-encryption-key /etc/mint-bot/secrets/r2-access-key-id /etc/mint-bot/secrets/r2-secret-access-key; do
  if [ -e "$secret_file" ]; then
    mode="$(stat -c '%U:%G %a' "$secret_file")"
    case "$mode" in
      "mintbot:mintbot 600"|"mintbot:root 600"|"root:root 600"|"root:mintbot 600") ok "$secret_file present, $mode (contents not read)" ;;
      *) bad "$secret_file has $mode, expected an owner-only mode 600" ;;
    esac
  else warn "$secret_file is not installed yet"; fi
done
if grep -Ev '^[[:space:]]*#' /etc/mint-bot/mint-bot.env 2>/dev/null | grep -Eq '^[A-Z0-9_]*(TOKEN|PASSWORD|PRIVATE|API_?KEY|ENCRYPTION|ACCESS_KEY|SECRET_ACCESS|RPC_URL|PING_URL)[A-Z0-9_]*='; then bad "/etc/mint-bot/mint-bot.env contains something that looks like a credential"; else ok "/etc/mint-bot/mint-bot.env holds no credential-looking entry"; fi

section "3. Services"
for unit in mint-bot.service mint-bot-backup.service mint-bot-backup.timer; do
  if [ -f "/etc/systemd/system/$unit" ]; then
    ok "$unit installed, sha256 $(sha256sum "/etc/systemd/system/$unit" | cut -c1-16)…"
  else bad "$unit is not installed"; fi
done
UNIT_TEXT="$(systemctl cat mint-bot.service 2>/dev/null)"
for setting in "User=mintbot" "NoNewPrivileges=true" "ProtectSystem=strict" "LimitCORE=0" "CapabilityBoundingSet=" "Restart=on-failure" "StartLimitBurst=5" "ReadOnlyPaths=/var/lib/mint-bot/backup-status" "ExecStartPre=/usr/bin/test -f /var/lib/mint-bot/killswitch"; do
  grep -qxF "$setting" <<<"$UNIT_TEXT" && ok "mint-bot.service sets $setting" || bad "mint-bot.service does not set $setting"
done
BACKUP_TEXT="$(systemctl cat mint-bot-backup.service 2>/dev/null)"
grep -q 'User=mintbot-backup' <<<"$BACKUP_TEXT" && ok "backup service runs as mintbot-backup" || bad "backup service does not run as mintbot-backup"
grep -q 'LoadCredential=' <<<"$BACKUP_TEXT" && ok "backup credentials are loaded by systemd, not through the environment" || bad "backup service has no LoadCredential"
echo "mint-bot.service: enabled=$(systemctl is-enabled mint-bot.service 2>/dev/null || true) active=$(systemctl is-active mint-bot.service 2>/dev/null || true)"
echo "mint-bot-backup.timer: enabled=$(systemctl is-enabled mint-bot-backup.timer 2>/dev/null || true) active=$(systemctl is-active mint-bot-backup.timer 2>/dev/null || true)"
echo "Exposure score (lower is better):"; systemd-analyze security mint-bot.service --no-pager 2>/dev/null | tail -n 2 | sed 's/^/   /'
if [ -f /var/lib/mint-bot/killswitch ]; then ok "kill switch file present: the service cannot start until it is released on purpose"; else bad "kill switch file is MISSING"; fi

section "4. Network (what is listening)"
LISTEN="$(ss -ltnH 2>/dev/null)"
echo "$LISTEN" | sed 's/^/   /'
NON_LOOPBACK="$(echo "$LISTEN" | awk '{print $4}' | grep -vE '^(127\.0\.0\.|\[::1\]|\[::ffff:127\.|127\.0\.0\.53%lo:|[^:]*%lo:)' | grep -vE ':22$' || true)"
if [ -z "$NON_LOOPBACK" ]; then ok "nothing listens publicly except SSH on port 22 (reachable only through Google's tunnel range if the firewall is set as agreed)"; else bad "listening on a non-loopback address: $(echo "$NON_LOOPBACK" | tr '\n' ' ')"; fi
if systemctl is-active --quiet mint-bot.service; then
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q '^127.0.0.1:8780$' && ok "health endpoint is on 127.0.0.1:8780 only" || bad "health endpoint is not on 127.0.0.1:8780"
else warn "the service is not running, so the health endpoint was not checked"; fi
warn "Google firewall rules are outside this machine: the owner confirms only the IAP rule (35.235.240.0/20, TCP 22) remains"

section "5. Time, memory, core dumps, updates"
[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && ok "clock is synchronised" || bad "clock is not synchronised"
[ "$(timedatectl show -p Timezone --value 2>/dev/null)" = UTC ] && ok "time zone is UTC" || bad "time zone is not UTC"
swapon --show --noheadings | grep -q . && ok "swap is on" || warn "no swap"
free -m | sed 's/^/   /'
[ "$(ulimit -c)" = 0 ] && ok "this shell allows no core dumps" || warn "this shell allows core dumps (the services set LimitCORE=0 themselves)"
grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null && ok "automatic security updates are on" || bad "automatic security updates are off"

if [ "$PROBE" -eq 1 ]; then
  section "6. Outbound HTTPS (a reply of any kind proves the route; no credential is sent)"
  for target in https://api.telegram.org https://api.turnkey.com https://hc-ping.com https://cloudflarestorage.com https://nodejs.org; do
    code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$target" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != 000 ]; then ok "reached $target (HTTP $code)"; else bad "could not reach $target"; fi
  done
  warn "the blockchain provider addresses hold a secret key, so they are checked by the service itself, not here"
fi

if [ "$SELFTEST" -eq 1 ]; then
  section "7. Self-test: can the backup account read a live database it does not own?"
  SCRATCH=/var/lib/mint-bot/.acl-selftest
  rm -rf "$SCRATCH"
  install -d -o mintbot -g mintbot -m 0750 "$SCRATCH"
  # The scratch folder gets the same default access list as the real state folder, so new files behave the same way.
  setfacl -m u:mintbot-backup:--x "$SCRATCH"
  setfacl -d -m u:mintbot-backup:r-- "$SCRATCH"
  DB="$SCRATCH/test.sqlite"
  # The application's own umask (0077) and account create a write-ahead-log database and keep it open, as the service does.
  ( printf 'PRAGMA journal_mode=WAL;\nCREATE TABLE t(a);\nINSERT INTO t VALUES (42);\n'; sleep 25 ) | runuser -u mintbot -- sh -c "umask 077; exec sqlite3 '$DB'" >/dev/null 2>&1 &
  HOLDER=$!
  for _ in $(seq 1 20); do [ -e "$DB-wal" ] && break; sleep 0.5; done
  ls -l "$SCRATCH" | sed 's/^/   /'
  VALUE="$(runuser -u mintbot-backup -- sqlite3 -readonly "$DB" 'SELECT a FROM t;' 2>&1 || true)"
  if [ "$VALUE" = 42 ]; then ok "mintbot-backup read the live database (value 42) without owning it"; else bad "mintbot-backup could not read the live database: $VALUE"; fi
  if runuser -u mintbot-backup -- sh -c "echo x >> '$DB'" 2>/dev/null; then bad "mintbot-backup can WRITE to the database"; else ok "mintbot-backup cannot write to the database"; fi
  if runuser -u mintbot-backup -- cat /etc/mint-bot/Rets/MINT_BOT_SECRETS.env >/dev/null 2>&1; then bad "mintbot-backup can read the application's secret store"; else ok "mintbot-backup cannot read the application's secret store"; fi
  if runuser -u mintbot -- sh -c "echo x > /var/lib/mint-bot/backup-status/forged" 2>/dev/null; then bad "mintbot can write into the backup-status folder (it could forge readiness)"; rm -f /var/lib/mint-bot/backup-status/forged; else ok "mintbot cannot write into the backup-status folder"; fi
  if runuser -u mintbot -- ls /var/lib/mint-bot/backups >/dev/null 2>&1; then bad "mintbot can list the backups folder"; else ok "mintbot cannot read the backups folder"; fi
  kill "$HOLDER" 2>/dev/null || true
  wait "$HOLDER" 2>/dev/null || true
  rm -rf "$SCRATCH"
fi

section "Result"
echo "PASS: $PASS   FAIL: $FAIL   NOTES: $WARN"
sync
echo "Report saved: $REPORT"
echo "To fix this exact report for approval, run:  sha256sum $REPORT   and keep the line it prints."
[ "$FAIL" -eq 0 ]
