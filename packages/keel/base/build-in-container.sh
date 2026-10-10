#!/bin/sh
# Builds base.erofs for one architecture. Runs inside the pinned Debian
# container started by build.sh, with packages/keel mounted at /keel and the
# verified source tarballs in /keel/.cache.
set -eu

arch=$1 # arm64 | x86_64
out=/keel/out/$arch

case "$arch" in
arm64) host=aarch64-linux-gnu ;;
x86_64) host=x86_64-linux-gnu ;;
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

# cube-init and the agent.
cd "$work"
build "$cc" $cflags -static -Wall -Wextra -o cube-init /keel/init/cube-init.c
build "$cc" $cflags -static -Wall -Wextra -o cube-agent /keel/init/agent-standin.c

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
uuid=$(cd "$tree" && find . -type f | sort | xargs sha256sum | sha256sum |
	sed -E 's/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/\1-\2-4\3-8\4-\5/')
mkfs.erofs --quiet -b4096 -zlz4hc -T"$SOURCE_DATE_EPOCH" --all-root -U "$uuid" \
	"$out/base.erofs" "$tree"
sha256sum "$out/base.erofs" | cut -d' ' -f1 >"$out/base.erofs.sha256"
{
	echo "keel base for $arch"
	echo "built with $(mkfs.erofs --version 2>&1 | head -1), $("$cc" --version | head -1)"
	echo "sources: lz4 1.10.0, e2fsprogs 1.47.3, erofs-utils 1.8.6"
	(cd "$tree" && find . -type f | sort | xargs sha256sum)
	(cd "$tree" && find . ! -type f -printf '%y %p %l\n' | sort -k2)
} >"$out/base.txt"
echo "$arch: base.erofs $(cat "$out/base.erofs.sha256")"
