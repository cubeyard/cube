#!/bin/sh
# Builds keel's base root, base.erofs, for arm64 and x86-64 in the same pinned
# Debian container as the kernel: cube-init, cube-agent (packages/keel/agent,
# static musl, with the repository's pinned Rust) and static mke2fs, e2fsck
# and mkfs.erofs built from pinned sources. Also base-standin.erofs, the same
# root with the boot check's agent stand-in (init/agent-standin.c) in place of
# cube-agent: for scripts/keel-boot-check.ts only, never a keel asset.
# Usage: packages/keel/base/build.sh [arm64|x86_64 ...]
#        KEEL_CACHE=<dir> packages/keel/base/build.sh   # reuse a build
# Output: packages/keel/out/<arch>/{base.erofs,base.erofs.sha256,base.txt}
#         and base-standin.erofs{,.sha256}.
# shellcheck disable=SC2034,SC2154 # KEEL_CACHE's variables cross into cache.sh
set -eu

builder=debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5
source_date_epoch=1760000000
# name url sha256
sources='
lz4-1.10.0.tar.gz https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz 537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b
e2fsprogs-1.47.3.tar.xz https://cdn.kernel.org/pub/linux/kernel/people/tytso/e2fsprogs/v1.47.3/e2fsprogs-1.47.3.tar.xz 857e6ef800feaa2bb4578fbc810214be5d3c88b072ea53c5384733a965737329
erofs-utils-1.8.6.tar.gz https://git.kernel.org/pub/scm/linux/kernel/git/xiang/erofs-utils.git/snapshot/erofs-utils-1.8.6.tar.gz 5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547
'

# The Rust toolchain comes from rustup-init (pinned by version and sha256 per
# build host architecture) and installs rust-toolchain.toml's version.
rustup_version=1.28.2
rustup_x86_64=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
rustup_aarch64=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c

kc_here=$(cd "$(dirname "$0")" && pwd)
KEEL_CACHE_SCRIPT_DIR=$kc_here
export KEEL_CACHE_SCRIPT_DIR
root=$(cd "$kc_here/.." && pwd)
kc_out=$root/out
kc_cache=$root/.cache
repo=$(cd "$root/../.." && pwd)
rust=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/rust-toolchain.toml")
[ "$#" -gt 0 ] || set -- arm64 x86_64

# With KEEL_CACHE set, and only then, a build of these inputs (the base's C,
# the agent, its crates and the toolchain pins) that another clone has stored
# is used instead of building again; the key is the inputs' contents
# (cache.sh). Architectures that are not stored are built in one container,
# as before.
kc_cache_archs=
if [ -n "${KEEL_CACHE:-}" ]; then
	# shellcheck disable=SC1091 # sourced from beside this script
	. "$kc_here/../cache.sh"
	kc_key_line=$(KEEL_CACHE_SCRIPT_DIR=$kc_here \
		sh "$kc_here/../cache.sh" --keel-cache-key base "$@")
	case "$kc_key_line" in
	bypass:*)
		for kc_arch in "$@"; do
			keel_cache_setup base "$kc_arch"
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
		keel_cache_setup base "$kc_setup_arch"
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
				keel_cache_setup base "$kc_arch"
			fi
			keel_cache_blocked
			kc_cache_archs="$kc_cache_archs $kc_arch"
		done
		[ -n "$kc_cache_archs" ] || exit 0
		keel_cache_sources "$(echo "$sources" | sed -n 's/^\([^ ]*\) .*/\1/p')"
		;;
	esac
fi

