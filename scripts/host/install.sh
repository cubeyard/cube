#!/usr/bin/env bash
# shellcheck disable=SC2154 # repo_root is defined by sourced lib.sh.
# Install the trusted-host daemon boundary. Enrollment is intentionally separate.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
note_deprecated
require_platform
[ "$#" -eq 1 ] || fail 'usage: install.sh /absolute/path/to/cube-node-transport'
binary="$1"
version="$(require_binary "$binary")"

if [ -z "$ROOT" ]; then
  getent group "$HOST_USER" >/dev/null || groupadd --system "$HOST_USER"
  id "$HOST_USER" >/dev/null 2>&1 || useradd --system --gid "$HOST_USER" \
    --home-dir /var/lib/cube-host --shell /usr/sbin/nologin "$HOST_USER"
fi
install_release "$binary" "$version"
switch_release "$(at /opt/cube-host/releases/$version)"
install -d -m 0700 -o "$HOST_USER" -g "$HOST_USER" \
  "$(at /var/lib/cube-host)" "$(at /var/lib/cube-host/identity)" \
  "$(at /var/lib/cube-host/workspace)"
install -d -m 0755 "$(at /etc/cube-host)" "$(at /etc/systemd/system)"
install -m 0644 "$repo_root/scripts/host/cube-host.service" "$(at /etc/systemd/system/cube-host.service)"
if [ -z "$ROOT" ]; then
  "$SYSTEMCTL" daemon-reload
fi
note "installed $version; initialize immutable enrollment before starting the service"
