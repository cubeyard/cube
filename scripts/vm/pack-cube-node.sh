#!/usr/bin/env bash
# Pack an exported incus unified tarball into the cube-node DISK
# (ext4, LABEL=cube-node) the base mounts read-only at /opt/cube-node.
#
#   bash scripts/vm/pack-cube-node.sh <exported-tarball>
#
# Split out of build-cube-node.sh because there are two ways to PRODUCE
# that tarball and only one way to pack it: the dev loop exports from
# the running VM's incus, while CI runs incus directly on the runner
# (system containers need namespaces, not nested virt — proven on both
# hosted runner types).
. "$(dirname "$0")/lib.sh"

TARBALL="${1:?usage: pack-cube-node.sh <exported-tarball>}"
[ -s "$TARBALL" ] || { fail "no such tarball (or empty): $TARBALL"; exit 1; }
command -v mke2fs >/dev/null 2>&1 || { fail "mke2fs (e2fsprogs) is required"; exit 1; }

STAGE="$(mktemp -d /tmp/cube-node.XXXXXX)"
trap 'rm -rf "$STAGE" "$STAGE.img"' EXIT
# The canonical name on the disk. incus import reads magic, not the
# extension, and the file's sha256 IS the incus fingerprint the base's
# import unit compares against.
cp "$TARBALL" "$STAGE/cube-node.tar.zst"
FP="$(sha256 "$STAGE/cube-node.tar.zst" | cut -d' ' -f1)"

log "pack (ext4 LABEL=cube-node -> qcow2)"
BYTES="$(file_size "$STAGE/cube-node.tar.zst")"
SIZE_MB=$(( BYTES / 1024 / 1024 * 12 / 10 + 64 ))
RAW="$STAGE.img"
rm -f "$RAW"
qemu-img create -q -f raw "$RAW" "${SIZE_MB}M"   # portable (no truncate on macOS)
mke2fs -q -F -t ext4 -L cube-node -d "$STAGE" "$RAW"
qemu-img convert -f raw -O qcow2 "$RAW" "$NODE_DISK.tmp"
mv "$NODE_DISK.tmp" "$NODE_DISK"
ok "cube-node disk: $NODE_DISK (fingerprint $FP)"
