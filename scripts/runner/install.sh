#!/usr/bin/env bash
# Fresh trusted-runner install. Existing cube-host installations use upgrade.sh.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: install.sh /absolute/path/to/cube-runner'
[ ! -e "$(at /opt/cube-host/current)" ] && [ ! -e "$(at /var/lib/cube-host/state/journal.db)" ] \
  || fail 'legacy cube-host installation detected; use scripts/runner/upgrade.sh to preserve its identity and journal'
binary="$1"; version="$(require_binary "$binary")"
if [ -z "$ROOT" ]; then
  getent group "$RUNNER_USER" >/dev/null || groupadd --system "$RUNNER_USER"
  id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --gid "$RUNNER_USER" \
    --home-dir /var/lib/cube-runner --shell /usr/sbin/nologin "$RUNNER_USER"
fi
install_release "$binary" "$version"
switch_release "$(at /opt/cube-runner/releases/$version)"
install -d -m 0700 -o "$RUNNER_USER" -g "$RUNNER_USER" \
  "$(at /var/lib/cube-runner)" "$(at /var/lib/cube-runner/identity)" "$(at /var/lib/cube-runner/workspace)"
install -d -m 0755 "$(at /etc/cube-runner)" "$(at /etc/systemd/system)"
install_unit "$repo_root/scripts/runner/cube-runner.service"
note "installed $version; initialize immutable enrollment before starting cube-runner"
