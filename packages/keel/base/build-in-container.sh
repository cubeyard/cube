#!/bin/sh
# Builds base.erofs for one architecture. Runs inside the pinned Debian
# container started by build.sh, with packages/keel mounted at /keel, the
# verified source tarballs in /keel/.cache, the repository read-only at /src
# and Rust installed (RUSTUP_HOME, CARGO_HOME, RUSTUP_TOOLCHAIN).
set -eu
# One collation for every sort below (the tree listing, the UUID input).
export LC_ALL=C

arch=$1 # arm64 | x86_64
out=/keel/out/$arch

case "$arch" in
arm64) host=aarch64-linux-gnu; rust_target=aarch64-unknown-linux-musl ;;
x86_64) host=x86_64-linux-gnu; rust_target=x86_64-unknown-linux-musl ;;
*) echo "unknown architecture $arch" >&2; exit 2 ;;
esac
cc=$host-gcc
strip=$host-strip

work=/tmp/base-$arch
prefix=$work/prefix
tree=$work/root
rm -rf "$work"
mkdir -p "$work" "$prefix/include" "$prefix/lib" "$tree" "$out"
# No build paths or dates in the binaries, so the same inputs give the same base.
cflags="-O2 -ffile-prefix-map=$work=. -ffile-prefix-map=/keel=keel"
log=$work/build.log

build() {
	"$@" >>"$log" 2>&1 || {
		tail -40 "$log" >&2
		exit 1
	}
}

cd "$work"
for f in lz4-1.10.0.tar.gz e2fsprogs-1.47.3.tar.xz erofs-utils-1.8.6.tar.gz; do
	tar -xf "/keel/.cache/$f"
done

# lz4, static, for mkfs.erofs's lz4hc.
build make -C lz4-1.10.0/lib CC="$cc" CFLAGS="$cflags" liblz4.a
cp lz4-1.10.0/lib/liblz4.a "$prefix/lib/"
cp lz4-1.10.0/lib/lz4.h lz4-1.10.0/lib/lz4hc.h "$prefix/include/"

# mke2fs and e2fsck, with e2fsprogs' own libuuid and libblkid.
cd "$work/e2fsprogs-1.47.3"
build ./configure --host="$host" CC="$cc" CFLAGS="$cflags" LDFLAGS=-static \
	--disable-nls --disable-fuse2fs --disable-debugfs --disable-imager \
	--disable-resizer --disable-defrag --disable-uuidd --disable-e2initrd-helper \
	--disable-tdb --disable-elf-shlibs --enable-libuuid --enable-libblkid \
	--without-libarchive --without-systemd --without-udev
build make -j"$(nproc)" libs
build make -j"$(nproc)" -C misc mke2fs
build make -j"$(nproc)" -C e2fsck e2fsck

# mkfs.erofs with lz4 and lz4hc only.
cd "$work/erofs-utils-1.8.6"
build ./autogen.sh
build ./configure --host="$host" CC="$cc" CFLAGS="$cflags" LDFLAGS=-static \
	liblz4_CFLAGS="-I$prefix/include" liblz4_LIBS="-L$prefix/lib -llz4" \
	--enable-lz4 --disable-lzma --disable-fuse --without-libdeflate --without-libzstd \
	--without-qpl --without-selinux --without-uuid --without-zlib --without-xxhash
build make -j"$(nproc)" -C lib
# libtool links a static program only with -all-static.
build make -j"$(nproc)" -C mkfs LDFLAGS=-all-static

# cube-init, cube-agent and the boot check's stand-in.
cd "$work"
build "$cc" $cflags -static -Wall -Wextra -o cube-init /keel/init/cube-init.c
build "$cc" $cflags -static -Wall -Wextra -o agent-standin /keel/init/agent-standin.c
# Static musl, linked by the toolchain's rust-lld (no C cross linker), with
# no build paths in the binary.
build env CARGO_TARGET_DIR=/keel/.cache/cargo-target \
	RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static --remap-path-prefix=/src=cube --remap-path-prefix=$CARGO_HOME=cargo" \
	cargo build --quiet --locked --release --manifest-path /src/Cargo.toml -p cube-agent --target "$rust_target"
cp "/keel/.cache/cargo-target/$rust_target/release/cube-agent" cube-agent

mkdir -p "$tree/sbin" "$tree/etc"
for d in proc sys dev run tmp; do mkdir -p "$tree/$d"; done
cp cube-init cube-agent "$tree/sbin/"
cp e2fsprogs-1.47.3/misc/mke2fs e2fsprogs-1.47.3/e2fsck/e2fsck "$tree/sbin/"
cp erofs-utils-1.8.6/mkfs/mkfs.erofs "$tree/sbin/"
"$strip" "$tree"/sbin/*
for f in "$tree"/sbin/*; do
	if "$host-readelf" -l "$f" | grep -q INTERP; then
		echo "$f is not static" >&2
		exit 1
	fi
done
ln -s ../proc/self/mounts "$tree/etc/mtab"
chmod 0755 "$tree"/sbin/*
find "$tree" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# The EROFS UUID comes from the contents, so the same tree gives the same image.
image() {
	uuid=$(cd "$tree" && find . -type f | sort | xargs sha256sum | sha256sum |
		sed -E 's/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/\1-\2-4\3-8\4-\5/')
	mkfs.erofs --quiet -b4096 -zlz4hc -T"$SOURCE_DATE_EPOCH" --all-root -U "$uuid" \
		"$out/$1" "$tree"
	sha256sum "$out/$1" | cut -d' ' -f1 >"$out/$1.sha256"
}
# The boot check's root first (the stand-in as /sbin/cube-agent), then the base.
if "$host-readelf" -l agent-standin | grep -q INTERP; then
	echo "agent-standin is not static" >&2
	exit 1
fi
"$strip" -o "$tree/sbin/cube-agent" agent-standin
chmod 0755 "$tree/sbin/cube-agent"
touch -h -d "@$SOURCE_DATE_EPOCH" "$tree/sbin/cube-agent"
image base-standin.erofs
"$strip" -o "$tree/sbin/cube-agent" cube-agent
chmod 0755 "$tree/sbin/cube-agent"
touch -h -d "@$SOURCE_DATE_EPOCH" "$tree/sbin/cube-agent"
image base.erofs
{
	echo "keel base for $arch"
	echo "built with $(mkfs.erofs --version 2>&1 | head -1), $("$cc" --version | head -1)"
	echo "sources: lz4 1.10.0, e2fsprogs 1.47.3, erofs-utils 1.8.6; cube-agent with $(rustc --version)"
	(cd "$tree" && find . -type f | sort | xargs sha256sum)
	(cd "$tree" && find . ! -type f -printf '%y %p %l\n' | sort -k2)
} >"$out/base.txt"
echo "$arch: base.erofs $(cat "$out/base.erofs.sha256"), base-standin.erofs $(cat "$out/base-standin.erofs.sha256")"
