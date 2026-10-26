#!/usr/bin/env bash
# Build, transfer and safely install one immutable MintBot release on the GCP
# host. The kill switch remains engaged after deployment; the owner reviews
# readiness and releases it separately.
#
#   bash ops/host/deploy-release.sh \
#     --project my-project --zone us-east4-b --instance palmora-bot-prod
#
# Optional: --commit <git ref> (default: origin/main)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROJECT="" ZONE="" INSTANCE="" COMMIT_REF="origin/main"

stop() { echo "STOP: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --zone) ZONE="${2:-}"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --commit) COMMIT_REF="${2:-}"; shift 2 ;;
    *) stop "unknown argument: $1" ;;
  esac
done

for pair in "project:$PROJECT" "zone:$ZONE" "instance:$INSTANCE"; do
  label="${pair%%:*}"; value="${pair#*:}"
  [ -n "$value" ] || stop "--$label is required"
  [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]] || stop "--$label contains unsupported characters"
done
command -v gcloud >/dev/null || stop "gcloud is not installed"

git -C "$REPO" fetch -q origin
COMMIT="$(git -C "$REPO" rev-parse --verify "$COMMIT_REF^{commit}")"
SHORT="${COMMIT:0:7}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Building immutable release $COMMIT"
MINT_BOT_REPO="$REPO" MINT_BOT_RELEASE_OUT="$WORK" bash "$HERE/build-release.sh" "$COMMIT"
ARTIFACT="$WORK/mintbot-release-$SHORT.tar.gz"
[ -f "$ARTIFACT" ] || stop "release builder did not produce $ARTIFACT"
DIGEST="$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
REMOTE_FILE="/tmp/mintbot-release-$SHORT.tar.gz"
# Run the installer reviewed in the same immutable commit as the release. A
# dirty or newer local checkout must never become root-executed deployment
# input for an older --commit.
INSTALLER="$WORK/install-release.sh"
git -C "$REPO" show "$COMMIT:ops/host/install-release.sh" > "$INSTALLER"
chmod 0700 "$INSTALLER"
INSTALLER_DIGEST="$(sha256sum "$INSTALLER" | cut -d' ' -f1)"
REMOTE_INSTALLER="/tmp/mintbot-install-release-$SHORT.sh"

GCLOUD_SCOPE=(--project "$PROJECT" --zone "$ZONE" --tunnel-through-iap)
echo "Uploading the verified release through IAP"
gcloud compute scp "${GCLOUD_SCOPE[@]}" "$ARTIFACT" "$INSTANCE:$REMOTE_FILE"
gcloud compute scp "${GCLOUD_SCOPE[@]}" "$INSTALLER" "$INSTANCE:$REMOTE_INSTALLER"

REMOTE_INSTALL="set -euo pipefail
sudo -u mintbot touch /var/lib/mint-bot/killswitch
echo '$INSTALLER_DIGEST  $REMOTE_INSTALLER' | sha256sum --check --status
sudo systemctl stop mint-bot.service
sudo bash '$REMOTE_INSTALLER' '$REMOTE_FILE' '$DIGEST'
sudo systemctl reset-failed mint-bot.service
sudo systemctl start mint-bot.service
for attempt in \$(seq 1 30); do
  if systemctl is-active --quiet mint-bot.service && curl --fail --silent --show-error http://127.0.0.1:8780/healthz >/dev/null; then
    echo 'DEPLOYMENT_HEALTHY_KILL_SWITCH_ENGAGED'
    exit 0
  fi
  sleep 2
done
echo 'New release failed its local health check; rolling back with the kill switch engaged.' >&2
sudo systemctl stop mint-bot.service
sudo bash '$REMOTE_INSTALLER' --rollback
sudo systemctl reset-failed mint-bot.service
sudo systemctl start mint-bot.service
exit 1"

echo "Installing, starting and checking the service"
gcloud compute ssh "${GCLOUD_SCOPE[@]}" "$INSTANCE" --command "$REMOTE_INSTALL"
echo "Installed $COMMIT. The kill switch is still engaged; review status and evidence before releasing it."
