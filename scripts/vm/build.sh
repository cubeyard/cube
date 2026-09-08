#!/usr/bin/env bash
# Build the cube BASE image — `nix build` of scripts/vm/base, nothing
# else. This replaced the Ubuntu bake: no cloud-image download, no
# provision boot, no shrink dance; the image is a pure function of
# base/configuration.nix. (~1 min warm, ~10 min cold nix store.)
#
#   bash scripts/vm/build.sh
#
# Building a NixOS image needs a LINUX nix builder. On macOS, either
# configure a linux remote builder for nix, or skip building entirely:
# point CUBE_BASE_IMAGE at a base qcow2 fetched from a release and this
# script installs that instead.
#
# The data disk is NEVER touched here — a new base is an OS swap, and
# surviving it is the data disk's whole job.
. "$(dirname "$0")/lib.sh"

if [ -n "$(vm_pids)" ]; then
  fail "a VM is running on this build's disks — stop it first (scripts/vm/down.sh)"
  exit 1
fi

if [ -n "${CUBE_BASE_IMAGE:-}" ]; then
  log "installing prebuilt base: $CUBE_BASE_IMAGE"
  [ -f "$CUBE_BASE_IMAGE" ] || { fail "no such file: $CUBE_BASE_IMAGE"; exit 1; }
  cp "$CUBE_BASE_IMAGE" "$OS_DISK.tmp"
else
  command -v nix >/dev/null 2>&1 \
    || { fail "nix is required to build the base (or set CUBE_BASE_IMAGE) — https://nixos.org/download"; exit 1; }
  log "nix build (base image, $NIX_SYSTEM)"
  # --no-update-lock-file: the pin in flake.lock IS the build; a build
  # must fail rather than silently rewrite it.
  nix build "path:$REPO_ROOT/scripts/vm/base#image" --no-update-lock-file \
    --out-link "$BUILD_DIR/.base-result"
  IMG="$(ls "$BUILD_DIR/.base-result"/*.qcow2 | head -n1)"
  [ -f "$IMG" ] || { fail "nix build produced no qcow2 under $BUILD_DIR/.base-result"; exit 1; }
  cp "$IMG" "$OS_DISK.tmp"
fi
chmod u+w "$OS_DISK.tmp"      # store copies arrive read-only
mv "$OS_DISK.tmp" "$OS_DISK"

# New OS -> new world for the OS layer ONLY: fresh overlay (a stale
# overlay on a new base is corruption), fresh TOFU. Data disk untouched.
rm -f "$LIVE_DISK" "$KNOWN_HOSTS"

ok "base image: $OS_DISK ($(qemu-img info --output=json "$OS_DISK" | grep -o '"actual-size": [0-9]*' | head -1 | awk '{printf "%.1fG", $2/1e9}') used)"
echo "next: bash scripts/vm/build-app.sh   then: bash scripts/vm/up.sh"
