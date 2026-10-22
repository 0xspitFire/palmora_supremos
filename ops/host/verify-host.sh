#!/usr/bin/env bash
# MintBot production host evidence report (T-045). Read-only, except that --acl-selftest creates and removes a scratch folder
# inside the database folder, using the application's own account.
#
#   sudo bash verify-host.sh                    report on identities, folders, units, listeners, time, memory and the kill switch
#   sudo bash verify-host.sh --acl-selftest     also prove, by trying it, who can read and write what
#   sudo bash verify-host.sh --probe-outbound   also check that the host can reach the outside services over HTTPS
#
# It never reads a secret or an environment value, and prints no credential. The report is saved as
# /root/mintbot-host-evidence-<UTC time>.txt; the SHA-256 of the finished file is printed last so the owner can approve that
# exact report. Exit status is 1 if any check FAILS.
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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS_DIR="${MINT_BOT_UNITS_DIR:-$HERE/../systemd}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="/root/mintbot-host-evidence-$STAMP.txt"
SETTINGS_FILE=/etc/mint-bot/mint-bot.env
SELFTEST_DB=/var/lib/mint-bot/db/.selftest.sqlite
HOLDER_OUT=""
HOLDER=""

PASS=0; FAIL=0; WARN=0
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'NOTE  %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
as() { local who="$1"; shift; runuser -u "$who" -- "$@"; }

expect_dir() { # path owner:group mode
  if [ -L "$1" ]; then bad "$1 is a symbolic link"; return; fi
  if [ -d "$1" ]; then
    local actual; actual="$(stat -c '%U:%G %a' "$1")"
    if [ "$actual" = "$2 ${3#0}" ]; then ok "$1  $actual"; else bad "$1  is $actual, expected $2 $3"; fi
  else bad "$1 is missing"; fi
}
expect_file() { # path owner:group mode description
  if [ -L "$1" ]; then bad "$1 is a symbolic link"; return; fi
  if [ -f "$1" ]; then
    local actual; actual="$(stat -c '%U:%G %a' "$1")"
    if [ "$actual" = "$2 ${3#0}" ]; then ok "$4 present, $actual (contents not read)"; else bad "$4 is $actual, expected $2 $3"; fi
  else warn "$4 is not installed yet ($1)"; fi
}
setting() { systemctl show "$1" -p "$2" --value 2>/dev/null; }

cleanup() {
  [ -z "$HOLDER" ] || kill "$HOLDER" 2>/dev/null
  [ -z "$HOLDER_OUT" ] || rm -f "$HOLDER_OUT"
  if id mintbot >/dev/null 2>&1; then as mintbot rm -f "$SELFTEST_DB" "$SELFTEST_DB-wal" "$SELFTEST_DB-shm" "$SELFTEST_DB-journal" 2>/dev/null; fi
}
trap cleanup EXIT

