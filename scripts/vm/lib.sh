# Shared config + helpers for the cube VM dev loop. Source this: `. lib.sh`
#
# The VM boots FIVE virtio disks — base overlay (NixOS OS image built by
# build.sh via nix, never opened read-write itself), data (ZFS pool,
# persists forever), app overlay (cubed + node, LABEL=cubed, backed by
# build-app.sh's disk), cube-node (inner container image tarball,
# LABEL=cube-node, read-only, build-cube-node.sh) — plus a tiny seed
# carrying the only trusted ssh key. Base/app/cube-node are by-LABEL and
# versioned; only os+data positions are contractual (data-init needs
# /dev/vdb). The launcher (launcher/cube) boots the same shape.
set -euo pipefail

# Host portability: the dev loop runs on Linux (KVM) and macOS (HVF). The
# guest arch always FOLLOWS the host arch — hardware acceleration is
# required, and cross-arch TCG emulation is not a supported loop.
HOST_OS="$(uname -s)"                    # Linux | Darwin
case "$(uname -m)" in
  arm64|aarch64) GUEST_ARCH=arm64; QEMU_BIN=qemu-system-aarch64; NIX_SYSTEM=aarch64-linux ;;
  x86_64|amd64)  GUEST_ARCH=amd64; QEMU_BIN=qemu-system-x86_64;  NIX_SYSTEM=x86_64-linux ;;
  *) printf 'unsupported host arch: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

# All artifacts live OUTSIDE the repo — disks are multi-GB.
VM_DIR="${CUBE_VM_DIR:-$HOME/cube/vm}"
BUILD_DIR="${CUBE_VM_BUILD_DIR:-$VM_DIR/build}"

OS_DISK="$BUILD_DIR/cube-vm-base.qcow2"     # pristine base image — never booted
LIVE_DISK="$BUILD_DIR/cube-vm-live.qcow2"   # boot overlay backed by OS_DISK; all
                                            # runtime OS state (keys, host id) lives here
APP_DISK="$BUILD_DIR/cube-vm-app.qcow2"     # pristine ext4 LABEL=cubed: node + cubed (build-app.sh)
APP_LIVE="$BUILD_DIR/cube-vm-app-live.qcow2" # app overlay: syncs, chown, in-place updates land here
APP_TAR="$BUILD_DIR/cube-vm-app.tar.zst"    # the app tree alone, for in-place updates
NODE_DISK="$BUILD_DIR/cube-vm-node.qcow2"   # ext4 LABEL=cube-node: inner image tarball (read-only)
DATA_DISK="$BUILD_DIR/cube-vm-data.qcow2"   # ZFS pool device (persists across swaps)
RUN_SEED="$BUILD_DIR/seed.iso"              # boot-time seed (per-deploy trust; new name = the
                                            # CUBESEED format, never a stale cloud-init seed)
RUN_LOG="$BUILD_DIR/run-console.log"
SSH_KEY="$VM_DIR/id_ed25519"
KNOWN_HOSTS="$BUILD_DIR/known_hosts"        # TOFU; cleared with the live overlay
GUEST_BUILD_ID=/opt/cube/app/build-id       # the sentinel every identity check reads

DATA_DISK_SIZE="${CUBE_VM_DATA_SIZE:-40G}"  # thin qcow2; holds cubes' rootfs + volumes
VM_MEM="${CUBE_VM_MEM:-8G}"
VM_CPUS="${CUBE_VM_CPUS:-6}"
SSH_PORT="${CUBE_VM_SSH_PORT:-2222}"    # host 127.0.0.1:2222 -> VM :22 (loopback ALWAYS)
CUBED_PORT="${CUBE_VM_CUBED_PORT:-7777}" # host 127.0.0.1:7777 -> VM :7777

# Reaching the product from another machine. cubed has NO authentication
# (ARCHITECTURE §15: the Tailnet is the boundary), so this extra forward must land
# on a PRIVATE interface: pass CUBE_VM_BIND=tailscale (this node's 100.x
# address) or an explicit IP. Never a public address.
CUBE_VM_BIND="${CUBE_VM_BIND:-}"
if [ -z "$CUBE_VM_BIND" ]; then
  CUBE_VM_BIND="$(tailscale ip -4 2>/dev/null | head -1 || true)"
fi
if [ "$CUBE_VM_BIND" = "tailscale" ]; then
  CUBE_VM_BIND="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$CUBE_VM_BIND" ] || {
    printf 'CUBE_VM_BIND=tailscale but `tailscale ip -4` returned nothing\n' >&2
    exit 1
  }
