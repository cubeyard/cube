#!/usr/bin/env bash
# shellcheck disable=SC2154 # repo_root is defined by sourced lib.sh.
# Upgrade either a native runner or cube-host 0.1.1 without moving its state.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: upgrade.sh /absolute/path/to/cube-runner'
binary="$1"; version="$(require_binary "$binary")"

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

legacy=0; from_host=0; old_service=cube-runner.service; old_ready="$(ready_file)"
current="$(at /opt/cube-runner/current)"
if [ -f "$(at /etc/cube-runner/legacy-layout)" ]; then
  legacy=1
elif is_legacy_layout && [ -L "$(at /opt/cube-host/current)" ]; then
  legacy=1; from_host=1; old_service=cube-host.service; old_ready="$(at /run/cube-host/ready.json)"
  current="$(at /opt/cube-host/current)"
fi
[ -L "$current" ] || fail 'no installed cube-runner or cube-host release'
old="$(readlink "$current")"; old_version="$(basename "$old")"
install_release "$binary" "$version"
install -d -m 0755 "$(at /etc/cube-runner)" "$(at /etc/systemd/system)"
candidate="$repo_root/scripts/runner/cube-runner.service"
if [ "$legacy" = 1 ]; then candidate="$repo_root/scripts/runner/cube-runner-legacy.service"; fi
unit="$(at /etc/systemd/system/cube-runner.service)"; unit_backup=""
if [ "$from_host" = 0 ]; then
  [ -f "$unit" ] || fail 'installed cube-runner systemd unit is missing'
  unit_backup="${unit}.rollback.$$"
  install -m 0600 "$unit" "$unit_backup"
fi
needs_rollback=0
rollback_previous() {
  local healthy=0
  set +e
  "$SYSTEMCTL" stop cube-runner.service >/dev/null 2>&1
  if [ "$from_host" = 1 ]; then rm -f "$(at /etc/cube-runner/legacy-layout)"; fi
  if [ "$from_host" = 0 ]; then
    install -m 0644 "$unit_backup" "$unit"
    if [ -z "$ROOT" ]; then chown root:root "$unit"; "$SYSTEMCTL" daemon-reload; fi
    switch_release "$old"
  fi
  "$SYSTEMCTL" start "$old_service" && healthy=1
  set -e
  [ "$healthy" = 1 ]
}
cleanup() {
  local rc=$?
  if [ "$needs_rollback" = 1 ]; then
    if rollback_previous; then
      note "interrupted upgrade rolled back to healthy $old_service $old_version"
    else
      note "interrupted upgrade and rollback both failed; inspect journalctl for both services"
    fi
  fi
  rm -f -- "$unit_backup"
  return "$rc"
}
trap cleanup EXIT

"$SYSTEMCTL" reload "$old_service"
for _ in $(seq 1 50); do [ -s "$old_ready" ] && grep -q '"lifecycle":"draining"' "$old_ready" && break; sleep 0.1; done
grep -q '"lifecycle":"draining"' "$old_ready" 2>/dev/null || fail 'drain was not confirmed; release unchanged'
"$SYSTEMCTL" stop "$old_service"
needs_rollback=1
install_unit "$candidate"
switch_release "$(at /opt/cube-runner/releases/$version)"
if [ "$from_host" = 1 ]; then printf '%s\n' 'state=/var/lib/cube-host user=cube-host rollback=cube-host.service' > "$(at /etc/cube-runner/legacy-layout)"; fi
if "$SYSTEMCTL" start cube-runner.service && wait_ready "$version"; then
  [ "$from_host" = 0 ] || "$SYSTEMCTL" disable cube-host.service >/dev/null 2>&1 || true
  ln -sfn "$old" "$(at /opt/cube-runner/previous)"
  if [ "$legacy" = 1 ]; then
    note "upgraded $old_version -> $version; legacy state retained in place"
  else
    note "upgraded $old_version -> $version"
  fi
  needs_rollback=0
  exit 0
fi

note "new runner failed readiness; restoring $old_service $old_version"
if rollback_previous; then needs_rollback=0; fail "upgrade failed; rollback to $old_version is healthy"; fi
needs_rollback=0
fail "upgrade and rollback both failed; inspect journalctl -u cube-runner and -u $old_service"
