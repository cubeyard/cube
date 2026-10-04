#!/usr/bin/env bash
# shellcheck disable=SC2154 # repo_root is defined by sourced lib.sh.
# Upgrade a protocol-3 runner in place without moving its state. A protocol-2
# runner (same-UID command execution) cannot be upgraded: protocol 3 needs a
# new state directory and a new enrollment; see the runbook.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: upgrade.sh /absolute/path/to/cube-runner'
binary="$1"; version="$(require_binary "$binary")"
installed="$(current_link)/cube-runner"
if [ -x "$installed" ] && ! "$installed" version 2>/dev/null | grep -q '"protocolVersion":3'; then
  fail 'the installed runner speaks protocol 2; protocol 3 needs a new state directory: back up, uninstall --keep-state, move the state aside, install and initialize again'
fi

if [ "$PLATFORM" = Darwin ]; then
  current="$(current_link)"; unit="$(service_file)"; ready="$(ready_file)"
  [ -L "$current" ] || fail 'no installed cube-runner release'
  [ -f "$unit" ] || fail 'installed cube-runner launchd plist is missing'
  old="$(readlink "$current")"; old_version="$(basename "$old")"
  install_release "$binary" "$version"
  unit_backup="${unit}.rollback.$$"; install -m 0600 "$unit" "$unit_backup"
  needs_rollback=0
  rollback_previous() {
    local healthy=0
    set +e
    service_stop
    install -m 0644 "$unit_backup" "$unit"
    switch_release "$old"
    service_start && wait_ready "$old_version" && healthy=1
    set -e
    [ "$healthy" = 1 ]
  }
  cleanup() {
    local rc=$?
    if [ "$needs_rollback" = 1 ]; then
      if rollback_previous; then note "interrupted upgrade rolled back to $old_version"
      else note 'interrupted upgrade and rollback both failed; inspect launchd and runner logs'; fi
    fi
    rm -f -- "$unit_backup"
    return "$rc"
  }
  trap cleanup EXIT
  service_drain
  for _ in $(seq 1 50); do [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && break; sleep 0.1; done
  grep -q '"lifecycle":"draining"' "$ready" 2>/dev/null || fail 'drain was not confirmed; release unchanged'
  service_stop; needs_rollback=1
  install_unit "$repo_root/scripts/runner/cube-runner.service"
  switch_release "$(release_root)/$version"
  if service_start && wait_ready "$version"; then
    ln -sfn "$old" "$(previous_link)"
    needs_rollback=0
    note "upgraded $old_version -> $version"
    exit 0
  fi
  note "new runner failed readiness; restoring $old_version"
  if rollback_previous; then needs_rollback=0; fail "upgrade failed; rollback to $old_version is healthy"; fi
  needs_rollback=0
  fail 'upgrade and rollback both failed; inspect launchd and runner logs'
fi

current="$(at /opt/cube-runner/current)"
[ -L "$current" ] || fail 'no installed cube-runner release'
old="$(readlink "$current")"; old_version="$(basename "$old")"
install_release "$binary" "$version"
install -d -m 0755 "$(at /etc/cube-runner)" "$(at /etc/systemd/system)"
unit="$(at /etc/systemd/system/cube-runner.service)"
[ -f "$unit" ] || fail 'installed cube-runner systemd unit is missing'
unit_backup="${unit}.rollback.$$"
install -m 0600 "$unit" "$unit_backup"
needs_rollback=0
rollback_previous() {
  local healthy=0
  set +e
  "$SYSTEMCTL" stop cube-runner.service >/dev/null 2>&1
  install -m 0644 "$unit_backup" "$unit"
  if [ -z "$ROOT" ]; then chown root:root "$unit"; "$SYSTEMCTL" daemon-reload; fi
  switch_release "$old"
  "$SYSTEMCTL" start cube-runner.service && healthy=1
  set -e
  [ "$healthy" = 1 ]
}
cleanup() {
  local rc=$?
  if [ "$needs_rollback" = 1 ]; then
    if rollback_previous; then note "interrupted upgrade rolled back to healthy $old_version"
    else note 'interrupted upgrade and rollback both failed; inspect journalctl -u cube-runner'; fi
  fi
  rm -f -- "$unit_backup"
  return "$rc"
}
trap cleanup EXIT

ready="$(ready_file)"
"$SYSTEMCTL" reload cube-runner.service
for _ in $(seq 1 50); do [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && break; sleep 0.1; done
grep -q '"lifecycle":"draining"' "$ready" 2>/dev/null || fail 'drain was not confirmed; release unchanged'
# Stopping powers running guests down (up to 30 s each); cubed boots them again.
"$SYSTEMCTL" stop cube-runner.service
needs_rollback=1
install_unit "$repo_root/scripts/runner/cube-runner.service"
switch_release "$(at /opt/cube-runner/releases/$version)"
if "$SYSTEMCTL" start cube-runner.service && wait_ready "$version"; then
  ln -sfn "$old" "$(at /opt/cube-runner/previous)"
  note "upgraded $old_version -> $version"
  needs_rollback=0
  exit 0
fi

note "new runner failed readiness; restoring $old_version"
if rollback_previous; then needs_rollback=0; fail "upgrade failed; rollback to $old_version is healthy"; fi
needs_rollback=0
fail 'upgrade and rollback both failed; inspect journalctl -u cube-runner'
