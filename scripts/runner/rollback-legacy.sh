#!/usr/bin/env bash
# Return a phase-1 migrated installation to its untouched cube-host 0.1.1 unit.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ -f "$(at /etc/cube-runner/legacy-layout)" ] || fail 'this installation does not use the legacy cube-host layout'
"$SYSTEMCTL" reload cube-runner.service
"$SYSTEMCTL" stop cube-runner.service
"$SYSTEMCTL" enable cube-host.service >/dev/null 2>&1 || true
"$SYSTEMCTL" start cube-host.service || fail 'cube-host rollback did not start; runner remains stopped'
note 'cube-host rollback is active; key, state, journal, workspace and binding were never moved'
