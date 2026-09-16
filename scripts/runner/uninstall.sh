#!/usr/bin/env bash
# Removes runner software only. Durable state requires an explicit second step.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --keep-state ] || fail 'usage: uninstall.sh --keep-state (state deletion is intentionally unsupported)'
"$SYSTEMCTL" stop cube-runner.service 2>/dev/null || true
"$SYSTEMCTL" disable cube-runner.service >/dev/null 2>&1 || true
rm -f "$(at /etc/systemd/system/cube-runner.service)"
rm -rf "$(at /opt/cube-runner)"
if [ -z "$ROOT" ]; then "$SYSTEMCTL" daemon-reload; fi
note "removed cube-runner software; preserved $(state_root) and any legacy cube-host rollback unit"
