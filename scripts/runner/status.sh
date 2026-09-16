#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
if [ -z "$ROOT" ]; then service_status; fi
ready="$(ready_file)"
if [ -s "$ready" ]; then cat "$ready"; else printf '{"lifecycle":"stopped","action":"inspect the runner service and bounded logs"}\n'; exit 1; fi
