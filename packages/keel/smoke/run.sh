#!/bin/sh
# Boots cube's guest kernel with the smoke initramfs under QEMU and checks
# that the guest printed "cube-smoke: ok".
# Usage: packages/keel/smoke/run.sh <arm64|x86_64> [accel]
# accel defaults to the native one (hvf on macOS arm64, kvm on Linux) for the
# host's own architecture and tcg otherwise.
set -eu

arch=$1
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/out/$arch
host=$(uname -s)-$(uname -m)

case "$arch" in
arm64) qemu=qemu-system-aarch64; machine=virt; console=ttyAMA0; cpu_native=host; cpu_tcg=max ;;
x86_64) qemu=qemu-system-x86_64; machine=q35; console=ttyS0; cpu_native=host; cpu_tcg=max ;;
*) echo "unknown architecture $arch" >&2; exit 2 ;;
esac

accel=${2:-}
if [ -z "$accel" ]; then
	case "$host:$arch" in
	Darwin-arm64:arm64) accel=hvf ;;
	Linux-x86_64:x86_64 | Linux-aarch64:arm64) accel=kvm ;;
	*) accel=tcg ;;
	esac
fi
cpu=$cpu_native
[ "$accel" = tcg ] && cpu=$cpu_tcg

log=$out/smoke-$accel.log
timeout_s=120
"$qemu" -machine "$machine" -accel "$accel" -cpu "$cpu" -smp 2 -m 512 \
	-nodefaults -no-user-config -display none -no-reboot \
	-serial "file:$log" \
	-kernel "$out/vmlinuz" -initrd "$out/smoke.cpio" \
	-append "console=$console panic=-1 quiet" \
	-drive "if=virtio,format=raw,readonly=on,file=$out/lz4.erofs" \
	-drive "if=virtio,format=raw,readonly=on,file=$out/zstd.erofs" \
	-device virtio-rtc-pci &
pid=$!
waited=0
while kill -0 "$pid" 2>/dev/null; do
	if [ "$waited" -ge "$timeout_s" ]; then
		kill "$pid"
		echo "$arch/$accel: guest did not power off within ${timeout_s}s" >&2
		break
	fi
	sleep 1
	waited=$((waited + 1))
done
wait "$pid" 2>/dev/null || true

# The serial console ends lines with CRLF.
tr -d '\r' <"$log" >"$log.txt"
grep '^cube-smoke:' "$log.txt" || true
if grep -qx 'cube-smoke: ok' "$log.txt"; then
	echo "$arch/$accel: ok (${waited}s)"
else
	echo "$arch/$accel: FAIL, full console in $log" >&2
	exit 1
fi
