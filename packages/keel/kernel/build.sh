#!/bin/sh
# Builds keel's guest kernels (arm64 and x86-64) in a pinned Debian container
# from kernel/defconfig-<arch>.
# Usage: packages/keel/kernel/build.sh [arm64|x86_64 ...]
#        KEEL_REFRESH=1 packages/keel/kernel/build.sh   # after a version bump
#        KEEL_CACHE=<dir> packages/keel/kernel/build.sh # reuse a build
# Output: packages/keel/out/<arch>/{vmlinuz,config,vmlinuz.sha256}.
# shellcheck disable=SC2034,SC2154 # KEEL_CACHE's variables cross into cache.sh
set -eu

version=7.2.9
sha256=b4c5dfbe51a364a6c7f03869200f88c8e1f77403539005f14b7fc6bc91b8d8ba
builder=debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
# Fixed build time for reproducible kernels: the version's tarball date
# is not used, so rebuilding the same inputs gives the same image.
source_date_epoch=1760000000

kc_here=$(cd "$(dirname "$0")" && pwd)
KEEL_CACHE_SCRIPT_DIR=$kc_here
export KEEL_CACHE_SCRIPT_DIR
root=$(cd "$kc_here/.." && pwd)
kc_out=$root/out
kc_cache=$root/.cache
tarball=$root/.cache/linux-$version.tar.xz
[ "$#" -gt 0 ] || set -- arm64 x86_64

# With KEEL_CACHE set, and only then, a build of these inputs that another
# clone has already stored is used instead of building again; the key is the
# inputs' contents (cache.sh). Architectures that are not stored are built in
# one container, as before.
kc_cache_archs=
if [ -n "${KEEL_CACHE:-}" ]; then
	# shellcheck disable=SC1091 # sourced from beside this script
	. "$kc_here/../cache.sh"
	kc_key_line=$(KEEL_CACHE_SCRIPT_DIR=$kc_here \
		sh "$kc_here/../cache.sh" --keel-cache-key kernel "$@")
	case "$kc_key_line" in
	bypass:*)
		for kc_arch in "$@"; do
			keel_cache_setup kernel "$kc_arch"
			keel_cache_blocked
		done
		;;
	*)
		# The architecture keyed above, then the arguments as they were.
		kc_args=$*
		# shellcheck disable=SC2086 # the line is "kind arch key"
		set -- $kc_key_line
		kc_setup_arch=$2
		# shellcheck disable=SC2086 # the script's own arguments
		set -- $kc_args
		keel_cache_setup kernel "$kc_setup_arch"
		for kc_arch in "$@"; do
			# The key computation just ran for $kc_setup_arch, so only the
			# other architectures ask cache.sh again.
			if [ "$kc_arch" = "$keel_cache_arch" ]; then
				if [ "$keel_cache_mode" = hit ]; then
					kc_cache_hashes=$(keel_cache_read)
					echo "$keel_cache_arch: keel cache hit $keel_cache_key $kc_cache_hashes"
					continue
				fi
			else
				keel_cache_setup kernel "$kc_arch"
			fi
			keel_cache_blocked
			kc_cache_archs="$kc_cache_archs $kc_arch"
		done
		[ -n "$kc_cache_archs" ] || exit 0
		keel_cache_sources "linux-$version.tar.xz"
		;;
	esac
fi

# The builder image is digest-pinned above; with KEEL_CACHE set, keel_cache_
# image_mode records which digest built this cache.
keel_cache_builder=$builder
mkdir -p "$root/.cache"
major=${version%%.*}
tarball_url="https://cdn.kernel.org/pub/linux/kernel/v$major.x/linux-$version.tar.xz"
if [ -n "${keel_cache_filled:-}" ]; then
	# A miss: the tarball comes from the cache's src first, or is fetched there
	# through .cache/<file>.part.$$, so no mount ever holds half a file.
	keel_cache_fetch_image "$(basename "$tarball")" "$tarball_url"
elif [ ! -f "$tarball" ]; then
	curl -fL --proto '=https' -o "$tarball.part" "$tarball_url"
	mv "$tarball.part" "$tarball"
fi
actual=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
	echo "linux-$version.tar.xz: sha256 $actual, expected $sha256" >&2
	exit 1
fi

if [ -n "$kc_cache_archs" ]; then
	# shellcheck disable=SC2086 # the architectures to build, one per word
	set -- $kc_cache_archs
fi
docker run --rm -e SOURCE_DATE_EPOCH="$source_date_epoch" -e KEEL_REFRESH="${KEEL_REFRESH:-0}" \
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

if [ -n "$kc_cache_archs" ]; then
	keel_cache_adopt
	keel_cache_builder_version=$version
	keel_cache_extra=$(printf 'kernel %s %s' "$version" "$sha256")
	# The compiler line the task asks for: the toolchain is the image's apt
	# packages, which are not pinned, so the image and the packages are named.
	keel_cache_store "build-essential and both crossbuild-essential packages of $builder"
fi
