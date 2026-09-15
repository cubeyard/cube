#!/usr/bin/env bash
# Explicit operator acknowledgement after restore reconciliation.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "${1:-}" = --i-reviewed-unknown-operations ] \
  || fail 'usage: acknowledge-recovery.sh --i-reviewed-unknown-operations'
if [ -z "$ROOT" ] && "$SYSTEMCTL" is-active --quiet cube-host.service; then
  fail 'stop cube-host before acknowledging recovery'
fi
marker="$(at /var/lib/cube-host/state/restore-quarantine)"
[ -f "$marker" ] || fail 'no restore quarantine is present'
rm -f "$marker"
note 'recovery quarantine removed; starting the daemon remains an explicit operator action'