main() {
trap cleanup EXIT
echo "MintBot host evidence report"
echo "Time (UTC): $STAMP"
echo "Host: $(hostname)   Kernel: $(uname -r)   OS: $(. /etc/os-release; echo "${PRETTY_NAME:-unknown}")"
echo "Node: $(/usr/bin/node --version 2>/dev/null || echo 'not installed')"

NODE_REAL="$(readlink -f /usr/bin/node 2>/dev/null)"
NODE_TREE="$(dirname "$(dirname "$NODE_REAL")")"
if [ -f "$NODE_REAL" ] && [ -z "$(find "$NODE_TREE" \( ! -user root -o -perm /022 \) ! -type l -print -quit 2>/dev/null)" ]; then ok "Node program tree ($NODE_TREE) belongs to root and nobody else can change it"; else bad "Node program tree ($NODE_TREE) has a file not owned by root or writable by others"; fi

section "1. Identities"
for account in mintbot mintbot-backup; do
  if getent passwd "$account" >/dev/null; then
    ok "$account exists: $(id "$account")"
    if [ "$(getent passwd "$account" | cut -d: -f7)" = /usr/sbin/nologin ]; then ok "$account has no login shell"; else bad "$account has a login shell"; fi
    if [ "$(passwd -S "$account" 2>/dev/null | cut -d' ' -f2)" = L ]; then ok "$account password is locked"; else bad "$account password is not locked"; fi
    if [ ! -e "$(getent passwd "$account" | cut -d: -f6)/.ssh" ]; then ok "$account has no SSH folder"; else bad "$account has an SSH folder"; fi
    for admin_group in sudo adm google-sudoers; do
      if getent group "$admin_group" | cut -d: -f4 | tr ',' '\n' | grep -qx "$account"; then bad "$account is in the $admin_group group"; else ok "$account is not in $admin_group"; fi
    done
  else bad "$account does not exist"; fi
done
if id -nG mintbot-backup 2>/dev/null | tr ' ' '\n' | grep -qx mintbot; then bad "mintbot-backup is in the mintbot group"; else ok "mintbot-backup is NOT in the mintbot group (it cannot read the application's files)"; fi
if id -nG mintbot 2>/dev/null | tr ' ' '\n' | grep -qx mintbot-status; then ok "mintbot is in mintbot-status"; else bad "mintbot is not in mintbot-status"; fi
if id -nG mintbot-backup 2>/dev/null | tr ' ' '\n' | grep -qx mintbot-status; then ok "mintbot-backup is in mintbot-status"; else bad "mintbot-backup is not in mintbot-status"; fi
if [ ! -s /root/.ssh/authorized_keys ]; then ok "root has no stored SSH keys"; else warn "root has stored SSH keys (check they are yours)"; fi

section "2. Folders and files (owner, mode)"
expect_dir /opt/mint-bot root:root 0755
expect_dir /opt/mint-bot/releases root:root 0755
expect_dir /etc/mint-bot root:root 0755
expect_dir /etc/mint-bot/secrets root:root 0700
expect_dir /etc/mint-bot/Rets root:mintbot 0750
expect_dir /var/lib/mint-bot mintbot:mintbot 0750
expect_dir /var/lib/mint-bot/db mintbot:mintbot 0750
expect_dir /var/lib/mint-bot/backups mintbot-backup:mintbot-backup 0700
expect_dir /var/lib/mint-bot/backup-status mintbot-backup:mintbot-status 0750
expect_dir /var/log/mint-bot mintbot:mintbot 0750
if [ -L /opt/mint-bot/current ]; then ok "/opt/mint-bot/current -> $(readlink /opt/mint-bot/current)"; else warn "/opt/mint-bot/current is not set yet (no release installed)"; fi
echo "Access list on /var/lib/mint-bot:"; getfacl -p /var/lib/mint-bot 2>/dev/null | sed 's/^/   /'
echo "Access list on /var/lib/mint-bot/db:"; getfacl -p /var/lib/mint-bot/db 2>/dev/null | sed 's/^/   /'
STATE_ACL="$(getfacl -p /var/lib/mint-bot 2>/dev/null)"
DB_ACL="$(getfacl -p /var/lib/mint-bot/db 2>/dev/null)"
if grep -qx 'user:mintbot-backup:--x' <<<"$DB_ACL" && grep -qx 'default:user:mintbot-backup:r--' <<<"$DB_ACL"; then ok "database folder: backup account may pass through and read new files (read only)"; else bad "database folder is missing the backup account's pass-through or inherited read rule"; fi
for plain in /var/lib/mint-bot/backups /var/lib/mint-bot/backup-status; do
  if getfacl -p "$plain" 2>/dev/null | grep -Eq '^(user|group|default):[^:]'; then bad "$plain has an extended access rule (it must have none)"; else ok "$plain has no extended access rule"; fi
done
if grep -q '^default:' <<<"$STATE_ACL"; then bad "/var/lib/mint-bot has an inherited access rule (it must exist only on the db folder)"; else ok "no inherited access rule on /var/lib/mint-bot (jobs, restart counter and kill switch stay private to mintbot)"; fi
# Each secret file against its OWN expected owner: a backup key owned by the application would defeat the separation.
expect_file /etc/mint-bot/Rets/MINT_BOT_SECRETS.env mintbot:mintbot 0600 "application secret store"
expect_file /etc/mint-bot/secrets/backup-encryption-key root:root 0600 "backup encryption key"
expect_file /etc/mint-bot/secrets/r2-access-key-id root:root 0600 "R2 access key id"
expect_file /etc/mint-bot/secrets/r2-secret-access-key root:root 0600 "R2 secret access key"
expect_file "$SETTINGS_FILE" root:root 0644 "settings file"
LOOKS_LIKE_SECRET='(TOKEN|PASSWORD|PRIVATE|KEY|SECRET|CREDENTIAL|MNEMONIC|SEED|RPC_URL|PING_URL)'
if grep -Ev '^[[:space:]]*#' "$SETTINGS_FILE" 2>/dev/null | cut -d= -f1 | grep -Ev '^(SECRET_STORE_PATH)$' | grep -Eq "$LOOKS_LIKE_SECRET"; then bad "$SETTINGS_FILE has an entry whose name looks like a credential"; else ok "$SETTINGS_FILE has no credential-named entry"; fi
if grep -Ev '^[[:space:]]*#' "$SETTINGS_FILE" 2>/dev/null | grep -Eq '://[^ ]*@|=[A-Za-z0-9+/_-]{40,}$'; then bad "$SETTINGS_FILE has a value that looks like a credential"; else ok "$SETTINGS_FILE has no credential-looking value"; fi
if grep -q 'REPLACE-WITH' "$SETTINGS_FILE" 2>/dev/null; then warn "$SETTINGS_FILE still has an unfilled placeholder (MINT_BOT_HOST_ID): fill it in before the service runs"; else ok "no unfilled placeholder in $SETTINGS_FILE"; fi

section "3. Services (effective settings, not just text)"
for unit in mint-bot.service mint-bot-backup.service mint-bot-backup.timer; do
  if [ -f "/etc/systemd/system/$unit" ]; then
    if [ -f "$UNITS_DIR/$unit" ]; then
      if cmp -s "$UNITS_DIR/$unit" "/etc/systemd/system/$unit"; then ok "$unit is identical to the checked-in file (sha256 $(sha256sum "/etc/systemd/system/$unit" | cut -c1-16)…)"; else bad "$unit differs from the checked-in file"; fi
    else warn "$unit installed (sha256 $(sha256sum "/etc/systemd/system/$unit" | cut -c1-16)…); checked-in copy not found at $UNITS_DIR"; fi
    if [ -d "/etc/systemd/system/$unit.d" ] || [ -n "$(setting "$unit" DropInPaths)" ]; then bad "$unit has a drop-in override"; else ok "$unit has no drop-in override"; fi
  else bad "$unit is not installed"; fi
done
want() { # unit property expected-exact-value
  local value; value="$(setting "$1" "$2")"
  if [ "$value" = "$3" ]; then ok "$1 effective $2 = ${value:-<empty>}"; else bad "$1 effective $2 is '${value:-<empty>}', expected '$3'"; fi
}
want_has() { # unit property expected-substring (for lists and commands)
  local value; value="$(setting "$1" "$2")"
  if grep -qF -- "$3" <<<"$value"; then ok "$1 effective $2 includes $3"; else bad "$1 effective $2 is '${value:-<empty>}', expected it to include '$3'"; fi
}
want mint-bot.service User mintbot
want mint-bot.service NoNewPrivileges yes
want mint-bot.service ProtectSystem strict
want mint-bot.service LimitCORE 0
want mint-bot.service CapabilityBoundingSet ""
want mint-bot.service Restart on-failure
want mint-bot.service StartLimitBurst 5
want_has mint-bot.service ReadOnlyPaths /var/lib/mint-bot/backup-status
want mint-bot.service UMask 0077
want_has mint-bot.service ExecStartPre "/usr/bin/test -f /var/lib/mint-bot/killswitch"
want mint-bot-backup.service User mintbot-backup
want_has mint-bot-backup.service ReadOnlyPaths /var/lib/mint-bot
want mint-bot-backup.service UMask 0027
if [ -n "$(setting mint-bot-backup.service LoadCredential)" ]; then ok "backup credentials are loaded by systemd, not through the environment"; else bad "backup service has no LoadCredential"; fi
echo "mint-bot.service: enabled=$(systemctl is-enabled mint-bot.service 2>/dev/null || true) active=$(systemctl is-active mint-bot.service 2>/dev/null || true)"
echo "mint-bot-backup.timer: enabled=$(systemctl is-enabled mint-bot-backup.timer 2>/dev/null || true) active=$(systemctl is-active mint-bot-backup.timer 2>/dev/null || true)"
echo "Exposure score (lower is better):"; systemd-analyze security mint-bot.service --no-pager 2>/dev/null | tail -n 2 | sed 's/^/   /'
if [ -f /var/lib/mint-bot/killswitch ] && [ ! -L /var/lib/mint-bot/killswitch ]; then ok "kill switch file present: the service cannot start until it is released on purpose"; else bad "kill switch file is MISSING"; fi

section "4. Network (what is listening)"
LISTEN="$(ss -ltnH 2>/dev/null)"
if [ -z "$LISTEN" ]; then bad "could not list listening TCP ports (ss failed or showed nothing; a working host always shows SSH)"; else
  echo "$LISTEN" | sed 's/^/   /'
  NON_LOOPBACK="$(echo "$LISTEN" | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[::ffff:127\.|[^:]*%lo:)' | grep -vE ':22$' || true)"
  if [ -z "$NON_LOOPBACK" ]; then ok "no TCP port listens publicly except SSH on 22 (reachable only through Google's tunnel range if the firewall is set as agreed)"; else bad "TCP listening on a non-loopback address: $(echo "$NON_LOOPBACK" | tr '\n' ' ')"; fi
fi
UDP_LISTEN="$(ss -lunH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[::ffff:127\.|[^:]*%lo:)' | grep -vE ':68$' || true)"
if [ -z "$UDP_LISTEN" ]; then ok "no UDP port listens publicly (apart from DHCP client)"; else warn "UDP listening on a non-loopback address: $(echo "$UDP_LISTEN" | tr '\n' ' ')"; fi
if systemctl is-active --quiet mint-bot.service; then
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q '^127.0.0.1:8780$'; then ok "health endpoint is on 127.0.0.1:8780 only"; else bad "health endpoint is not on 127.0.0.1:8780"; fi
else warn "the service is not running, so the health endpoint was not checked"; fi
warn "Google firewall rules are outside this machine: the owner confirms only the IAP rule (35.235.240.0/20, TCP 22) remains"

section "5. Time, memory, core dumps, updates"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then ok "clock is synchronised"; else bad "clock is not synchronised"; fi
if [ "$(timedatectl show -p Timezone --value 2>/dev/null)" = UTC ]; then ok "time zone is UTC"; else bad "time zone is not UTC"; fi
if swapon --show --noheadings | grep -q .; then ok "swap is on"; else warn "no swap"; fi
free -m | sed 's/^/   /'
if [ "$(ulimit -c)" = 0 ]; then ok "this shell allows no core dumps"; else warn "this shell allows core dumps (the services set LimitCORE=0 themselves)"; fi
if grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null; then ok "automatic security updates are on"; else bad "automatic security updates are off"; fi

if [ "$PROBE" -eq 1 ]; then
  section "6. Outbound HTTPS (a reply of any kind proves the route; no credential is sent)"
  # The R2 address is the one the backup job will really use, built from the non-secret settings (not a bare domain, which never answers).
  R2_TARGET=""
  R2_ACCOUNT="$(grep -E '^R2_ACCOUNT_ID=' "$SETTINGS_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  R2_JURISDICTION="$(grep -E '^R2_JURISDICTION=' "$SETTINGS_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if grep -Eq '^[a-f0-9]{32}$' <<<"$R2_ACCOUNT"; then
    case "$R2_JURISDICTION" in ""|automatic) R2_TARGET="https://$R2_ACCOUNT.r2.cloudflarestorage.com" ;; eu|us|fedramp) R2_TARGET="https://$R2_ACCOUNT.$R2_JURISDICTION.r2.cloudflarestorage.com" ;; esac
  fi
  [ -n "$R2_TARGET" ] || warn "the R2 settings are not filled in, so the route to R2 was NOT checked"
  for target in https://api.telegram.org https://api.turnkey.com https://hc-ping.com https://nodejs.org $R2_TARGET; do
    code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$target" 2>/dev/null || true)"
    if [ -n "$code" ] && [ "$code" != 000 ]; then ok "reached $target (HTTP $code)"; else bad "could not reach $target"; fi
  done
  warn "the blockchain provider addresses hold a secret key, so they are checked by the service itself, not here"
