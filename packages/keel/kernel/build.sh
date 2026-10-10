#!/bin/sh
# Builds cube's guest kernels (arm64 and x86-64) in a pinned Debian container.
# Usage: packages/keel/kernel/build.sh [arm64|x86_64 ...]
# Output: packages/keel/out/<arch>/{vmlinuz,config,vmlinuz.sha256}; the
# resolved config is also written to kernel/config-<version>-<arch> so a
# version or fragment change shows up in review.
set -eu

version=7.2.9
sha256=b4c5dfbe51a364a6c7f03869200f88c8e1f77403539005f14b7fc6bc91b8d8ba
builder=debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
# Fixed build time for reproducible kernels: the version's tarball date
# is not used, so rebuilding the same inputs gives the same image.
source_date_epoch=1760000000

root=$(cd "$(dirname "$0")/.." && pwd)
tarball=$root/.cache/linux-$version.tar.xz
[ "$#" -gt 0 ] || set -- arm64 x86_64

mkdir -p "$root/.cache"
if [ ! -f "$tarball" ]; then
	major=${version%%.*}
	curl -fL --proto '=https' -o "$tarball.part" \
		"https://cdn.kernel.org/pub/linux/kernel/v$major.x/linux-$version.tar.xz"
	mv "$tarball.part" "$tarball"
fi
actual=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
	echo "linux-$version.tar.xz: sha256 $actual, expected $sha256" >&2
	exit 1
fi

docker run --rm -e SOURCE_DATE_EPOCH="$source_date_epoch" \
	-v "$root:/keel" "$builder" sh -euc '
		apt-get update -qq >/dev/null
		case "$(uname -m)" in
		aarch64) cross=crossbuild-essential-amd64 ;;
		*) cross=crossbuild-essential-arm64 ;;
		esac
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
			build-essential "$cross" bc bison flex libelf-dev libssl-dev \
			xz-utils cpio python3 >/dev/null
		for arch in "$@"; do
			sh /keel/kernel/build-in-container.sh "$arch" "'"$version"'"
		done
	' sh "$@"
