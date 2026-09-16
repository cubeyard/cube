#!/usr/bin/env bash
# Build a legacy-layout compatibility bundle with the current runner binary.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
note_deprecated
require_build_platform
[ "$#" -eq 1 ] || fail 'usage: package.sh /absolute/new-destination.tar.gz'
destination="$1"
case "$destination" in /*.tar.gz) ;; *) fail 'destination must be an absolute .tar.gz path';; esac
[ ! -e "$destination" ] || fail 'destination already exists'
cd "$repo_root"
cargo build --locked --release -p cube-runner
binary="$repo_root/target/release/cube-runner"
version="$(require_binary "$binary")"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/cube-host/bin" "$stage/cube-host/scripts"
install -m 0755 "$binary" "$stage/cube-host/bin/cube-node-transport"
cp -a "$repo_root/scripts/host" "$stage/cube-host/scripts/host"
printf '%s\n' "softwareVersion=$version" "protocolVersion=1" "deprecated=true" "replacement=cube-runner" > "$stage/cube-host/MANIFEST"
(cd "$stage" && tar -czf "$destination.tmp" cube-host)
chmod 0644 "$destination.tmp"
mv "$destination.tmp" "$destination"
(cd "$(dirname "$destination")" && sha256sum "$(basename "$destination")") > "$destination.sha256"
note "wrote deprecated cube-host compatibility bundle with cube-runner $version; migrate with scripts/runner/upgrade.sh"