fi
case "$CUBE_VM_BIND" in
  ""|127.0.0.1)
    CUBE_VM_BIND=""; CUBED_HOST="127.0.0.1" ;;
  0.0.0.0|"::"|"*")
    printf 'refusing CUBE_VM_BIND=%s — cubed is unauthenticated; bind a private address\n' "$CUBE_VM_BIND" >&2
    exit 1 ;;
  *)
    CUBED_HOST="$CUBE_VM_BIND" ;;
esac
CUBED_URL="http://$CUBED_HOST:$CUBED_PORT"

# The qemu -nic forward list: ssh stays on loopback; cubed additionally
# lands on CUBE_VM_BIND when one is configured. ipv6=off: slirp has no
# usable v6 route and dual-stack clients in the VM hang on v6-first
# (spike 03 finding).
vm_hostfwd() {
  local bind="${CUBE_VM_BIND:-}"
  local fwd="ipv6=off,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$CUBED_PORT-:7777"
  [ -n "$bind" ] && fwd="$fwd,hostfwd=tcp:$bind:$CUBED_PORT-:7777"
  printf '%s' "$fwd"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$BUILD_DIR"

log()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; }

# ---- host portability shims ------------------------------------------------
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  else shasum -a 256 "$@"; fi
}

file_size() {  # bytes on stdout; GNU stat vs BSD stat
  stat -c%s "$@" 2>/dev/null || stat -f%z "$@"
}

# vm_lock FD FILE [nonblock] / vm_unlock FD FILE. flock(1) where it exists
# (Linux); shlock (macOS) stores the holder's pid and treats a dead holder
# as stale. Callers MUST pair vm_unlock (or exit, for whole-script locks).
vm_lock() {
  local fd="$1" file="$2" mode="${3:-block}"
  if command -v flock >/dev/null 2>&1; then
    eval "exec $fd>\"\$file\""
    if [ "$mode" = nonblock ]; then flock -n "$fd"; else flock "$fd"; fi
  else
    while ! shlock -f "$file.pid" -p $$; do
      [ "$mode" = nonblock ] && return 1
      sleep 1
    done
  fi
}
vm_unlock() {
  local fd="$1" file="$2"
  if command -v flock >/dev/null 2>&1; then
    eval "exec $fd>&-"
  else
    rm -f "$file.pid"
  fi
}

# timeout(1) is coreutils; without it (stock macOS), a watchdog process
# TERM-then-KILLs at the deadline (an inherited SIGALRM is NOT enough:
# qemu blocks and swallows it — sol Medium, reproduced on qemu 8.2).
with_timeout() {  # with_timeout SECONDS CMD ARGS...
  if command -v timeout >/dev/null 2>&1; then
    timeout "$@"
  else
    local secs="$1" cmd_rc=0
    shift
    "$@" &
    local cmd_pid=$!
    ( sleep "$secs" && kill -TERM "$cmd_pid" 2>/dev/null \
        && sleep 10 && kill -KILL "$cmd_pid" 2>/dev/null ) &
    local dog_pid=$!
    wait "$cmd_pid" || cmd_rc=$?
    kill "$dog_pid" 2>/dev/null || true
    wait "$dog_pid" 2>/dev/null || true
    return "$cmd_rc"
  fi
}

# The seed ISO (label CUBESEED). genisoimage/xorrisofs/mkisofs on Linux;
# hdiutil on macOS. Written to a temp name and mv'd — a crashed tool can't
# leave a partial seed that later boots accept. Names on it must be
# single-dot/lowercase-stable: hdiutil's Joliet tree is not honoured by
# the guest kernel, which falls back to plain ISO9660 names.
make_iso() {  # make_iso OUTPUT DIR
  local out="$1" dir="$2" tool
  rm -f "$out.tmp" "$out.tmp.iso"
  for tool in genisoimage xorrisofs mkisofs; do
    if command -v "$tool" >/dev/null 2>&1; then
      "$tool" -quiet -output "$out.tmp" -volid CUBESEED -joliet -rock \
        -input-charset utf-8 "$dir"
      mv "$out.tmp" "$out"
      return 0
    fi
  done
  if command -v hdiutil >/dev/null 2>&1; then
    hdiutil makehybrid -quiet -iso -joliet -default-volume-name CUBESEED \
      -o "$out.tmp" "$dir"
    mv "$out.tmp.iso" "$out"
    return 0
  fi
  fail "no ISO tool found (genisoimage/xorrisofs/mkisofs/hdiutil)"
  return 1
}

