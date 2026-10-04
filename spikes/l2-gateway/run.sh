#!/usr/bin/env bash
# Boots a Debian cloud VM whose only NIC is a raw-frame channel over Iroh to
# the gateway. Usage: run.sh <workdir with debian.qcow2 + seed.iso>
set -euo pipefail
work=$(realpath "$1"); bin=$(realpath "$(dirname "$0")")/target/release
cd "$work"
rm -f overlay.qcow2 qemu.sock pump.sock serial.log spike.log gateway.log pump.log gateway.id
qemu-img create -q -f qcow2 -F qcow2 -b debian.qcow2 overlay.qcow2 8G
pump_id=$("$bin/l2id" pump.key)
"$bin/gateway" gateway.key "$pump_id" 127.0.0.1:47011 127.0.0.53:53 > gateway.id 2> gateway.log &
gw=$!
while [ ! -s gateway.id ]; do sleep 0.1; done
"$bin/pump" pump.key "$(cat gateway.id)" 127.0.0.1:47011 "$work/pump.sock" "$work/qemu.sock" 2> pump.log &
pump=$!
while [ ! -S pump.sock ]; do sleep 0.1; done
trap 'kill $pump $gw 2>/dev/null || true' EXIT
start=$(date +%s.%N)
qemu-system-x86_64 -machine q35,accel=kvm -cpu host -smp 2 -m 2048 -nographic \
  -drive file=overlay.qcow2,if=virtio -drive file=seed.iso,if=virtio,format=raw,readonly=on \
  -netdev dgram,id=n0,local.type=unix,local.path="$work/qemu.sock",remote.type=unix,remote.path="$work/pump.sock" \
  -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56 \
  -serial file:serial.log -serial file:spike.log -monitor none -display none
echo "vm ran $(echo "$(date +%s.%N) - $start" | bc) s"
