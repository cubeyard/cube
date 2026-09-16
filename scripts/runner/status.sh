#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
if [ -z "$ROOT" ]; then "$SYSTEMCTL" --no-pager --full status cube-runner.service || true; fi
ready="$(ready_file)"
if [ -s "$ready" ]; then cat "$ready"; else printf '{"lifecycle":"stopped","action":"inspect systemctl status and journalctl -u cube-runner"}\n'; exit 1; fi