qemu_firmware() {  # UEFI code image for THIS arch, wherever the host keeps it
  local f
  case "$GUEST_ARCH" in
    arm64) set -- edk2-aarch64-code.fd AAVMF_CODE.fd QEMU_EFI.fd ;;
    *)     set -- edk2-x86_64-code.fd OVMF_CODE_4M.fd OVMF_CODE.fd ;;
  esac
  local qemu_share
  qemu_share="$(cd "$(dirname "$(command -v "$QEMU_BIN")")/.." && pwd)/share/qemu"
  for name in "$@"; do
    for f in "$qemu_share/$name" \
             "/usr/share/qemu/$name" \
             "/usr/share/OVMF/$name" \
             "/usr/share/AAVMF/$name" \
             "/usr/share/edk2/x64/$name" \
             "/usr/share/edk2/aarch64/$name"; do
      [ -f "$f" ] && { printf '%s' "$f"; return 0; }
    done
  done
  return 1
}

# UEFI variable store, paired BY ARCH with the code image: brew's qemu
# ships edk2-i386-vars.fd (528 KiB, for x86) next to edk2-arm-vars.fd
# (64 MiB, for aarch64), and an arch-blind search once handed the
# arm64 `virt` machine the x86 file — "cfi.pflash01 device requires
# 67108864 bytes, block backend provides 540672" (found on the Mac,
# 2026-09-03). The image boots the REMOVABLE path, so nothing must
# survive in NVRAM: a fresh copy per boot is fine.
qemu_vars_template() {  # qemu_vars_template CODE_FILE
  local f code_dir
  code_dir="$(dirname "$1")"
  case "$GUEST_ARCH" in
    arm64) set -- "$code_dir/edk2-arm-vars.fd" "$code_dir/AAVMF_VARS.fd" "/usr/share/AAVMF/AAVMF_VARS.fd" ;;
    *)     set -- "$code_dir/edk2-i386-vars.fd" "$code_dir/OVMF_VARS_4M.fd" "$code_dir/OVMF_VARS.fd" ;;
  esac
  for f in "$@"; do
    [ -f "$f" ] && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# The arm64 `virt` machine wants BOTH flash devices to be exactly 64 MiB
# (qemu refuses anything else); distros ship edk2 aarch64 images at
# 64 MiB or as 2 MiB QEMU_EFI.fd. Pad private copies rather than
# depend on which one the host has. x86 firmware is sized by the file.
prepare_uefi() {  # prepare_uefi DIR -> UEFI_CODE, UEFI_VARS
  local fw
  fw="$(qemu_firmware)" || return 1
  UEFI_VARS="$1/uefi-vars.fd"
  cp -f "$(qemu_vars_template "$fw")" "$UEFI_VARS" 2>/dev/null \
    || { fail "no UEFI VARS template beside $fw"; return 1; }
  chmod u+w "$UEFI_VARS"
  UEFI_CODE="$fw"
  if [ "$GUEST_ARCH" = arm64 ]; then
    UEFI_CODE="$1/uefi-code.fd"
    cp -f "$fw" "$UEFI_CODE"; chmod u+w "$UEFI_CODE"
    qemu-img resize -q -f raw "$UEFI_CODE" 64M
    qemu-img resize -q -f raw "$UEFI_VARS" 64M
  fi
}

# BOTH arches boot UEFI now (the repart image ships systemd-boot in an
# ESP; x86 no longer has a BIOS path), so this is one code path with an
# arch-specific machine type. VARS is a throwaway copy in $BUILD_DIR.
vm_boot_args() {
  local accel
  command -v "$QEMU_BIN" >/dev/null 2>&1 \
    || { fail "$QEMU_BIN not found — install qemu (brew install qemu / apt install qemu-system)"; return 1; }
  case "$HOST_OS" in
    Linux)
      [ -w /dev/kvm ] \
        || { fail "/dev/kvm missing or not writable — KVM is required (TCG is not a supported loop)"; return 1; }
      accel=kvm ;;
    Darwin) accel=hvf ;;
    *) fail "unsupported host OS: $HOST_OS"; return 1 ;;
  esac
  qemu_firmware >/dev/null || {
    fail "no UEFI firmware for $GUEST_ARCH near $QEMU_BIN (Linux: apt install ovmf; macOS: brew install qemu)"
    return 1
  }
  prepare_uefi "$BUILD_DIR" || return 1
  VM_BOOT_ARGS=(
    -machine "$([ "$GUEST_ARCH" = arm64 ] && echo virt || echo q35),accel=$accel"
    -cpu host -m "$VM_MEM" -smp "$VM_CPUS" -device virtio-rng-pci
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=$UEFI_CODE"
    -drive "if=pflash,format=raw,unit=1,file=$UEFI_VARS"
  )
}