# The builder image is digest-pinned above; with KEEL_CACHE set, keel_cache_
# image_mode records which digest built this cache.
keel_cache_builder=$builder
mkdir -p "$root/.cache"
echo "$sources" | while read -r name url sha256; do
	[ -n "$name" ] || continue
	file=$root/.cache/$name
	if [ -n "${keel_cache_filled:-}" ]; then
		# A miss: from the cache's src first, or fetched there through
		# .cache/<file>.part.$$, so no mount ever holds half a file.
		keel_cache_fetch_image "$name" "$url"
	elif [ ! -f "$file" ]; then
		curl -fL --proto '=https' -o "$file.part" "$url"
		mv "$file.part" "$file"
	fi
	actual=$(shasum -a 256 "$file" | cut -d' ' -f1)
	if [ "$actual" != "$sha256" ]; then
		echo "$name: sha256 $actual, expected $sha256" >&2
		exit 1
	fi
done

case "$(uname -m)" in
x86_64 | amd64) host_arch=x86_64; rustup_sha256=$rustup_x86_64 ;;
aarch64 | arm64) host_arch=aarch64; rustup_sha256=$rustup_aarch64 ;;
*) echo "no rustup-init for $(uname -m)" >&2; exit 1 ;;
esac
rustup_init=$root/.cache/rustup-init-$rustup_version-$host_arch
rustup_url="https://static.rust-lang.org/rustup/archive/$rustup_version/$host_arch-unknown-linux-gnu/rustup-init"
if [ -n "${keel_cache_filled:-}" ]; then
	keel_cache_fetch_image "$(basename "$rustup_init")" "$rustup_url"
elif [ ! -f "$rustup_init" ]; then
	curl -fL --proto '=https' -o "$rustup_init.part" "$rustup_url"
	mv "$rustup_init.part" "$rustup_init"
fi
actual=$(shasum -a 256 "$rustup_init" | cut -d' ' -f1)
if [ "$actual" != "$rustup_sha256" ]; then
	echo "rustup-init: sha256 $actual, expected $rustup_sha256" >&2
	exit 1
fi

# rustup downloads over HTTPS from the container: it trusts what this host
# trusts (a host behind a TLS-intercepting proxy adds its CA there).
host_ca=
for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
	if [ -f "$bundle" ]; then
		host_ca="-v $bundle:/etc/keel-host-ca.pem:ro -e SSL_CERT_FILE=/etc/keel-host-ca.pem"
		break
	fi
done

if [ -n "$kc_cache_archs" ]; then
	keel_cache_sources "$(basename "$rustup_init")" once
fi

# shellcheck disable=SC2086 # host_ca is empty or whole options
docker run --rm -e SOURCE_DATE_EPOCH="$source_date_epoch" $host_ca \
	-e RUSTUP_INIT="/keel/.cache/$(basename "$rustup_init")" -e RUST_VERSION="$rust" \
	-v "$root:/keel" -v "$repo:/src:ro" "$builder" sh -euc '
		apt-get update -qq >/dev/null
		case "$(uname -m)" in
		aarch64) cross=crossbuild-essential-amd64 ;;
		*) cross=crossbuild-essential-arm64 ;;
		esac
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
			build-essential "$cross" autoconf automake libtool pkg-config \
			xz-utils erofs-utils ca-certificates >/dev/null
		export RUSTUP_HOME=/tmp/rustup CARGO_HOME=/keel/.cache/cargo-home RUSTUP_TOOLCHAIN="$RUST_VERSION"
		export PATH="$CARGO_HOME/bin:$PATH"
		chmod +x "$RUSTUP_INIT"
		"$RUSTUP_INIT" -y -q --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" \
			--target x86_64-unknown-linux-musl,aarch64-unknown-linux-musl >/dev/null
		for arch in "$@"; do
			sh /keel/base/build-in-container.sh "$arch"
		done
	' sh "$@"

if [ -n "$kc_cache_archs" ]; then
	keel_cache_adopt
	keel_cache_builder_version=$rust
	keel_cache_extra="rustup-init $rustup_version"
	# The compiler line the task asks for: the toolchain is the image's apt
	# packages, which are not pinned, so the image and the packages are named.
	keel_cache_store "build-essential and both crossbuild-essential packages of $builder, rustup $rustup_version"
fi
