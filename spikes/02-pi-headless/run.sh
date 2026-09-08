#!/usr/bin/env bash
# Spike 2 runner. Wraps the harness in `sg incus-admin` because the invoking
# shell may predate the user's incus-admin membership (fresh logins don't need
# it). Node 25 runs .ts natively (type stripping).
set -euo pipefail
cd "$(dirname "$0")"
exec sg incus-admin -c "node harness.ts"
