#!/bin/sh
# Test stand-in for qemu-img: `create ... <disk> <size>` writes a tiny qcow2
# header and records its arguments next to the disk.
set -eu
[ "$1" = create ] || exit 2
for last; do :; done
disk=""
for arg; do
  [ "$arg" = "$last" ] && break
  disk="$arg"
done
[ ! -e "$(dirname "$0")/fail-create" ] || { echo "no space left on device" >&2; exit 1; }
printf 'QFI\373' > "$disk"
printf '%s\n' "$*" > "$disk.args"