fi

if [ "$SELFTEST" -eq 1 ]; then
  section "7. Self-test: who can read and write what, proved by trying it"
  if [ -L /var/lib/mint-bot/db ] || [ ! -d /var/lib/mint-bot/db ]; then bad "the database folder is missing or a link: self-test not run"; else
    # Everything inside the application-writable folders is created, used and removed by the application's own account, never by root.
    # The test database sits directly in the database folder, exactly where the real one lives, so it gets the real inherited rule.
    DB="$SELFTEST_DB"
    as mintbot rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal" 2>/dev/null
    HOLDER_OUT="$(mktemp)"
    # The application's account creates a write-ahead-log database under the application's own umask and keeps it open, as the service does.
    ( printf 'PRAGMA journal_mode=WAL;\nCREATE TABLE t(a);\nINSERT INTO t VALUES (42);\n'; sleep 25 ) | runuser -u mintbot -- sh -c "umask 077; exec sqlite3 '$DB'" >"$HOLDER_OUT" 2>&1 &
    HOLDER=$!
    for _ in $(seq 1 20); do [ -e "$DB-wal" ] && break; sleep 0.5; done
    ls -la /var/lib/mint-bot/db | sed 's/^/   /'
    if grep -qx wal "$HOLDER_OUT"; then ok "the test database really is in write-ahead-log mode (like the real one)"; else bad "the test database was not in write-ahead-log mode: the result below proves nothing"; fi
    if [ -e "$DB-wal" ] && [ -e "$DB-shm" ]; then ok "the log and shared-memory files exist beside the database"; else bad "the log or shared-memory file is missing"; fi
    VALUE="$(as mintbot-backup sqlite3 -readonly "$DB" 'SELECT a FROM t;' 2>&1 || true)"
    if [ "$VALUE" = 42 ]; then ok "mintbot-backup read the live database (value 42) without owning it, through the real inherited access rule"; else bad "mintbot-backup could not read the live database: $VALUE"; fi
    if as mintbot test -w "$DB"; then ok "control: mintbot can write its own database"; else bad "control failed: mintbot cannot write its own database"; fi
    if as mintbot-backup sh -c "echo x >> '$DB'" 2>/dev/null; then bad "mintbot-backup can WRITE to the database"; else ok "mintbot-backup cannot write to the database"; fi
    # A file outside the database folder must stay unreadable to the backup account.
    NONDB=/var/lib/mint-bot/.selftest-other
    if as mintbot sh -c "umask 077; echo private > '$NONDB'" 2>/dev/null; then
      if as mintbot-backup cat "$NONDB" >/dev/null 2>&1; then bad "mintbot-backup can read a file outside the database folder"; else ok "mintbot-backup cannot read other application files (jobs, counters, kill switch)"; fi
      as mintbot rm -f "$NONDB"
    else bad "could not create the control file as mintbot"; fi
    kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; HOLDER=""
    as mintbot rm -f "$DB" "$DB-wal" "$DB-shm" "$DB-journal" 2>/dev/null
  fi
  # The application must not read the backup account's credentials or area; each negative has a positive control.
  if as mintbot-backup test -r /var/lib/mint-bot/backups; then ok "control: mintbot-backup can read its own backups folder"; else bad "control failed: mintbot-backup cannot read its own backups folder"; fi
  if as mintbot ls /var/lib/mint-bot/backups >/dev/null 2>&1; then bad "mintbot can read the backups folder"; else ok "mintbot cannot read the backups folder"; fi
  if [ -f /etc/mint-bot/Rets/MINT_BOT_SECRETS.env ]; then
    if as mintbot test -r /etc/mint-bot/Rets/MINT_BOT_SECRETS.env; then ok "control: mintbot can read the application secret store"; else bad "control failed: mintbot cannot read the application secret store"; fi
    if as mintbot-backup cat /etc/mint-bot/Rets/MINT_BOT_SECRETS.env >/dev/null 2>&1; then bad "mintbot-backup can read the application's secret store"; else ok "mintbot-backup cannot read the application's secret store"; fi
  else warn "the application secret store is not installed yet, so the secret-separation check was NOT run"; fi
  if as mintbot-backup touch /var/lib/mint-bot/backup-status/.selftest 2>/dev/null; then ok "control: mintbot-backup can write the backup status folder"; as mintbot-backup rm -f /var/lib/mint-bot/backup-status/.selftest; else bad "control failed: mintbot-backup cannot write the status folder"; fi
  if as mintbot touch /var/lib/mint-bot/backup-status/.forged 2>/dev/null; then bad "mintbot can write into the backup-status folder (it could forge readiness)"; as mintbot rm -f /var/lib/mint-bot/backup-status/.forged 2>/dev/null; else ok "mintbot cannot write into the backup-status folder"; fi
  # The service also may not replace the folder through its writable parent: that protection is the unit's read-only mount, so test under the same settings.
  if command -v systemd-run >/dev/null 2>&1 && systemd-run --quiet --wait --pipe -p User=mintbot /bin/true >/dev/null 2>&1; then
    UNIT_SETTINGS=(-p User=mintbot -p ProtectSystem=strict -p "ReadWritePaths=/var/lib/mint-bot /var/log/mint-bot" -p ReadOnlyPaths=/var/lib/mint-bot/backup-status)
    # Control first: under the same settings the service CAN write elsewhere in its state folder, so the refusal below is meaningful.
    if systemd-run --quiet --wait --pipe "${UNIT_SETTINGS[@]}" /usr/bin/touch /var/lib/mint-bot/.selftest-systemd >/dev/null 2>&1; then
      ok "control: under the service's own settings, mintbot can write elsewhere in its state folder"
      as mintbot rm -f /var/lib/mint-bot/.selftest-systemd
      MOVE_OUT="$(systemd-run --quiet --wait --pipe "${UNIT_SETTINGS[@]}" /usr/bin/mv /var/lib/mint-bot/backup-status /var/lib/mint-bot/backup-status.moved 2>&1)"; MOVE_RC=$?
      if [ "$MOVE_RC" -eq 0 ]; then
        bad "under the service's own settings, mintbot could MOVE the backup-status folder"; [ -d /var/lib/mint-bot/backup-status.moved ] && mv /var/lib/mint-bot/backup-status.moved /var/lib/mint-bot/backup-status
      elif grep -qiE 'read-only|resource busy' <<<"$MOVE_OUT" && [ -d /var/lib/mint-bot/backup-status ]; then ok "under the service's own settings, mintbot cannot replace the backup-status folder (the move was refused because it is a mount point)"
      else warn "the move was refused but not for the expected reason, so this check proves nothing: $MOVE_OUT"; fi
    MOUNT_OPTIONS="$(systemd-run --quiet --wait --pipe "${UNIT_SETTINGS[@]}" /usr/bin/findmnt -no OPTIONS /var/lib/mint-bot/backup-status 2>&1 | tail -n 1)"
    if grep -qE '(^|,)ro(,|$)' <<<"$MOUNT_OPTIONS"; then ok "inside the service the backup-status folder is mounted read-only ($MOUNT_OPTIONS)"; else warn "could not confirm the read-only mount of the backup-status folder from inside the service (saw: ${MOUNT_OPTIONS:-nothing})"; fi
    else warn "the control write under the service's settings failed, so the replace-the-status-folder check was NOT run"; fi
  else warn "systemd-run is not usable here, so the replace-the-status-folder check was NOT run"; fi
fi

section "Result"
echo "PASS: $PASS   FAIL: $FAIL   NOTES: $WARN"
[ "$FAIL" -eq 0 ]
}

main 2>&1 | tee "$REPORT"
RESULT=${PIPESTATUS[0]}
echo "Report saved: $REPORT"
echo "To approve this exact report, keep this line: $(sha256sum "$REPORT" | cut -d' ' -f1)  $REPORT"
exit "$RESULT"
