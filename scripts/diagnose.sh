#!/bin/sh
# Kept in app/ so app-only upgrades also install the diagnostic entry point.
set -eu
app="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
PATH="$app/../node/bin:$PATH"
export PATH
exec node "$app/packages/pi-extension/src/diagnose-cli.ts" "$@"
