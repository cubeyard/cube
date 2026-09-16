#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
service_drain
ready="$(ready_file)"
for _ in $(seq 1 50); do [ -s "$ready" ] && grep -q '"lifecycle":"draining"' "$ready" && { cat "$ready"; exit 0; }; sleep 0.1; done
fail 'daemon did not confirm drain; inspect the runner service and logs'
