#!/usr/bin/env bash
# Bring the cube VM up in the background and wait until it answers.
# Idempotent: if this build's VM already owns the ports, exits 0 quietly.
# First run builds what's missing (base ~min, app ~min; cube-node is
# optional and built separately — threads can't provision without it).
#
#   bash scripts/vm/up.sh
. "$(dirname "$0")/lib.sh"

PID_FILE="$BUILD_DIR/vm.pid"

vm_lock 9 "$BUILD_DIR/.vm-lock" nonblock \
  || { fail "another vm script holds $BUILD_DIR/.vm-lock"; exit 1; }
trap 'vm_unlock 9 "$BUILD_DIR/.vm-lock"' EXIT

check_sentinel() {
  # The sentinel lives on the APP disk — proves the ports lead to THIS
  # build's VM, not a stale one still squatting on 2222/7777.
  [ -f "$BUILD_DIR/build-id" ] || { fail "no $BUILD_DIR/build-id — build the app disk (build-app.sh)"; exit 1; }
  BUILD_ID="$(cat "$BUILD_DIR/build-id")"
  GOT_ID="$(vm_build_id)"
  [ "$GOT_ID" = "$BUILD_ID" ] || {
    fail "a VM answers on the ports but reports build '$GOT_ID' (expected '$BUILD_ID') — stop it first (scripts/vm/down.sh)"
    exit 1
  }
}

wait_ssh() {
  for _ in $(seq 90); do vm_ssh true 2>/dev/null && return 0; sleep 2; done
  fail "VM never became reachable over ssh (console: $RUN_LOG)"
  exit 1
}

wait_cubed() {
  # ssh up != product up: fail loudly if the cubed unit is broken. A first
  # boot seeds the state datasets before cubed may start, so allow 60s.
  for _ in $(seq 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$CUBED_PORT/api/threads" 2>/dev/null && return 0
    sleep 2
  done
  fail "cubed never answered on :$CUBED_PORT — check: scripts/vm/ssh.sh 'systemctl status cubed'"
  exit 1
}

if vm_ssh true 2>/dev/null; then
  check_sentinel; wait_cubed
  ok "VM already up — cubed on $CUBED_URL"
  exit 0
fi

if [ -n "$(vm_pids)" ]; then
  log "a VM is already booting — waiting for it"
  wait_ssh; check_sentinel; wait_cubed
  ok "VM up — cubed on $CUBED_URL"
  exit 0
fi

# Build what's missing. base and app are disposable build products; the
# DATA disk is precious and only ever created blank when absent.
[ -f "$OS_DISK" ]  || { log "no base image — building"; bash "$(dirname "$0")/build.sh"; }
[ -f "$APP_DISK" ] || { log "no app disk — building";  bash "$(dirname "$0")/build-app.sh"; }
ensure_data_disk || exit 1
[ -f "$NODE_DISK" ] || log "no cube-node disk — the product runs, but threads can't provision (bash scripts/vm/build-cube-node.sh once the VM is up)"

log "booting VM (daemonized; console -> $RUN_LOG)"
make_run_seed
ensure_live_disk
ensure_app_overlay
vm_boot_args
vm_disk_args "$RUN_SEED"
"$QEMU_BIN" "${VM_BOOT_ARGS[@]}" \
  "${VM_DISK_ARGS[@]}" \
  -nic "user,model=virtio-net-pci,$(vm_hostfwd)" \
  -display none -serial "file:$RUN_LOG" -no-reboot \
  -daemonize -pidfile "$PID_FILE" 9>&-   # do NOT hand qemu the lifecycle lock

wait_ssh; check_sentinel; wait_cubed
ok "VM up — cubed on $CUBED_URL"
