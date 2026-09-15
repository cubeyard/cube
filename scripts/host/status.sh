#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
ready="$(at /run/cube-host/ready.json)"
if [ -z "$ROOT" ]; then
  "$SYSTEMCTL" --no-pager --full status cube-host.service || true
fi
if [ -s "$ready" ]; then
  cat "$ready"
else
  printf '{"lifecycle":"stopped","action":"inspect systemctl status and journalctl -u cube-host"}\n'
  exit 1
fi
