#!/usr/bin/env bash
# Release pipeline for ONE MACHINE — versioned, checksummed, published
# artifact SET from a git tag: base (NixOS image), app (cubed disk + app
# tarball), cube-node (inner image disk), one flat manifest + SHA256SUMS
# per arch.
#
# The GitHub workflow (.github/workflows/release.yml) is the primary
# path — a push to main releases the next patch on its own, a hand-made
# tag `vm-vX.Y.Z` releases that version — and it
# coordinates the two architectures properly; this script is the local
# escape hatch and shares its build/package/verify steps (build*.sh,
# inherit-cube-node.sh, package-release.sh, verify-release.sh) so the
# two cannot drift in what they produce.
#
#   bash scripts/vm/release.sh v0.4.0                # tag vm-v0.4.0 (created
#                                                    # at HEAD if missing),
#                                                    # build, test, package,
#                                                    # publish to GH Releases
#   bash scripts/vm/release.sh v0.4.0 --no-publish   # stop after packaging
#
# Everything runs in an ISOLATED build dir ($VM_DIR/release/<version>) on
# its own ports, so the dev-loop VM keeps running untouched. The source is
# a CLEAN worktree of the tag, never the working tree. Boot-verify drives
# the LAUNCHER (the tag's launcher/cube) against the packaged dist dir —
# the exact install path a user runs, including the content-addressed
# store, the blank-data-disk first boot and an in-place app update.
#
# Published assets (tag vm-<version>; per-arch names so release legs
# cannot overwrite each other):
#   cube-base-<version>-<arch>.qcow2    NixOS OS image (zstd qcow2)
#   cube-app-<version>-<arch>.qcow2     cubed + node, ext4 LABEL=cubed
#   cube-app-<version>-<arch>.tar.zst   the app tree alone (in-place upgrades)
#   cube-node-<version>-<arch>.qcow2    inner image, ext4 LABEL=cube-node
#   manifest-<arch>.json                flat metadata + per-artifact sha256
#   SHA256SUMS.<arch>                   checksums; uploaded LAST = leg done
#   cube                                the launcher (first leg only)
# One release holds every arch: the FIRST publishing leg creates tag +
# release, later legs upload their arch into it.

usage() { echo "usage: bash scripts/vm/release.sh vX.Y.Z [--no-publish]" >&2; exit 1; }

# Strict semver only: the version lands in git refs, file paths, JSON,
# and process patterns. Any unrecognized flag must FAIL.
VERSION="${1:-}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
shift
PUBLISH=1
for arg in "$@"; do
  case "$arg" in --no-publish) PUBLISH=0 ;; *) usage ;; esac
done

# Isolation env BEFORE lib.sh resolves paths/ports. Loopback-only: a
# release test boot has no business on the tailnet.
export CUBE_VM_BUILD_DIR="${CUBE_VM_DIR:-$HOME/cube/vm}/release/$VERSION"
export CUBE_VM_SSH_PORT="${CUBE_VM_SSH_PORT:-2422}"
export CUBE_VM_CUBED_PORT="${CUBE_VM_CUBED_PORT:-7977}"
export CUBE_VM_BIND=""
. "$(dirname "$0")/lib.sh"

TAG="vm-$VERSION"
ARCH="$GUEST_ARCH"
BASE_ART="cube-base-$VERSION-$ARCH.qcow2"
APP_ART="cube-app-$VERSION-$ARCH.qcow2"
APP_TAR_ART="cube-app-$VERSION-$ARCH.tar.zst"
NODE_ART="cube-node-$VERSION-$ARCH.qcow2"
DIST="$BUILD_DIR/dist"

command -v gh > /dev/null || { fail "gh CLI required"; exit 1; }
# build.sh honors CUBE_BASE_IMAGE (the documented macOS escape hatch) —
# inheriting it here would publish a stale base under a manifest that
# claims this tag's commit (sol #6). A release builds its own base.
[ -z "${CUBE_BASE_IMAGE:-}" ] \
  || { fail "CUBE_BASE_IMAGE is set — a release must build its base from the tag; unset it"; exit 1; }
