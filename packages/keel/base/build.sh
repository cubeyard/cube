#!/bin/sh
# Builds keel's base root, base.erofs, for arm64 and x86-64 in the same pinned
# Debian container as the kernel: cube-init, cube-agent (packages/keel/agent,
# static musl, with the repository's pinned Rust) and static mke2fs, e2fsck
# and mkfs.erofs built from pinned sources. Also base-standin.erofs, the same
# root with the boot check's agent stand-in (init/agent-standin.c) in place of
# cube-agent: for scripts/keel-boot-check.ts only, never a keel asset.
# Usage: packages/keel/base/build.sh [arm64|x86_64 ...]
# Output: packages/keel/out/<arch>/{base.erofs,base.erofs.sha256,base.txt}
#         and base-standin.erofs{,.sha256}.
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

root=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$root/../.." && pwd)
rust=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$repo/rust-toolchain.toml")
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

case "$(uname -m)" in
x86_64 | amd64) host_arch=x86_64; rustup_sha256=$rustup_x86_64 ;;
aarch64 | arm64) host_arch=aarch64; rustup_sha256=$rustup_aarch64 ;;
*) echo "no rustup-init for $(uname -m)" >&2; exit 1 ;;
esac
rustup_init=$root/.cache/rustup-init-$rustup_version-$host_arch
if [ ! -f "$rustup_init" ]; then
	curl -fL --proto '=https' -o "$rustup_init.part" \
		"https://static.rust-lang.org/rustup/archive/$rustup_version/$host_arch-unknown-linux-gnu/rustup-init"
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
