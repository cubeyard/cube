#!/usr/bin/env bash
# shellcheck disable=SC2154 # repo_root is defined by sourced lib.sh.
# Fresh trusted-runner install. Existing cube-host installations use upgrade.sh.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 1 ] || fail 'usage: install.sh /absolute/path/to/cube-runner'
[ "$PLATFORM" != Linux ] || { [ ! -e "$(at /opt/cube-host/current)" ] && [ ! -e "$(at /var/lib/cube-host/state/journal.db)" ]; } \
  || fail 'legacy cube-host installation detected; use scripts/runner/upgrade.sh to preserve its identity and journal'
binary="$1"; version="$(require_binary "$binary")"
if [ "$PLATFORM" = Linux ] && [ -z "$ROOT" ]; then
  getent group "$RUNNER_USER" >/dev/null || groupadd --system "$RUNNER_USER"
  id "$RUNNER_USER" >/dev/null 2>&1 || useradd --system --gid "$RUNNER_USER" \
    --home-dir /var/lib/cube-runner --shell /usr/sbin/nologin "$RUNNER_USER"
fi
if [ "$PLATFORM:$RUNNER_MODE" = Darwin:system ] && [ -z "$ROOT" ]; then
  dscl . -read "/Users/$RUNNER_USER" >/dev/null 2>&1 \
    || fail "create a passwordless, hidden $RUNNER_USER account before system installation"
  dscl . -read "/Groups/$RUNNER_GROUP" >/dev/null 2>&1 \
    || fail "create the dedicated $RUNNER_GROUP group before system installation"
fi
install_release "$binary" "$version"
switch_release "$(release_root)/$version"
owner="$(id -un)"; group="$(id -gn)"
if [ "$PLATFORM" = Linux ] || [ "$RUNNER_MODE" = system ]; then owner="$RUNNER_USER"; group="$RUNNER_GROUP"; fi
install -d -m 0700 -o "$owner" -g "$group" \
  "$(state_root)" "$(identity_root)" "$(workspace_root)" "$(log_root)" "$(dirname "$(ready_file)")"
if [ "$PLATFORM" = Linux ]; then install -d -m 0755 "$(at /etc/cube-runner)" "$(at /etc/systemd/system)"; fi
install_unit "$repo_root/scripts/runner/cube-runner.service"
if [ "$PLATFORM:$RUNNER_MODE" = Darwin:user ]; then
  note 'installed per-user LaunchAgent profile; this is production-safe only in a dedicated credential-free login account'
fi
note "installed $version; initialize immutable enrollment before starting cube-runner"
