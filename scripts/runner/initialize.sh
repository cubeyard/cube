#!/usr/bin/env bash
# Immutable enrollment. The runner copies the base image into its state
# (state/images/<sha256>.qcow2, read-only); the source file may be removed later.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_platform
[ "$#" -eq 5 ] || fail 'usage: initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID /absolute/debian-13-genericcloud.qcow2'
control_peer="$1"; node_id="$2"; thread_id="$3"; environment_id="$4"; image="$5"
case "$image" in /*) ;; *) fail 'the base image path must be absolute' ;; esac
[ -f "$image" ] && [ -r "$image" ] || fail 'the base image must be a readable regular file'
binary="$(current_link)/cube-runner"
[ -x "$binary" ] || fail 'install the runner daemon first'
key="$(identity_root)/node.key"; state="$(journal_root)"
[ ! -e "$key" ] && [ ! -e "$state" ] || fail 'identity/state already exists; never overwrite or rebind it'
account="$RUNNER_USER"
run_runner() {
  if [ -n "$ROOT" ] || [ "$RUNNER_MODE" = user ] || [ "$(id -un)" = "$account" ]; then "$@"
  elif [ "$PLATFORM" = Linux ]; then runuser -u "$account" -- "$@"
  else sudo -u "$account" -- "$@"
  fi
}
peer="$(run_runner "$binary" keygen --key "$key")"
run_runner "$binary" runner-init --key "$key" --state "$state" --image "$image" \
  --allow-peer "$control_peer" --node-id "$node_id" --thread-id "$thread_id" --env "$environment_id" >/dev/null
if [ -z "$ROOT" ]; then
  if [ "$PLATFORM" = Linux ]; then "$SYSTEMCTL" enable --now cube-runner.service
  else service_start
  fi
fi
printf '%s\n' "$peer"
