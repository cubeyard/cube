#!/usr/bin/env bash
# Packs the berth built by `cargo build --release --locked -p berth` into a
# release bundle for this platform, with what install-berth.sh needs:
#   berth-<label>-<platform>/bin/berth
#   berth-<label>-<platform>/share/berth/{berth-vm.service.in, dev.cube.berth-vm.plist.in,
#                                         install-berth.sh, README.md}
#   berth-<label>-<platform>/LICENSE
# and beside the bundle version.json (`berth version`) and provenance.txt.
# Usage: scripts/berth/package.sh <label> linux-x64-gnu|darwin-arm64 /abs/new-directory
set -euo pipefail
[ "$#" -eq 3 ] || { echo 'usage: package.sh <label> linux-x64-gnu|darwin-arm64 /abs/new-directory' >&2; exit 2; }
label=$1 platform=$2 out=$3
case "$label" in '' | *[!A-Za-z0-9.-]*) echo "package.sh: bad label $label" >&2; exit 2 ;; esac
case "$out" in /*) ;; *) echo 'package.sh: the destination must be an absolute path' >&2; exit 2 ;; esac
[ ! -e "$out" ] || { echo "package.sh: $out exists" >&2; exit 2; }
case "$platform:$(uname -s):$(uname -m)" in
linux-x64-gnu:Linux:x86_64 | darwin-arm64:Darwin:arm64) ;;
*) echo "package.sh: $platform is not this host ($(uname -s) $(uname -m))" >&2; exit 2 ;;
esac
repo=$(cd "$(dirname "$0")/../.." && pwd -P)
binary=${CARGO_TARGET_DIR:-$repo/target}/release/berth
[ -x "$binary" ] || { echo "package.sh: no $binary; build it first" >&2; exit 1; }
version_json=$("$binary" version)
printf '%s' "$version_json" | grep -q '"protocolVersion":4' || { echo "package.sh: not a protocol-4 berth: $version_json" >&2; exit 1; }

name=berth-$label-$platform
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/$name/bin" "$stage/$name/share/berth"
cp "$binary" "$stage/$name/bin/berth"
chmod 0755 "$stage/$name/bin/berth"
for f in berth-vm.service.in dev.cube.berth-vm.plist.in install-berth.sh; do
  cp "$repo/scripts/berth/$f" "$stage/$name/share/berth/$f"
done
chmod 0755 "$stage/$name/share/berth/install-berth.sh"
# The install section of berth's README, as it is at this commit.
awk '/^## Install from a release$/ { on = 1 } on && /^## / && !/^## Install from a release$/ { exit } on' \
  "$repo/packages/berth/README.md" >"$stage/$name/share/berth/README.md"
[ -s "$stage/$name/share/berth/README.md" ] || { echo 'package.sh: no "## Install from a release" in packages/berth/README.md' >&2; exit 1; }
cp "$repo/LICENSE" "$stage/$name/LICENSE"

mkdir -p "$out"
(cd "$stage" && tar -czf "$out/$name.tar.gz" "$name")
printf '%s\n' "$version_json" >"$out/version.json"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
{
  echo "commit $(git -C "$repo" rev-parse HEAD)"
  echo "platform $platform $(uname -s) $(uname -m)"
  echo "runner ${ImageOS:-} ${ImageVersion:-}"
  echo "berth $(sha "$binary")"
  echo "bundle $(sha "$out/$name.tar.gz")"
} >"$out/provenance.txt"
echo "package.sh: $out/$name.tar.gz"
cat "$out/provenance.txt"
