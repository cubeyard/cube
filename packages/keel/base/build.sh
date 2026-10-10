#!/bin/sh
# Builds keel's base root, base.erofs, for arm64 and x86-64 in the same pinned
# Debian container as the kernel: cube-init, the agent (for now the boot
# check's stand-in, init/agent-standin.c, until cube-agent exists) and static
# mke2fs, e2fsck and mkfs.erofs built from pinned sources.
# Usage: packages/keel/base/build.sh [arm64|x86_64 ...]
# Output: packages/keel/out/<arch>/{base.erofs,base.erofs.sha256,base.txt}.
set -eu

builder=debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
source_date_epoch=1760000000
# name url sha256
sources='
lz4-1.10.0.tar.gz https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz 537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b
e2fsprogs-1.47.3.tar.xz https://cdn.kernel.org/pub/linux/kernel/people/tytso/e2fsprogs/v1.47.3/e2fsprogs-1.47.3.tar.xz 857e6ef800feaa2bb4578fbc810214be5d3c88b072ea53c5384733a965737329
erofs-utils-1.8.6.tar.gz https://git.kernel.org/pub/scm/linux/kernel/git/xiang/erofs-utils.git/snapshot/erofs-utils-1.8.6.tar.gz 5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547
'

root=$(cd "$(dirname "$0")/.." && pwd)
[ "$#" -gt 0 ] || set -- arm64 x86_64

mkdir -p "$root/.cache"
echo "$sources" | while read -r name url sha256; do
	[ -n "$name" ] || continue
	file=$root/.cache/$name
	if [ ! -f "$file" ]; then
		curl -fL --proto '=https' -o "$file.part" "$url"
		mv "$file.part" "$file"
	fi
	actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
	if [ "$actual" != "$sha256" ]; then
		echo "$name: sha256 $actual, expected $sha256" >&2
		exit 1
	fi
done

docker run --rm -e SOURCE_DATE_EPOCH="$source_date_epoch" \
	-v "$root:/keel" "$builder" sh -euc '
		apt-get update -qq >/dev/null
		case "$(uname -m)" in
		aarch64) cross=crossbuild-essential-amd64 ;;
		*) cross=crossbuild-essential-arm64 ;;
		esac
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
			build-essential "$cross" autoconf automake libtool pkg-config \
			xz-utils erofs-utils >/dev/null
		for arch in "$@"; do
			sh /keel/base/build-in-container.sh "$arch"
		done
	' sh "$@"
