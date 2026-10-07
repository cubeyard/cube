#!/bin/sh
# Test stand-in for qemu-img: `create ... -b <backing> <disk> <size>` writes a
# qcow2 header naming the backing file and records its arguments next to the disk.
set -eu
[ "$1" = create ] || exit 2
for last; do :; done
disk=""
for arg; do
  [ "$arg" = "$last" ] && break
  disk="$arg"
done
[ ! -e "$(dirname "$0")/fail-create" ] || { echo "no space left on device" >&2; exit 1; }
[ ! -e "$(dirname "$0")/slow-create" ] || sleep "$(cat "$(dirname "$0")/slow-create")"
backing=""
previous=""
for arg; do
  [ "$previous" != -b ] || backing="$arg"
  previous="$arg"
done
# A qcow2 version 3 header: backing file name at offset 512, virtual size.
python3 - "$disk" "$backing" "$last" <<'PY'
import struct, sys
disk, backing, size = sys.argv[1], sys.argv[2].encode(), sys.argv[3]
header = bytearray(1024)
header[:8] = b"QFI\xfb" + struct.pack(">I", 3)
if backing:
    header[8:20] = struct.pack(">QI", 512, len(backing))
    header[512:512 + len(backing)] = backing
header[24:32] = struct.pack(">Q", int(size.rstrip("G")) << 30)
open(disk, "wb").write(header)
PY
printf '%s\n' "$*" > "$disk.args"
