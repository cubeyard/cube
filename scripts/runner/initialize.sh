#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 4 ] || fail 'usage: initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID'
control_peer="$1"; node_id="$2"; thread_id="$3"; environment_id="$4"
binary="$(at /opt/cube-runner/current/cube-runner)"
[ -x "$binary" ] || fail 'install the runner daemon first'
root="$(state_root)"; key="$root/identity/node.key"; state="$root/state"; workspace="$root/workspace"
[ ! -e "$key" ] && [ ! -e "$state" ] || fail 'identity/state already exists; never overwrite or rebind it'
account="$RUNNER_USER"; is_legacy_layout && account="$LEGACY_USER"
run_runner() { if [ -n "$ROOT" ] || [ "$(id -un)" = "$account" ]; then "$@"; else runuser -u "$account" -- "$@"; fi; }
peer="$(run_runner "$binary" keygen --key "$key")"
run_runner "$binary" runner-init --key "$key" --state "$state" --workspace "$workspace" \
  --allow-peer "$control_peer" --node-id "$node_id" --thread-id "$thread_id" --env "$environment_id" >/dev/null
if [ -z "$ROOT" ]; then "$SYSTEMCTL" enable --now cube-runner.service; fi
printf '%s\n' "$peer"
