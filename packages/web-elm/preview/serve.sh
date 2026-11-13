#!/usr/bin/env bash
# The preview as a `cube service`: a fresh disposable instance on each start
# (a restart discards the last one's threads). PORT comes from cube service;
# ALLOWED_HOST is the portal hostname cubed must accept.
set -euo pipefail
scratch="${TMPDIR:-/tmp}/cube-elm-preview"
rm -rf "$scratch"
exec node "$(dirname "$0")/host.ts" --scratch "$scratch" --port "${PORT:-7790}" --host 0.0.0.0 --seed ${ALLOWED_HOST:+--allowed-host "$ALLOWED_HOST"}
