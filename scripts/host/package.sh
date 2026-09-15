#!/usr/bin/env bash
# Build a self-contained installer bundle on the supported Linux x86_64 target.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_build_platform
[ "$#" -eq 1 ] || fail 'usage: package.sh /absolute/new-destination.tar.gz'
destination="$1"
case "$destination" in /*.tar.gz) ;; *) fail 'destination must be an absolute .tar.gz path';; esac
[ ! -e "$destination" ] || fail 'destination already exists'
cd "$repo_root"
cargo build --locked --release -p cube-node-transport
binary="$repo_root/target/release/cube-node-transport"
version="$(require_binary "$binary")"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/cube-host/bin" "$stage/cube-host/scripts"
install -m 0755 "$binary" "$stage/cube-host/bin/cube-node-transport"
cp -a "$repo_root/scripts/host" "$stage/cube-host/scripts/host"
printf '%s\n' "softwareVersion=$version" "protocolVersion=1" > "$stage/cube-host/MANIFEST"
(cd "$stage" && tar -czf "$destination.tmp" cube-host)
chmod 0644 "$destination.tmp"
mv "$destination.tmp" "$destination"
sha256sum "$destination" > "$destination.sha256"
note "wrote cube-host $version installer bundle"
