#!/usr/bin/env bash
# Atomic release switch with drain, readiness verification and safe rollback.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: upgrade.sh /absolute/path/to/cube-node-transport'
binary="$1"; version="$(require_binary "$binary")"
current="$(at /opt/cube-host/current)"
[ -L "$current" ] || fail 'no installed current release'
old="$(readlink "$current")"
old_version="$(basename "$old")"
[ "$old_version" != "$version" ] || { note "$version is already installed"; exit 0; }
install_release "$binary" "$version"

"$SYSTEMCTL" reload cube-host.service
ready="$(at /run/cube-host/ready.json)"
for _ in $(seq 1 50); do
  [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && break
  sleep 0.1
done
grep -q '"lifecycle":"draining"' "$ready" 2>/dev/null || fail 'drain was not confirmed; release unchanged'
"$SYSTEMCTL" stop cube-host.service
switch_release "$(at /opt/cube-host/releases/$version)"
if "$SYSTEMCTL" start cube-host.service && wait_ready "$version"; then
  ln -sfn "$old" "$(at /opt/cube-host/previous)"
  note "upgraded $old_version -> $version"
  exit 0
fi

note "new daemon failed readiness; rolling back to $old_version"
"$SYSTEMCTL" stop cube-host.service 2>/dev/null || true
switch_release "$old"
if "$SYSTEMCTL" start cube-host.service && wait_ready "$old_version"; then
  fail "upgrade failed; rollback to $old_version is healthy"
fi
fail "upgrade and rollback both failed; service is not production-ready—inspect journalctl -u cube-host"
