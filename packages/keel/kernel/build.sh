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

# pwd -P: the key and the cache must not depend on how the path was spelled.
kc_here=$(cd "$(dirname "$0")" && pwd -P)
KEEL_CACHE_SCRIPT_DIR=$kc_here
export KEEL_CACHE_SCRIPT_DIR
root=$(cd "$kc_here/.." && pwd -P)
kc_out=$root/out
kc_cache=$root/.cache
tarball=$root/.cache/linux-$version.tar.xz
[ "$#" -gt 0 ] || set -- arm64 x86_64

# With KEEL_CACHE set, and only then, a build of these inputs that another
# clone has already stored is used instead of building again; the key is the
# inputs' contents (cache.sh). Each architecture is looked up by itself: the
# ones that hit are copied out, and only the ones that miss are built, in one
# container, as before, then stored one by one.
kc_cache_archs=
kc_bypassed=
if [ -n "${KEEL_CACHE:-}" ]; then
	# shellcheck disable=SC1091 # sourced from beside this script
	. "$kc_here/../cache.sh"
	# Once, before any setup: a relative KEEL_CACHE means the directory the
	# build was started in.
	keel_cache_resolve
	for kc_arch in "$@"; do
		keel_cache_setup kernel "$kc_arch"
		case "$keel_cache_mode" in
		off) ;;
		hit)
			keel_cache_read "$kc_arch"
			echo "$kc_arch: keel cache hit $keel_cache_key $kc_hashes"
			;;
		miss)
			keel_cache_blocked
			kc_cache_archs="$kc_cache_archs $kc_arch"
			;;
		bypass)
			keel_cache_blocked
			kc_bypassed="$kc_bypassed $kc_arch"
			;;
		esac
	done
	if [ -n "$kc_bypassed" ]; then
		# One architecture was bypassed: every one of them is built exactly
		# as before, and nothing is stored.
		kc_cache_archs=
	elif [ -z "$kc_cache_archs" ]; then
		# Every architecture hit.
		exit 0
	else
		keel_cache_sources "linux-$version.tar.xz"
	fi
	kc_cache_archs=${kc_cache_archs# }
fi

# Only the architectures that are not stored are built, in one container.
if [ -n "$kc_cache_archs" ]; then
	# shellcheck disable=SC2086 # the architectures to build, one per word
	set -- $kc_cache_archs
fi

keel_cache_builder=$builder
mkdir -p "$root/.cache"
major=${version%%.*}
tarball_url="https://cdn.kernel.org/pub/linux/kernel/v$major.x/linux-$version.tar.xz"
if [ ! -f "$tarball" ]; then
	# A miss: the tarball comes from the cache's src first, or is fetched there
	# through .cache/<file>.part.$$, so no mount ever holds half a file.
	if [ -n "$kc_cache_archs" ]; then
		keel_cache_fetch_image "$(basename "$tarball")" "$tarball_url"
	else
		curl -fL --proto '=https' -o "$tarball.part" "$tarball_url"
		mv "$tarball.part" "$tarball"
	fi
fi
actual=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
	echo "linux-$version.tar.xz: sha256 $actual, expected $sha256" >&2
	exit 1
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
	# Each built architecture is set up and stored by itself: the one whose
	# key and entry the store writes.
	for kc_arch in $kc_cache_archs; do
		keel_cache_setup kernel "$kc_arch"
		# The compiler line the task asks for: the toolchain is the image's
		# apt packages, which are not pinned, so the image and the packages
		# are named.
		keel_cache_store "build-essential and both crossbuild-essential packages of $builder"
	done
fi