# gh resolves its repo from the CALLER's cwd — anchor every call to this
# repo's origin.
GH_REPO="$(git -C "$REPO_ROOT" remote get-url origin)"

# One release per version at a time: concurrent runs share disks, ports,
# and dist files.
vm_lock 7 "$BUILD_DIR/.release-lock" nonblock \
  || { fail "another release of $VERSION holds $BUILD_DIR/.release-lock"; exit 1; }

# Per-arch publish coordination. SHA256SUMS.<arch> is uploaded LAST and
# is the leg's completion marker: a COMPLETE arch is immutable (bump the
# version), a partial one (crashed upload) is healed by re-running.
RELEASE_EXISTS=0
if [ "$PUBLISH" = 1 ]; then
  if ASSETS="$(gh release view "$TAG" -R "$GH_REPO" --json assets -q '.assets[].name' 2>/dev/null)"; then
    RELEASE_EXISTS=1
    if printf '%s\n' "$ASSETS" | grep -qx "SHA256SUMS.$ARCH"; then
      fail "release $TAG already carries a complete $ARCH leg — bump the version"; exit 1
    fi
    echo "release $TAG exists without a complete $ARCH leg — this leg will upload into it"
  fi
fi

log "tag $TAG"
# The tag is the multi-leg coordination point: every leg must build the
# SAME source. A publishing leg syncs with origin first; a later leg
# REQUIRES the pushed tag.
TAG_IS_NEW=0
if [ "$PUBLISH" = 1 ]; then
  REMOTE_SHA="$(git -C "$REPO_ROOT" ls-remote origin "refs/tags/$TAG" | awk 'NR==1{print $1}')"
  if [ -n "$REMOTE_SHA" ]; then
    if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
      [ "$(git -C "$REPO_ROOT" rev-parse "refs/tags/$TAG")" = "$REMOTE_SHA" ] \
        || { fail "local tag $TAG diverges from origin — resolve before publishing"; exit 1; }
    else
      git -C "$REPO_ROOT" fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
    fi
  elif [ "$RELEASE_EXISTS" = 1 ]; then
    fail "release $TAG exists but its tag is not on origin — cannot pin the source"; exit 1
  fi
fi
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
  echo "tag exists: $(git -C "$REPO_ROOT" rev-parse --short "$TAG^{commit}")"
else
  git -C "$REPO_ROOT" tag -a "$TAG" -m "cube release $VERSION"
  TAG_IS_NEW=1
  echo "tagged HEAD: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi
# A publishing first leg pushes the tag NOW, before the long build: a
# push race loses loudly here, minutes in — not at publish time. NOTE:
# pushing the tag also triggers .github/workflows/release.yml; a local
# publish and the workflow would then race the same draft. Use one or
# the other for a given version.
if [ "$PUBLISH" = 1 ] && [ "$TAG_IS_NEW" = 1 ]; then
  git -C "$REPO_ROOT" push origin "refs/tags/$TAG"
fi
COMMIT="$(git -C "$REPO_ROOT" rev-parse "$TAG^{commit}")"
BUILD_ID="cube-$VERSION-g$(git -C "$REPO_ROOT" rev-parse --short "$TAG^{commit}")"

log "clean source worktree at $TAG"
SRC="$(mktemp -d /tmp/cube-release-XXXXXX)"
cleanup() {
  bash "$SRC/scripts/vm/down.sh" > /dev/null 2>&1 || true
  git -C "$REPO_ROOT" worktree remove --force "$SRC" 2>/dev/null || true
  rm -rf "$SRC"
  # flock self-releases on exit; shlock (macOS) leaves the pid file, and
  # pid reuse would read as "locked" to a later run.
  vm_unlock 7 "$BUILD_DIR/.release-lock"
}
trap cleanup EXIT
git -C "$REPO_ROOT" worktree add -q --detach "$SRC" "$TAG"
# The build runs the TAG's scripts; a tag from before the app tarball
# has no inherit-cube-node.sh and would package the old world. Refuse.
[ -f "$SRC/scripts/vm/inherit-cube-node.sh" ] \
  || { fail "tag $TAG predates the in-place-upgrade model (no scripts/vm/inherit-cube-node.sh)"; exit 1; }

