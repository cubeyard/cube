#!/bin/sh
# Builds the smoke-test initramfs and EROFS layers for both architectures in
# the same pinned Debian container as the kernel.
# Output: packages/vm-base/out/<arch>/{smoke.cpio,tick.cpio,lz4.erofs,zstd.erofs}
# (tick.cpio is the snapshot test's init, see snapshot/test.py)
set -eu

builder=debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
root=$(cd "$(dirname "$0")/.." && pwd)
[ "$#" -gt 0 ] || set -- arm64 x86_64

docker run --rm -v "$root:/vm-base" "$builder" sh -euc '
	apt-get update -qq >/dev/null
	case "$(uname -m)" in
	aarch64) cross=crossbuild-essential-amd64 ;;
	*) cross=crossbuild-essential-arm64 ;;
	esac
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
		build-essential "$cross" cpio erofs-utils >/dev/null
	t=/tmp/layers
	mkdir -p $t/lz4 $t/zstd
	echo lz4 >$t/lz4/layer; echo lz4 >$t/lz4/only-lz4
	echo zstd >$t/zstd/layer
	for arch in "$@"; do
		out=/vm-base/out/$arch
		mkdir -p $out
		case "$arch:$(uname -m)" in
		arm64:aarch64 | x86_64:x86_64) cc=gcc ;;
		arm64:*) cc=aarch64-linux-gnu-gcc ;;
		x86_64:*) cc=x86_64-linux-gnu-gcc ;;
		esac
		r=/tmp/initramfs-$arch
		rm -rf $r && mkdir -p $r
		$cc -static -O2 -o $r/init /vm-base/smoke/init.c
		(cd $r && find . | cpio -o -H newc --quiet) >$out/smoke.cpio
		$cc -static -O2 -o $r/init /vm-base/snapshot/tick.c
		(cd $r && find . | cpio -o -H newc --quiet) >$out/tick.cpio
		mkfs.erofs --quiet -b4096 -zlz4hc -T0 --all-time $out/lz4.erofs $t/lz4
		mkfs.erofs --quiet -b4096 -zzstd -T0 --all-time $out/zstd.erofs $t/zstd
		echo "$arch: smoke initramfs and layers built"
	done
' sh "$@"
