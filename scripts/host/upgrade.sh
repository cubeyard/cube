#!/usr/bin/env bash
# Atomic release switch with drain, readiness verification and safe rollback.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
note_deprecated
require_platform
[ "$#" -eq 1 ] || fail 'usage: upgrade.sh /absolute/path/to/cube-node-transport'
binary="$1"; version="$(require_binary "$binary")"
current="$(at /opt/cube-host/current)"
[ -L "$current" ] || fail 'no installed current release'
old="$(readlink "$current")"
old_version="$(basename "$old")"
[ "$old_version" != "$version" ] || { note "$version is already installed"; exit 0; }
install_release "$binary" "$version"
unit="$(at /etc/systemd/system/cube-host.service)"
candidate_unit="$repo_root/scripts/host/cube-host.service"
unit_backup="${unit}.rollback.$$"
[ -f "$unit" ] || fail 'installed systemd unit is missing'
install -m 0600 "$unit" "$unit_backup"
trap 'rm -f -- "$unit_backup"' EXIT
activate_unit() {
  install -m 0644 "$1" "$unit"
  if [ -z "$ROOT" ]; then
    chown root:root "$unit"
    "$SYSTEMCTL" daemon-reload
  fi
}

"$SYSTEMCTL" reload cube-host.service
ready="$(at /run/cube-host/ready.json)"
for _ in $(seq 1 50); do
  [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && break
  sleep 0.1
done
grep -q '"lifecycle":"draining"' "$ready" 2>/dev/null || fail 'drain was not confirmed; release unchanged'
"$SYSTEMCTL" stop cube-host.service
if ! activate_unit "$candidate_unit"; then
  activate_unit "$unit_backup" || fail 'candidate and previous systemd units could not be activated; service is stopped'
  "$SYSTEMCTL" start cube-host.service && wait_ready "$old_version" \
    || fail 'candidate systemd unit failed and the previous release did not recover; service is stopped'
  fail 'candidate systemd unit failed; previous release is healthy'
fi
switch_release "$(at /opt/cube-host/releases/$version)"
if "$SYSTEMCTL" start cube-host.service && wait_ready "$version"; then
  ln -sfn "$old" "$(at /opt/cube-host/previous)"
  note "upgraded $old_version -> $version"
  exit 0
fi

note "new daemon failed readiness; rolling back to $old_version"
"$SYSTEMCTL" stop cube-host.service 2>/dev/null || true
activate_unit "$unit_backup" || fail 'upgrade failed and the previous systemd unit could not be restored; service is stopped'
switch_release "$old"
if "$SYSTEMCTL" start cube-host.service && wait_ready "$old_version"; then
  fail "upgrade failed; rollback to $old_version is healthy"
fi
fail "upgrade and rollback both failed; service is not production-ready—inspect journalctl -u cube-host"
