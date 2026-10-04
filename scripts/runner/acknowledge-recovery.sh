#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --i-reviewed-retained-vms ] \
  || fail 'usage: acknowledge-recovery.sh --i-reviewed-retained-vms'
if [ -z "$ROOT" ] && service_active; then fail 'stop cube-runner before acknowledging recovery'; fi
marker="$(journal_root)/restore-quarantine"
[ -f "$marker" ] || fail 'no restore quarantine is present'
binary="$(current_link)/cube-runner"; key="$(identity_root)/node.key"
account="$RUNNER_USER"
if [ -n "$ROOT" ] || [ "$RUNNER_MODE" = user ] || [ "$(id -un)" = "$account" ]; then
  "$binary" runner-acknowledge-recovery --key "$key" --state "$(journal_root)" >/dev/null
elif [ "$PLATFORM" = Linux ]; then
  runuser -u "$account" -- "$binary" runner-acknowledge-recovery --key "$key" --state "$(journal_root)" >/dev/null
else
  sudo -u "$account" -- "$binary" runner-acknowledge-recovery --key "$key" --state "$(journal_root)" >/dev/null
fi
note 'recovery quarantine removed; starting the runner remains an explicit operator action'
