#!/usr/bin/env bash
# The public preview as a `cube service`: the simulation (sim.ts), never the
# real-cubed host. Node's permission model denies it child processes, file
# writes and reads outside this package, whatever its code does.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node --permission "--allow-fs-read=$root" --allow-net "$root/preview/sim.ts" --port "${PORT:-7790}" --host 0.0.0.0
