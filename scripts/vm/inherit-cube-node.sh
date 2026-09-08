#!/usr/bin/env bash
# Reuse a published cube-node artifact instead of rebuilding it.
#
#   bash scripts/vm/inherit-cube-node.sh <commit-ish>
#
# cube-node is built from mutable inputs (an Ubuntu image alias, apt,
# a node tarball), so two builds of the SAME images/ tree never hash the
# same — and every release shipped ~300 MB the launcher then had to
# download again. The artifact's only source input is the images/
# directory: when its git tree hash matches a published release's
# manifest, that release's bytes are the right bytes. This copies them
# into $NODE_DISK (a compressed qcow2 boots as-is) and records the
# origin, and package-release.sh ships them untouched so the sha stays
# identical and the launcher says "already have".
#
# Exit 0: inherited. Exit 3: no match (build it). Anything else: error.
. "$(dirname "$0")/lib.sh"

REF="${1:?usage: inherit-cube-node.sh <commit-ish>}"
command -v gh >/dev/null 2>&1 || { fail "gh CLI required"; exit 1; }
GH_REPO="${GITHUB_REPOSITORY:-$(git -C "$REPO_ROOT" remote get-url origin)}"
ARCH="$GUEST_ARCH"
WANT_TREE="$(git -C "$REPO_ROOT" rev-parse "$REF:images")"

log "cube-node: looking for a published $ARCH build of images/ tree ${WANT_TREE:0:12}"
TAGS="$(gh release list -R "$GH_REPO" --limit 20 --json tagName \
  --exclude-drafts --exclude-pre-releases -q '.[].tagName' 2>/dev/null | grep '^vm-v' || true)"
[ -n "$TAGS" ] || { echo "no published releases to inherit from"; exit 3; }

TMP="$(mktemp -d /tmp/cube-inherit-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
for tag in $TAGS; do
  rm -f "$TMP/manifest-$ARCH.json"
  gh release download "$tag" -R "$GH_REPO" -D "$TMP" -p "manifest-$ARCH.json" 2>/dev/null || continue
  tree="$(sed -n 's/.*"images_tree": *"\([^"]*\)".*/\1/p' "$TMP/manifest-$ARCH.json" | head -1)"
  [ "$tree" = "$WANT_TREE" ] || continue
  file="$(sed -n 's/.*"node_file": *"\([^"]*\)".*/\1/p' "$TMP/manifest-$ARCH.json" | head -1)"
  sha="$(sed -n 's/.*"node_sha256": *"\([^"]*\)".*/\1/p' "$TMP/manifest-$ARCH.json" | head -1)"
  [ -n "$file" ] && [ -n "$sha" ] || continue
  log "inherit $file from $tag"
  gh release download "$tag" -R "$GH_REPO" -D "$TMP" -p "$file"
  got="$(sha256 "$TMP/$file" | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || { fail "$file from $tag does not match its manifest sha256"; exit 1; }
  mv "$TMP/$file" "$NODE_DISK"
  printf '%s\n%s\n' "$tag" "$sha" > "$BUILD_DIR/node-inherited-from"
  ok "cube-node inherited from $tag ($sha)"
  exit 0
done
echo "no published release carries images/ tree ${WANT_TREE:0:12} for $ARCH — build it"
exit 3
