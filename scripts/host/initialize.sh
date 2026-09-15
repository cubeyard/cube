#!/usr/bin/env bash
# Create a fresh immutable node identity and binding under the dedicated account.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 4 ] || fail 'usage: initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID'
control_peer="$1"; node_id="$2"; thread_id="$3"; environment_id="$4"
binary="$(at /opt/cube-host/current/cube-node-transport)"
[ -x "$binary" ] || fail 'install the daemon first'
key="$(at /var/lib/cube-host/identity/node.key)"
state="$(at /var/lib/cube-host/state)"
workspace="$(at /var/lib/cube-host/workspace)"
[ ! -e "$key" ] && [ ! -e "$state" ] || fail 'identity/state already exists; never overwrite or rebind it'

run_host() {
  if [ -n "$ROOT" ] || [ "$(id -un)" = "$HOST_USER" ]; then "$@";
  else runuser -u "$HOST_USER" -- "$@"; fi
}
peer="$(run_host "$binary" keygen --key "$key")"
run_host "$binary" host-init --key "$key" --state "$state" --workspace "$workspace" \
  --allow-peer "$control_peer" --node-id "$node_id" --thread-id "$thread_id" --env "$environment_id" >/dev/null
if [ -z "$ROOT" ]; then
  "$SYSTEMCTL" enable --now cube-host.service
fi
printf '%s\n' "$peer"