log "build base + app from tag (isolated: $BUILD_DIR, ports $SSH_PORT/$CUBED_PORT)"
bash "$SRC/scripts/vm/build.sh"
CUBE_VM_BUILD_ID="$BUILD_ID" bash "$SRC/scripts/vm/build-app.sh" "$SRC"
[ "$(cat "$BUILD_DIR/build-id" 2>/dev/null)" = "$BUILD_ID" ] \
  || { fail "tag's build contract diverges (build-id != $BUILD_ID)"; exit 1; }

log "cube-node: inherit a published build, else build inside the VM"
rm -f "$BUILD_DIR/node-inherited-from"
if bash "$SRC/scripts/vm/inherit-cube-node.sh" "$TAG"; then
  bash "$SRC/scripts/vm/up.sh"
else
  bash "$SRC/scripts/vm/up.sh"
  bash "$SRC/scripts/vm/build-cube-node.sh"
fi

log "acceptance: full portfolio"
bash "$SRC/scripts/vm/test.sh"
bash "$SRC/scripts/vm/down.sh"

bash "$SRC/scripts/vm/package-release.sh" "$VERSION" "$BUILD_ID" "$COMMIT"

CUBE_VERIFY_SSH_PORT=2522 CUBE_VERIFY_PORT=7877 \
  bash "$SRC/scripts/vm/verify-release.sh" "$VERSION" "$DIST"

if [ "$PUBLISH" = 0 ]; then
  ok "--no-publish: stopping after packaging ($DIST)"
  exit 0
fi

log "publish $TAG ($ARCH leg)"
# First leg creates the release as a DRAFT (the launcher's "latest"
# excludes drafts), then uploads artifacts -> manifest -> checksums: the
# sums file lands last, so its presence marks a complete leg and
# --clobber lets a re-run heal a partial one.
if [ "$RELEASE_EXISTS" = 0 ]; then
  gh release create "$TAG" -R "$GH_REPO" --verify-tag --draft \
    --title "cube $VERSION" \
    --notes "$(printf 'Built from %s.\n\nPer-arch artifact sets (base / app / app tarball / cube-node), plus the `cube` launcher itself; more arch legs may upload after the first.\n\nInstall:\n\n    gh release download -R %s -p cube -D ~/.local/bin --clobber\n    chmod +x ~/.local/bin/cube && cube up\n\nA blank data disk initializes itself on first boot.\nVerify: sha256sum -c SHA256SUMS.<arch>\n' "$COMMIT" "$GH_REPO")"
  # Arch-independent, so only the first leg ships it — two concurrent
  # legs would otherwise race the same asset name. It comes from the
  # tag's worktree, which pins it to the artifacts it can read.
  gh release upload "$TAG" -R "$GH_REPO" --clobber "$SRC/launcher/cube"
fi
gh release upload "$TAG" -R "$GH_REPO" --clobber \
  "$DIST/$BASE_ART" "$DIST/$APP_ART" "$DIST/$APP_TAR_ART" "$DIST/$NODE_ART"
gh release upload "$TAG" -R "$GH_REPO" --clobber "$DIST/manifest-$ARCH.json"
gh release upload "$TAG" -R "$GH_REPO" --clobber "$DIST/SHA256SUMS.$ARCH"
gh release edit "$TAG" -R "$GH_REPO" --draft=false > /dev/null
ok "published: $(gh release view "$TAG" -R "$GH_REPO" --json url -q .url)"
