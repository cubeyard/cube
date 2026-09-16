#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --i-reviewed-unknown-operations ] \
  || fail 'usage: acknowledge-recovery.sh --i-reviewed-unknown-operations'
if [ -z "$ROOT" ] && service_active; then fail 'stop cube-runner before acknowledging recovery'; fi
marker="$(journal_root)/restore-quarantine"
[ -f "$marker" ] || fail 'no restore quarantine is present'
rm -f "$marker"
note 'recovery quarantine removed; starting the runner remains an explicit operator action'
