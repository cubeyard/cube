#!/usr/bin/env bash
set -euo pipefail

ROOT="${CUBE_HOST_ROOT:-}"
HOST_USER="${CUBE_HOST_USER:-cube-host}"
SYSTEMCTL="${CUBE_HOST_SYSTEMCTL:-systemctl}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

at() { printf '%s%s' "$ROOT" "$1"; }
fail() { printf 'cube-host: %s\n' "$*" >&2; exit 1; }
note() { printf 'cube-host: %s\n' "$*"; }
require_build_platform() {
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] \
    || fail 'the supported host platform is Linux x86_64'
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
    || fail 'binary does not support host protocol 1'
  printf '%s' "$metadata" | grep -q '"minimumProtocolVersion":1' \
    || fail 'binary does not report protocol compatibility'
  version="$(printf '%s' "$metadata" | sed -n 's/.*"softwareVersion":"\([^"]*\)".*/\1/p')"
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' \
    || fail 'binary did not report a path-safe semantic software version'
  printf '%s' "$version"
}
install_release() {
  local binary="$1" version="$2" releases release temporary
  releases="$(at /opt/cube-host/releases)"
  release="$releases/$version"
  temporary="$releases/.${version}.$$"
  install -d -m 0755 "$releases"
  chown root:root "$(at /opt/cube-host)" "$releases" 2>/dev/null || [ -n "$ROOT" ]
  [ ! -e "$release" ] || { cmp -s "$binary" "$release/cube-node-transport" && return 0; fail "release $version already exists with different bytes"; }
  mkdir -m 0755 "$temporary"
  install -m 0755 "$binary" "$temporary/cube-node-transport"
  mv "$temporary" "$release"
  chown -R root:root "$release" 2>/dev/null || [ -n "$ROOT" ]
}
switch_release() {
  local release="$1" current tmp
  current="$(at /opt/cube-host/current)"
  tmp="${current}.new.$$"
  ln -s "$release" "$tmp"
  mv -Tf "$tmp" "$current"
}
wait_ready() {
  local version="$1" ready="$(at /run/cube-host/ready.json)"
  for _ in $(seq 1 100); do
    if [ -s "$ready" ] && grep -q '"lifecycle":"ready"' "$ready" \
      && grep -q "\"softwareVersion\":\"$version\"" "$ready" \
      && grep -q '"protocolVersion":1' "$ready"; then return 0; fi
    sleep 0.1
  done
  return 1
}
