#!/usr/bin/env bash
# Gracefully stop the running cube VM (poweroff over ssh; hard kill after
# 60s). Safe to run when nothing is up. Never touches a bake in progress.
#
#   bash scripts/vm/down.sh
. "$(dirname "$0")/lib.sh"

PID_FILE="$BUILD_DIR/vm.pid"

vm_lock 9 "$BUILD_DIR/.vm-lock" nonblock \
  || { fail "another vm script holds $BUILD_DIR/.vm-lock"; exit 1; }
trap 'vm_unlock 9 "$BUILD_DIR/.vm-lock"' EXIT

# Capture the target set ONCE — everything below waits on or kills only
# these pids, never a VM started after this point.
PIDS="$(vm_pids)"
if [ -z "$PIDS" ]; then
  ok "no VM running"
  exit 0
fi

pids_alive() { local p; for p in $PIDS; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }

# Only send poweroff to a VM that proves it is OUR build — a foreign VM
# squatting the ssh port doesn't get shut down by us.
GOT_ID="$(vm_build_id)"
if [ -f "$BUILD_DIR/build-id" ] && [ "$GOT_ID" = "$(cat "$BUILD_DIR/build-id")" ]; then
  log "powering off"
  vm_ssh 'sudo poweroff' 2>/dev/null || true
else
  log "VM on the ssh port is not this build (got '$GOT_ID') — skipping graceful poweroff"
fi

for _ in $(seq 30); do pids_alive || break; sleep 2; done
if pids_alive; then
  fail "VM still running after 60s — killing it"
  kill $PIDS 2>/dev/null || true
  sleep 1
fi
rm -f "$PID_FILE"
pids_alive && { fail "qemu would not die"; exit 1; }
ok "VM stopped"
