#!/usr/bin/env bash
# Boot the cube VM in the FOREGROUND. The image carries no trust — the
# run seed (lib.sh: make_run_seed) authorizes ~/cube/vm/id_ed25519 for
# the `cube` user at first boot. ctrl-c stops the VM.
#
#   bash scripts/vm/run.sh &
#   bash scripts/vm/test.sh
. "$(dirname "$0")/lib.sh"

[ -f "$OS_DISK" ]  || { fail "no base image at $OS_DISK — run build.sh first"; exit 1; }
[ -f "$APP_DISK" ] || { fail "no app disk at $APP_DISK — run build-app.sh first"; exit 1; }
ensure_data_disk || exit 1
make_run_seed
ensure_live_disk
ensure_app_overlay
vm_boot_args
vm_disk_args "$RUN_SEED"

exec "$QEMU_BIN" "${VM_BOOT_ARGS[@]}" \
  "${VM_DISK_ARGS[@]}" \
  -nic "user,model=virtio-net-pci,$(vm_hostfwd)" \
  -display none -serial "file:$RUN_LOG" -no-reboot
