#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
note_deprecated
require_platform
"$SYSTEMCTL" reload cube-host.service
ready="$(at /run/cube-host/ready.json)"
for _ in $(seq 1 50); do
  [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && { cat "$ready"; exit 0; }
  sleep 0.1
done
fail 'daemon did not confirm drain; inspect systemctl status and journalctl -u cube-host'
