#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 4 ] || fail 'usage: initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID'
control_peer="$1"; node_id="$2"; thread_id="$3"; environment_id="$4"
binary="$(current_link)/cube-runner"
[ -x "$binary" ] || fail 'install the runner daemon first'
root="$(state_root)"; key="$(identity_root)/node.key"; state="$(journal_root)"; workspace="$(workspace_root)"
[ ! -e "$key" ] && [ ! -e "$state" ] || fail 'identity/state already exists; never overwrite or rebind it'
account="$RUNNER_USER"; is_legacy_layout && account="$LEGACY_USER"
run_runner() {
  if [ -n "$ROOT" ] || [ "$RUNNER_MODE" = user ] || [ "$(id -un)" = "$account" ]; then "$@"
  elif [ "$PLATFORM" = Linux ]; then runuser -u "$account" -- "$@"
  else sudo -u "$account" -- "$@"
  fi
}
peer="$(run_runner "$binary" keygen --key "$key")"
run_runner "$binary" runner-init --key "$key" --state "$state" --workspace "$workspace" \
  --allow-peer "$control_peer" --node-id "$node_id" --thread-id "$thread_id" --env "$environment_id" >/dev/null
if [ -z "$ROOT" ]; then
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" enable --now cube-runner.service
  else service_start
  fi
fi
printf '%s\n' "$peer"
