#!/usr/bin/env bash
# Invoked through IAP by deploy-release.sh using same-commit, hash-checked inputs.
# No database restore, migration deletion, signing or kill release is permitted.
set -euo pipefail

[ "$#" -eq 6 ] || { echo 'STOP: six reviewed cutover inputs required' >&2; exit 2; }
ARCHIVE="$1" DIGEST="$2" INSTALLER="$3" INSTALLER_DIGEST="$4" MIGRATIONS_DIGEST="$5" ALLOW_FORWARD_ONLY="$6"
[[ "$DIGEST" =~ ^[0-9a-f]{64}$ && "$INSTALLER_DIGEST" =~ ^[0-9a-f]{64}$ && "$MIGRATIONS_DIGEST" =~ ^[0-9a-f]{64}$ && "$ALLOW_FORWARD_ONLY" =~ ^[01]$ ]] || exit 2
printf '%s  %s\n%s  %s\n' "$DIGEST" "$ARCHIVE" "$INSTALLER_DIGEST" "$INSTALLER" | sha256sum --check --status
OLD="$(readlink -f /opt/mint-bot/current)"
[[ "$OLD" =~ ^/opt/mint-bot/releases/[0-9a-f]{40}$ ]] || { echo 'STOP: invalid current release' >&2; exit 1; }
migration_files="$(find "$OLD/packages/database/migrations" -maxdepth 1 -type f -name '[0-9]*_*.sql' -printf '%f\n')"
[ -n "$migration_files" ] || { echo 'STOP: current migration definitions unavailable' >&2; exit 1; }
current_migrations="$(while IFS= read -r file; do
  [[ "$file" =~ ^[0-9]+_[A-Za-z0-9_-]+\.sql$ ]] || exit 1
  printf '%s %s\n' "$(sha256sum "$OLD/packages/database/migrations/$file" | cut -d' ' -f1)" "$file"
done <<< "$migration_files" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
if [ "$current_migrations" != "$MIGRATIONS_DIGEST" ] && [ "$ALLOW_FORWARD_ONLY" != 1 ]; then
  echo 'STOP: migration definitions changed. Review the exact release and forward-repair plan before explicitly allowing a forward-only migration.' >&2
  exit 1
fi

quiescent() {
  sudo -u mintbot /usr/bin/python3 - <<'PY'
import sqlite3, sys
c = sqlite3.connect('file:/var/lib/mint-bot/db/mintbot.sqlite?mode=ro', uri=True)
c.execute('PRAGMA query_only=ON')
counts = [
    c.execute("SELECT count(*) FROM execution_run WHERE state IN ('prepared','active','recovering')").fetchone()[0],
    c.execute("SELECT count(*) FROM spend_reservation WHERE status='reserved'").fetchone()[0],
    c.execute("SELECT count(*) FROM transaction_attempt a WHERE NOT EXISTS (SELECT 1 FROM transaction_receipt r WHERE r.transaction_attempt_id=a.id AND r.status IN ('confirmed','reverted'))").fetchone()[0],
    c.execute("SELECT count(*) FROM live_run_request r LEFT JOIN live_run_request_outcome o ON r.id=o.request_id WHERE o.request_id IS NULL AND julianday(r.expires_at)>julianday('now')").fetchone()[0],
]
tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
if 'native_funding' in tables:
    counts.append(c.execute("SELECT count(*) FROM native_funding WHERE state NOT IN ('settled','released')").fetchone()[0])
if 'mint_funding_hold' in tables:
    counts.append(c.execute("SELECT count(*) FROM mint_funding_hold WHERE state='reserved'").fetchone()[0])
c.close()
if any(counts):
    print('STOP: unresolved execution/exposure/request; preserve records and reconcile before cutover.', file=sys.stderr)
    sys.exit(1)
PY
}

wait_healthy() {
  for attempt in $(seq 1 30); do
    if systemctl is-active --quiet mint-bot.service && curl --max-time 5 --fail --silent --show-error http://127.0.0.1:8780/healthz >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

recover() {
  echo 'Cutover failed; attempting compatible code-only recovery with kill engaged.' >&2
  if ! sudo systemctl stop mint-bot.service; then
    echo 'FORWARD_REPAIR_REQUIRED: unable to stop service; kill remains engaged.' >&2
    return 1
  fi
  if [ "$(readlink -f /opt/mint-bot/current)" != "$OLD" ]; then
    if ! sudo bash "$INSTALLER" --rollback-to "$OLD"; then
      echo 'FORWARD_REPAIR_REQUIRED: service stopped, kill engaged, canonical database preserved.' >&2
      return 1
    fi
  fi
  if [ "$(readlink -f /opt/mint-bot/current)" != "$OLD" ]; then
    echo 'FORWARD_REPAIR_REQUIRED: captured previous release was not selected; service remains stopped.' >&2
    return 1
  fi
  if ! sudo systemctl reset-failed mint-bot.service || ! sudo systemctl start mint-bot.service; then
    sudo systemctl stop mint-bot.service || true
    echo 'FORWARD_REPAIR_REQUIRED: previous service could not start; kill remains engaged.' >&2
    return 1
  fi
  if ! wait_healthy; then
    sudo systemctl stop mint-bot.service || true
    echo 'FORWARD_REPAIR_REQUIRED: previous service failed health; kill remains engaged.' >&2
    return 1
  fi
  echo 'RECOVERED_PREVIOUS_RELEASE_KILL_SWITCH_ENGAGED'
}

sudo -u mintbot touch /var/lib/mint-bot/killswitch
quiescent
sudo systemctl stop mint-bot.service
quiescent
if ! sudo bash "$INSTALLER" "$ARCHIVE" "$DIGEST"; then recover || true; exit 1; fi
if ! sudo systemctl reset-failed mint-bot.service || ! sudo systemctl start mint-bot.service; then recover || true; exit 1; fi
if wait_healthy; then echo 'DEPLOYMENT_HEALTHY_KILL_SWITCH_ENGAGED'; exit 0; fi
recover || true
exit 1
