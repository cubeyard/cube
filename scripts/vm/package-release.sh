#!/usr/bin/env bash
# Package the built disks into a per-arch release set: compressed qcow2
# artifacts, the app tarball, a flat manifest binding each sha256, and
# SHA256SUMS.
#
#   bash scripts/vm/package-release.sh vX.Y.Z <build-id> [commit]
#
# Reads $OS_DISK/$APP_DISK/$APP_TAR/$NODE_DISK from lib.sh and writes
# $BUILD_DIR/dist. Split out of release.sh so the GitHub workflow and a
# local release produce byte-identical layouts from the same code.
#
# Manifest schema 2 (flat: the launcher parses it with sed, not jq):
#   schema, version, tag, build_id, commit, arch
#   runtime_id      the node+pnpm the app disk provides / the tarball needs
#   images_tree     git tree hash of images/ — cube-node's only input
#   base_*, app_*, app_tar_*, node_*   file / sha256 / bytes per artifact
#   node_inherited_from   the release whose cube-node bytes these are
#                         (inherit-cube-node.sh), or empty when built here
. "$(dirname "$0")/lib.sh"

VERSION="${1:?usage: package-release.sh vX.Y.Z <build-id> [commit]}"
BUILD_ID="${2:?missing build-id}"
COMMIT="${3:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
ARCH="$GUEST_ARCH"
DIST="$BUILD_DIR/dist"

# A running VM holds the disks read-write, and qemu-img then reads a
# torn image (or fails outright) — package a half-written artifact and
# the checksums would certify garbage.
if [ -n "$(vm_pids)" ]; then
  fail "a VM is running on these disks — stop it first (scripts/vm/down.sh)"
  exit 1
fi
for d in "$OS_DISK" "$APP_DISK" "$APP_TAR" "$NODE_DISK"; do
  [ -f "$d" ] || { fail "missing artifact: $d"; exit 1; }
done
RUNTIME_ID="$(cat "$BUILD_DIR/runtime-id" 2>/dev/null || true)"
[ -n "$RUNTIME_ID" ] || { fail "no $BUILD_DIR/runtime-id — build-app.sh writes it"; exit 1; }
IMAGES_TREE="$(git -C "$REPO_ROOT" rev-parse "$COMMIT:images" 2>/dev/null || true)"
[ -n "$IMAGES_TREE" ] || { fail "cannot resolve the images/ tree of $COMMIT in $REPO_ROOT"; exit 1; }

BASE_ART="cube-base-$VERSION-$ARCH.qcow2"
APP_ART="cube-app-$VERSION-$ARCH.qcow2"
APP_TAR_ART="cube-app-$VERSION-$ARCH.tar.zst"
NODE_ART="cube-node-$VERSION-$ARCH.qcow2"

log "package -> $DIST"
mkdir -p "$DIST"
rm -f "$DIST/$BASE_ART" "$DIST/$APP_ART" "$DIST/$APP_TAR_ART" "$DIST/$NODE_ART" \
      "$DIST/SHA256SUMS.$ARCH" "$DIST/manifest-$ARCH.json"
qemu-img convert -O qcow2 -c -o compression_type=zstd "$OS_DISK"  "$DIST/$BASE_ART"
qemu-img convert -O qcow2 -c -o compression_type=zstd "$APP_DISK" "$DIST/$APP_ART"
cp "$APP_TAR" "$DIST/$APP_TAR_ART"

# cube-node: inherited bytes are shipped AS-IS (re-compressing would
# change the sha and defeat the launcher's "already have" check); a
# disk built here is compressed like the others.
NODE_INHERITED=""
if [ -f "$BUILD_DIR/node-inherited-from" ] \
   && [ "$(sha256 "$NODE_DISK" | cut -d' ' -f1)" = "$(sed -n '2p' "$BUILD_DIR/node-inherited-from")" ]; then
  NODE_INHERITED="$(sed -n '1p' "$BUILD_DIR/node-inherited-from")"
  cp "$NODE_DISK" "$DIST/$NODE_ART"
  echo "cube-node: inherited from $NODE_INHERITED (images/ tree $IMAGES_TREE unchanged)"
else
  qemu-img convert -O qcow2 -c -o compression_type=zstd "$NODE_DISK" "$DIST/$NODE_ART"
fi

BASE_SHA="$(sha256 "$DIST/$BASE_ART" | cut -d' ' -f1)"
APP_SHA="$(sha256 "$DIST/$APP_ART" | cut -d' ' -f1)"
APP_TAR_SHA="$(sha256 "$DIST/$APP_TAR_ART" | cut -d' ' -f1)"
NODE_SHA="$(sha256 "$DIST/$NODE_ART" | cut -d' ' -f1)"
cat > "$DIST/manifest-$ARCH.json" <<MANIFEST
{
  "schema": "2",
  "version": "$VERSION",
  "tag": "$VERSION",
  "build_id": "$BUILD_ID",
  "commit": "$COMMIT",
  "arch": "$ARCH",
  "runtime_id": "$RUNTIME_ID",
  "images_tree": "$IMAGES_TREE",
  "base_file": "$BASE_ART",
  "base_sha256": "$BASE_SHA",
  "base_bytes": $(file_size "$DIST/$BASE_ART"),
  "app_file": "$APP_ART",
  "app_sha256": "$APP_SHA",
  "app_bytes": $(file_size "$DIST/$APP_ART"),
  "app_tar_file": "$APP_TAR_ART",
  "app_tar_sha256": "$APP_TAR_SHA",
  "app_tar_bytes": $(file_size "$DIST/$APP_TAR_ART"),
  "node_file": "$NODE_ART",
  "node_sha256": "$NODE_SHA",
  "node_bytes": $(file_size "$DIST/$NODE_ART"),
  "node_inherited_from": "$NODE_INHERITED"
}
MANIFEST
(cd "$DIST" && sha256 "$BASE_ART" "$APP_ART" "$APP_TAR_ART" "$NODE_ART" "manifest-$ARCH.json" > "SHA256SUMS.$ARCH")
ok "packaged $ARCH: $(du -sh "$DIST" | cut -f1) in $DIST"
for f in "$BASE_ART" "$APP_ART" "$APP_TAR_ART" "$NODE_ART"; do
  printf '  %6.0f MB  %s\n' "$(( $(file_size "$DIST/$f") / 1000000 ))" "$f"
done
