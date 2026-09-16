#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build_platform
[ "$#" -eq 1 ] || fail 'usage: package.sh /absolute/new-destination.tar.gz'
destination="$1"
case "$destination" in /*.tar.gz) ;; *) fail 'destination must be an absolute .tar.gz path';; esac
[ ! -e "$destination" ] || fail 'destination already exists'
cd "$repo_root"
cargo build --locked --release -p cube-runner
binary="$repo_root/target/release/cube-runner"; version="$(require_binary "$binary")"
stage="$(mktemp -d)"; trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/cube-runner/bin" "$stage/cube-runner/scripts"
install -m 0755 "$binary" "$stage/cube-runner/bin/cube-runner"
ln -s cube-runner "$stage/cube-runner/bin/cube-node-transport"
cp -a "$repo_root/scripts/runner" "$stage/cube-runner/scripts/runner"
cp -a "$repo_root/scripts/host" "$stage/cube-runner/scripts/host"
printf '%s\n' "softwareVersion=$version" "protocolVersion=1" "product=trusted-runner" \
  "os=$PLATFORM" "arch=$ARCH" > "$stage/cube-runner/MANIFEST"
(cd "$stage" && tar -czf "$destination.tmp" cube-runner)
chmod 0644 "$destination.tmp"; mv "$destination.tmp" "$destination"
checksum_write "$destination" "$destination.sha256"
note "wrote cube-runner $version installer bundle"
