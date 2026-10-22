#!/usr/bin/env bash
# MintBot release builder (T-047). Run on the owner's PC (needs git and docker). It does not touch the server.
#
#   bash build-release.sh              build the newest main on GitHub
#   bash build-release.sh <commit>     build a specific commit
#   MINT_BOT_OFFLINE_STORE=$(pnpm store path) bash build-release.sh    build without the internet, from the local package store
#
# It builds the committed files only (git archive: nothing untracked, no local secrets) inside a clean container that uses the
# same Node version as the server (20.19.1), with the repository's own Dockerfile build stage: install from the lockfile,
# compile, then keep production dependencies only. The result is ~/mintbot-release-<commit>.tar.gz plus its SHA-256.
# Upload it to the server and install it with install-release.sh.
#
# Native programs (the compiled database library) are not covered by the lockfile's hashes, so every native file in the release
# must match a pinned SHA-256 in native-binaries.sha256 (next to this script). A dependency update that changes one fails the
# build until the new hash has been reviewed and pinned.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${MINT_BOT_REPO:-$HOME/W3/MintBot}"
NATIVE_PINS="$HERE/native-binaries.sha256"
# The pnpm 9.15.4 program used by the no-internet build. This SHA-256 matched the npm registry's published package when pinned.
PNPM_CJS_SHA256="4c319da726786d5535aef95fa78ec5e24f1079382da878a35fa5dd044a7bab96"

command -v docker >/dev/null || { echo "STOP: docker is not available on this machine." >&2; exit 1; }
[ -f "$NATIVE_PINS" ] || { echo "STOP: $NATIVE_PINS is missing." >&2; exit 1; }
git -C "$REPO" fetch -q origin
# Resolve to the commit itself (an annotated tag names a tag object, not the commit).
COMMIT="$(git -C "$REPO" rev-parse --verify "${1:-origin/main}^{commit}")"
SHORT="${COMMIT:0:7}"
OUT="${MINT_BOT_RELEASE_OUT:-$HOME}/mintbot-release-$SHORT.tar.gz"
echo "Building release $COMMIT"
git -C "$REPO" log --oneline -1 "$COMMIT"

