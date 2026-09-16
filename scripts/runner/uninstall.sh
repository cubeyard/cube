#!/usr/bin/env bash
# Removes runner software only. Durable state requires an explicit second step.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --keep-state ] || fail 'usage: uninstall.sh --keep-state (state deletion is intentionally unsupported)'
service_remove
if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" disable cube-runner.service >/dev/null 2>&1 || true; fi
if [ "$PLATFORM" = Linux ]; then rm -rf "$(software_root)"
else rm -rf "$(release_root)" "$(current_link)" "$(previous_link)"; fi
note "removed cube-runner software; preserved $(state_root) and any legacy cube-host rollback unit"
