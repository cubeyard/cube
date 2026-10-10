#!/bin/sh
# Builds cube's guest kernel for one architecture. Runs inside the pinned
# Debian container started by build.sh, with packages/vm-base mounted at
# /vm-base and the verified source tarball at /vm-base/.cache.
set -eu

arch=$1 # arm64 | x86_64
version=$2
base=/vm-base/kernel
out=/vm-base/out/$arch

case "$arch" in
arm64) image=arch/arm64/boot/Image; cross=aarch64-linux-gnu- ;;
x86_64) image=arch/x86/boot/bzImage; cross=x86_64-linux-gnu- ;;
*) echo "unknown architecture $arch" >&2; exit 2 ;;
esac
case "$(uname -m)" in
aarch64) [ "$arch" = arm64 ] && cross= ;;
x86_64) [ "$arch" = x86_64 ] && cross= ;;
esac

work=/tmp/linux-$arch
rm -rf "$work"
mkdir -p "$work" "$out"
tar -xJf "/vm-base/.cache/linux-$version.tar.xz" -C "$work" --strip-components=1
cd "$work"

cp "$base/nerdbox-v0.2.5/config-6.12.44-$arch" .config
scripts/kconfig/merge_config.sh -m -O . .config \
	"$base/cube.fragment" "$base/cube-$arch.fragment" >/dev/null
make ARCH="$arch" CROSS_COMPILE="$cross" olddefconfig >/dev/null

# Every option a fragment asks for must survive olddefconfig; a renamed or
# unmet dependency would otherwise drop it silently.
missing=0
for line in $(grep -h '^CONFIG_' "$base/cube.fragment" "$base/cube-$arch.fragment"); do
	if ! grep -qx "$line" .config; then
		echo "missing after olddefconfig: $line" >&2
		missing=1
	fi
done
[ "$missing" = 0 ]
if grep -q '^CONFIG_MODULES=y' .config; then
	echo "modules are enabled; the guest kernel must be self-contained" >&2
	exit 1
fi

make ARCH="$arch" CROSS_COMPILE="$cross" -j"$(nproc)" \
	KBUILD_BUILD_USER=cube KBUILD_BUILD_HOST=cube \
	KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH:-0}" \
	"$(basename "$image")" >/tmp/build-$arch.log 2>&1 || {
	tail -40 /tmp/build-$arch.log >&2
	exit 1
}

cp "$image" "$out/vmlinuz"
cp .config "$out/config"
cp .config "$base/config-$version-$arch"
sha256sum "$out/vmlinuz" | cut -d' ' -f1 >"$out/vmlinuz.sha256"
echo "$arch: $(cat "$out/vmlinuz.sha256")"