WORK="$(mktemp -d)"
CID=""
cleanup() { [ -z "$CID" ] || docker rm -f "$CID" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/src" "$WORK/out/release"
git -C "$REPO" archive "$COMMIT" | tar -x -C "$WORK/src"

# Names that look like a secret. Refuse them in what goes into the image, and in the result (outside installed dependencies).
secret_names() { # folder-or-file ... : prints up to five matches
  find "$@" \( -iname '*.env' -o -iname '.env*' -o -iname '.npmrc' -o -iname '*.key' -o -iname '*.pem' -o -iname '*.p12' -o -iname '*keystore*.json' -o -iname '*wallet*.json' \) -not -path '*/node_modules/*' -print 2>/dev/null | head -5 || true
}
for path in "$WORK/src/packages" "$WORK/src/scripts" "$WORK/src/package.json" "$WORK/src/pnpm-lock.yaml"; do
  [ -e "$path" ] || { echo "STOP: the source is missing $path" >&2; exit 1; }
done
SUSPECT="$(secret_names "$WORK/src")"
[ -z "$SUSPECT" ] || { echo "STOP: the source has a file that looks like a secret:"; echo "$SUSPECT"; exit 1; }

if [ -n "${MINT_BOT_OFFLINE_STORE:-}" ]; then
  # No-internet build: the same steps as the Dockerfile build stage, inside the same Node version, with no network at all, using
  # the package store (mounted read-only) and the pnpm program already on this machine. pnpm still checks every package against
  # the lockfile's hashes. Use this when the connection to the package registry is unreliable. The release records this method.
  STORE="$MINT_BOT_OFFLINE_STORE"
  # `pnpm store path` prints <store>/v3; pnpm itself wants the folder above it.
  [ "$(basename "$STORE")" != v3 ] || STORE="$(dirname "$STORE")"
  COREPACK_SOURCE="${MINT_BOT_COREPACK_HOME:-$HOME/.cache/node/corepack}"
  [ -d "$STORE" ] || { echo "STOP: the package store $STORE does not exist." >&2; exit 1; }
  [ -d "$COREPACK_SOURCE/v1/pnpm/9.15.4" ] || { echo "STOP: pnpm 9.15.4 is not cached in $COREPACK_SOURCE." >&2; exit 1; }
  [ "$(sha256sum "$COREPACK_SOURCE/v1/pnpm/9.15.4/dist/pnpm.cjs" | cut -d' ' -f1)" = "$PNPM_CJS_SHA256" ] || { echo "STOP: the cached pnpm program does not match the pinned SHA-256." >&2; exit 1; }
  cp -a "$COREPACK_SOURCE" "$WORK/corepack"
  docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_HOME=/corepack -e COREPACK_ENABLE_AUTO_PIN=0 -e COREPACK_ENABLE_NETWORK=0 -e CI=1 \
    -v "$WORK/src:/app" -v "$WORK/corepack:/corepack" -v "$STORE:/pnpm/store:ro" -w /app node:20.19.1-bookworm-slim sh -c '
      set -e
      mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:$PATH
      pnpm config set store-dir /pnpm/store
      pnpm install --offline --frozen-lockfile
      pnpm build
      pnpm prune --prod
      pnpm install --offline --prod --frozen-lockfile'
  for item in package.json pnpm-workspace.yaml node_modules packages scripts; do cp -a "$WORK/src/$item" "$WORK/out/release/$item"; done
  BUILD_NOTE="built-offline-from-local-store"
else
  IMAGE="mintbot-release-build:$SHORT"
  docker build --target build -t "$IMAGE" "$WORK/src"
  CID="$(docker create "$IMAGE")"
  docker cp "$CID:/app/." "$WORK/out/release/"
  BUILD_NOTE="built-in-container-from-registry"
fi

# The Dockerfile build stage compiles and keeps production dependencies; prove the result is complete before packing it.
for required in packages/cli/dist/orchestrator-service.js packages/cli/dist/index.js scripts/backup-service.mjs scripts/backup-job.mjs scripts/r2-upload.mjs node_modules package.json; do
  [ -e "$WORK/out/release/$required" ] || { echo "STOP: the build is missing $required" >&2; exit 1; }
done
SUSPECT="$(secret_names "$WORK/out/release")"
[ -z "$SUSPECT" ] || { echo "STOP: the built release has a file that looks like a secret: $SUSPECT" >&2; exit 1; }

# Every native file must match a pinned hash, and every pinned file must be present.
FOUND="$WORK/native-found.txt"
: > "$FOUND"
while IFS= read -r -d '' native; do
  printf '%s  %s\n' "$(sha256sum "$native" | cut -d' ' -f1)" "$(basename "$native")" >> "$FOUND"
done < <(find "$WORK/out/release" -type f -name '*.node' -print0)
sort -u "$FOUND" > "$WORK/native-found.sorted"
grep -Ev '^[[:space:]]*(#|$)' "$NATIVE_PINS" | sort -u > "$WORK/native-pinned.sorted"
if ! cmp -s "$WORK/native-found.sorted" "$WORK/native-pinned.sorted"; then
  echo "STOP: the native files in this release do not match $NATIVE_PINS." >&2
  echo "Found in the release:" >&2; sed 's/^/  /' "$WORK/native-found.sorted" >&2
  echo "Pinned:" >&2; sed 's/^/  /' "$WORK/native-pinned.sorted" >&2
  echo "If a dependency update changed one on purpose, review it, then update the pin file in the same change." >&2
  exit 1
fi
echo "Native files match the pinned hashes: $(wc -l < "$WORK/native-found.sorted") file(s)"

printf 'commit=%s\nbuilt_at=%s\nnode=20.19.1\nbuilder=build-release.sh\nmethod=%s\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BUILD_NOTE" > "$WORK/out/release/RELEASE"
# Hard links are written as ordinary files, so the installer can refuse every hard link.
tar --sort=name --owner=0 --group=0 --numeric-owner --hard-dereference -czf "$OUT" -C "$WORK/out" release
echo
echo "Release built: $OUT ($(du -h "$OUT" | cut -f1))"
echo "SHA-256: $(sha256sum "$OUT" | cut -d' ' -f1)"
echo
echo "Next: upload it to the server (gear icon, Upload file), check the SHA-256 there, then run:"
echo "  sudo bash ~/mintbot-ops/ops/host/install-release.sh ~/mintbot-release-$SHORT.tar.gz <the SHA-256 above>"
