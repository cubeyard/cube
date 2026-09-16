#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --i-reviewed-unknown-operations ] \
  || fail 'usage: acknowledge-recovery.sh --i-reviewed-unknown-operations'
if [ -z "$ROOT" ] && "$SYSTEMCTL" is-active --quiet cube-runner.service; then fail 'stop cube-runner before acknowledging recovery'; fi
marker="$(state_root)/state/restore-quarantine"
[ -f "$marker" ] || fail 'no restore quarantine is present'
rm -f "$marker"
note 'recovery quarantine removed; starting the runner remains an explicit operator action'
