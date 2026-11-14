#!/usr/bin/env bash
# Build, transfer and safely install one immutable MintBot release on the GCP
# host. The kill switch remains engaged after deployment; the owner reviews
# readiness and releases it separately.
#
#   bash ops/host/deploy-release.sh \
#     --project my-project --zone us-east4-b --instance palmora-bot-prod
#
# Optional: --commit <git ref> (default: origin/main). Changed migration
# definitions require an explicitly reviewed --allow-forward-only-migration.
# Incompatible rollback preserves the DB and stops for forward repair.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROJECT="" ZONE="" INSTANCE="" COMMIT_REF="origin/main" ALLOW_FORWARD_ONLY=0

stop() { echo "STOP: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --zone) ZONE="${2:-}"; shift 2 ;;
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --commit) COMMIT_REF="${2:-}"; shift 2 ;;
    --allow-forward-only-migration) ALLOW_FORWARD_ONLY=1; shift ;;
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

CUTOVER="$WORK/cutover-release.sh"
git -C "$REPO" show "$COMMIT:ops/host/cutover-release.sh" > "$CUTOVER"
CUTOVER_DIGEST="$(sha256sum "$CUTOVER" | cut -d' ' -f1)"
REMOTE_CUTOVER="/tmp/mintbot-cutover-release-$SHORT.sh"
MIGRATION_LINES="$WORK/migrations.txt"
: > "$MIGRATION_LINES"
while IFS= read -r path; do
  file="${path##*/}"
  [[ "$file" =~ ^[0-9]+_[A-Za-z0-9_-]+\.sql$ ]] || stop "unsupported migration filename"
  file_digest="$(git -C "$REPO" show "$COMMIT:$path" | sha256sum | cut -d' ' -f1)"
  printf '%s %s\n' "$file_digest" "$file" >> "$MIGRATION_LINES"
done < <(git -C "$REPO" ls-tree -r --name-only "$COMMIT" -- packages/database/migrations)
[ -s "$MIGRATION_LINES" ] || stop "release has no migrations"
MIGRATIONS_DIGEST="$(LC_ALL=C sort "$MIGRATION_LINES" | sha256sum | cut -d' ' -f1)"

GCLOUD_SCOPE=(--project "$PROJECT" --zone "$ZONE" --tunnel-through-iap)
echo "Uploading the verified release through IAP"
gcloud compute scp "${GCLOUD_SCOPE[@]}" "$ARTIFACT" "$INSTANCE:$REMOTE_FILE"
gcloud compute scp "${GCLOUD_SCOPE[@]}" "$INSTALLER" "$INSTANCE:$REMOTE_INSTALLER"
gcloud compute scp "${GCLOUD_SCOPE[@]}" "$CUTOVER" "$INSTANCE:$REMOTE_CUTOVER"

REMOTE_INSTALL="set -euo pipefail
printf '%s  %s\n' '$CUTOVER_DIGEST' '$REMOTE_CUTOVER' | sha256sum --check --status
bash '$REMOTE_CUTOVER' '$REMOTE_FILE' '$DIGEST' '$REMOTE_INSTALLER' '$INSTALLER_DIGEST' '$MIGRATIONS_DIGEST' '$ALLOW_FORWARD_ONLY'"

echo "Installing, starting and checking the service"
gcloud compute ssh "${GCLOUD_SCOPE[@]}" "$INSTANCE" --command "$REMOTE_INSTALL"
echo "Installed $COMMIT. The kill switch is still engaged; review status and evidence before releasing it."
