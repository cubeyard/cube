#!/usr/bin/env bash
# shellcheck disable=SC2034 # Shared library exports are consumed by caller scripts.
set -euo pipefail

ROOT="${CUBE_RUNNER_ROOT:-${CUBE_HOST_ROOT:-}}"
RUNNER_USER="${CUBE_RUNNER_USER:-cube-runner}"
LEGACY_USER="${CUBE_HOST_USER:-cube-host}"
SYSTEMCTL="${CUBE_RUNNER_SYSTEMCTL:-${CUBE_HOST_SYSTEMCTL:-systemctl}}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

at() { printf '%s%s' "$ROOT" "$1"; }
fail() { printf 'cube-runner: %s\n' "$*" >&2; exit 1; }
note() { printf 'cube-runner: %s\n' "$*"; }
require_build_platform() {
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
    || fail 'the supported runner platform is Linux x86_64'
}
require_platform() {
  require_build_platform
  if [ -z "$ROOT" ]; then
    [ "$(id -u)" -eq 0 ] || fail 'run as root'
    [ -d /run/systemd/system ] || fail 'systemd is required'
  fi
}
require_binary() {
  local binary="$1" metadata version
  [ -f "$binary" ] && [ -x "$binary" ] && [ ! -L "$binary" ] \
    || fail 'binary must be an executable regular file, not a symlink'
  metadata="$($binary version 2>/dev/null)" || fail 'binary version check failed'
  printf '%s' "$metadata" | grep -q '"protocolVersion":1' \
    || fail 'binary does not support runner protocol 1'
  printf '%s' "$metadata" | grep -q '"minimumProtocolVersion":1' \
    || fail 'binary does not report protocol compatibility'
  version="$(printf '%s' "$metadata" | sed -n 's/.*"softwareVersion":"\([^"]*\)".*/\1/p')"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' \
    || fail 'binary did not report a path-safe semantic software version'
  printf '%s' "$version"
}
install_release() {
  local binary="$1" version="$2" releases release temporary
  releases="$(at /opt/cube-runner/releases)"
  release="$releases/$version"
  temporary="$releases/.${version}.$$"
  install -d -m 0755 "$releases"
  chown root:root "$(at /opt/cube-runner)" "$releases" 2>/dev/null || [ -n "$ROOT" ]
  [ ! -e "$release" ] || { cmp -s "$binary" "$release/cube-runner" && return 0; fail "release $version already exists with different bytes"; }
  mkdir -m 0755 "$temporary"
  install -m 0755 "$binary" "$temporary/cube-runner"
  # Binary alias only; state, service and product names remain runner.
  ln -s cube-runner "$temporary/cube-node-transport"
  mv "$temporary" "$release"
  chown -R root:root "$release" 2>/dev/null || [ -n "$ROOT" ]
}
switch_release() {
  local release="$1" current tmp
  current="$(at /opt/cube-runner/current)"
  tmp="${current}.new.$$"
  ln -s "$release" "$tmp"
  mv -Tf "$tmp" "$current"
}
is_legacy_layout() {
  [ -f "$(at /etc/cube-runner/legacy-layout)" ] \
    || { [ -f "$(at /var/lib/cube-host/state/journal.db)" ] && [ ! -e "$(at /var/lib/cube-runner/state/journal.db)" ]; }
}
state_root() { if is_legacy_layout; then at /var/lib/cube-host; else at /var/lib/cube-runner; fi; }
ready_file() { at /run/cube-runner/ready.json; }
wait_ready() {
  local version="$1" ready
  ready="$(ready_file)"
  for _ in $(seq 1 100); do
    if [ -s "$ready" ] && grep -q '"lifecycle":"ready"' "$ready" \
      && grep -q "\"softwareVersion\":\"$version\"" "$ready" \
      && grep -q '"protocolVersion":1' "$ready"; then return 0; fi
    sleep 0.1
  done
  return 1
}
install_unit() {
  local source="$1" unit
  unit="$(at /etc/systemd/system/cube-runner.service)"
  install -m 0644 "$source" "$unit"
  if [ -z "$ROOT" ]; then chown root:root "$unit"; "$SYSTEMCTL" daemon-reload; fi
}