# The full drive list: os+data positions are contractual (vda/vdb —
# data-init expects the data disk at /dev/vdb), app and cube-node ride
# after and are found by LABEL, the seed comes last. The app rides on its
# overlay (the pristine disk is what package-release ships, so nothing a
# boot writes — ext4 journal, chown, syncs — may reach it); cube-node is
# read-only outright. One form for both arches (UEFI everywhere): the
# arm64 virt machine has no IDE bus, so the seed is a read-only virtio
# disk, found by LABEL.
vm_disk_args() {  # vm_disk_args SEED_ISO -> VM_DISK_ARGS
  VM_DISK_ARGS=(
    -drive "if=virtio,file=$LIVE_DISK,format=qcow2,discard=unmap"
    -drive "if=virtio,file=$DATA_DISK,format=qcow2,discard=unmap"
    -drive "if=virtio,file=$APP_LIVE,format=qcow2,discard=unmap"
  )
  # cube-node is optional: without it the product runs but threads can't
  # provision (the import unit conditions on the tarball path).
  [ -f "$NODE_DISK" ] && VM_DISK_ARGS+=(
    -drive "if=virtio,file=$NODE_DISK,format=qcow2,readonly=on"
  )
  VM_DISK_ARGS+=(-drive "if=virtio,format=raw,readonly=on,file=$1")
}

# ssh-keygen under a lock: two fresh runs doing `[ -f ] || ssh-keygen` can
# interleave into a mismatched pair.
ensure_ssh_key() {
  [ -f "$SSH_KEY" ] && return 0
  (
    vm_lock 5 "$VM_DIR/.key-lock"
    [ -f "$SSH_KEY" ] || ssh-keygen -q -t ed25519 -N "" -C cube-vm -f "$SSH_KEY"
    vm_unlock 5 "$VM_DIR/.key-lock"
  )
}

vm_ssh() {
  ssh -p "$SSH_PORT" -i "$SSH_KEY" \
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$KNOWN_HOSTS" \
    -o BatchMode=yes -o LogLevel=ERROR -o ConnectTimeout=5 \
    cube@127.0.0.1 "$@"
}

# The build the VM on the ssh port reports (empty when none answers).
vm_build_id() { vm_ssh "cat $GUEST_BUILD_ID 2>/dev/null" 2>/dev/null || true; }

# PIDs of every qemu holding this build's disks — matched on the
# $BUILD_DIR/cube-vm prefix. ps(1) instead of pgrep -a: macOS pgrep can't
# print the command line. The [q] bracket keeps the awk process itself
# from matching.
vm_pids() {
  ps axww -o pid= -o command= \
    | awk -v pat="[q]emu-system-[^ ]* .*$BUILD_DIR/cube-vm" '$0 ~ pat {print $1}' || true
}

# A live overlay WITHOUT its data disk is a broken pair, not a fresh
# install: creating a blank one boots an OS whose incus registry points
# at instances that no longer exist, and the product comes up EMPTY —
# indistinguishable from data loss (sol #3; the launcher has had this
# guard, the dev loop had not). A fresh install has neither file.
ensure_data_disk() {
  if [ -f "$LIVE_DISK" ] && [ ! -f "$DATA_DISK" ]; then
    fail "$LIVE_DISK exists but $DATA_DISK is missing — restore the data disk, or remove the live overlay to accept starting over"
    return 1
  fi
  [ -f "$DATA_DISK" ] || qemu-img create -q -f qcow2 "$DATA_DISK" "$DATA_DISK_SIZE"
}

# Pristine disks are NEVER attached read-write (a booted disk accumulates
# keys/machine-id/journal and stops being distributable). Boots run on
# qcow2 overlays backed by them; build.sh / build-app.sh remove the
# overlay together with the disk they replace.
ensure_live_disk() {
  [ -f "$LIVE_DISK" ] || \
    qemu-img create -q -f qcow2 -b "$OS_DISK" -F qcow2 "$LIVE_DISK"
}
ensure_app_overlay() {
  [ -f "$APP_LIVE" ] || \
    qemu-img create -q -f qcow2 -b "$APP_DISK" -F qcow2 "$APP_LIVE"
}

# The image carries no trust: whoever boots it supplies a seed disk
# (LABEL=CUBESEED) holding `authorized_keys` for the `cube` user. The
# base's cube-seed unit installs it on EVERY boot as an exact replace, so
# rotating the key revokes the old one; no cloud-init, no instance-id.
# Host keys belong to the base overlay (generated by sshd on its first
# boot), so a new seed never invalidates known_hosts.
make_run_seed() {
  ensure_ssh_key
  # Rebuild each boot: the host's address or forwarded port may have changed.
  local dir
  dir="$(mktemp -d)"
  cp "$SSH_KEY.pub" "$dir/authorized_keys"
  printf 'CUBED_PORTAL_BASE=%s\nCUBED_PUBLIC_PORT=%s\n' \
    "${CUBED_PORTAL_BASE:-${CUBED_HOST//:/-}.sslip.io}" "$CUBED_PORT" > "$dir/portal.env"
  make_iso "$RUN_SEED" "$dir"
  rm -rf "$dir"
}
