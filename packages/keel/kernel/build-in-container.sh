#!/bin/sh
# Builds keel's guest kernel for one architecture. Runs inside the pinned
# Debian container started by build.sh, with packages/keel mounted at /keel
# and the verified source tarball at /keel/.cache.
set -eu

arch=$1 # arm64 | x86_64
version=$2
kernel=/keel/kernel
out=/keel/out/$arch

case "$arch" in
arm64) image=arch/arm64/boot/Image; cross=aarch64-linux-gnu- ;;
x86_64) image=arch/x86/boot/bzImage; cross=x86_64-linux-gnu- ;;
*) echo "unknown architecture $arch" >&2; exit 2 ;;
esac
case "$(uname -m)" in
aarch64) [ "$arch" = arm64 ] && cross= ;;
x86_64) [ "$arch" = x86_64 ] && cross= ;;
esac
make="make ARCH=$arch CROSS_COMPILE=$cross"

work=/tmp/linux-$arch
rm -rf "$work"
mkdir -p "$work" "$out"
tar -xJf "/keel/.cache/linux-$version.tar.xz" -C "$work" --strip-components=1
cd "$work"

cp "$kernel/defconfig-$arch" .config
$make olddefconfig >/dev/null

# The defconfig must describe this kernel exactly. A new kernel version can
# rename, drop or add options; then the build stops instead of silently
# building something else. KEEL_REFRESH=1 writes the new defconfig back for
# review.
$make savedefconfig >/dev/null
if ! cmp -s defconfig "$kernel/defconfig-$arch"; then
	if [ "${KEEL_REFRESH:-0}" = 1 ]; then
		cp defconfig "$kernel/defconfig-$arch"
		echo "$arch: defconfig-$arch updated; review the diff" >&2
	else
		diff -u "$kernel/defconfig-$arch" defconfig >&2 || true
		echo "$arch: defconfig-$arch does not match Linux $version; rerun with KEEL_REFRESH=1 and review" >&2
		exit 1
	fi
fi
if grep -q '^CONFIG_MODULES=y' .config; then
	echo "modules are enabled; the guest kernel must be self-contained" >&2
	exit 1
fi

$make -j"$(nproc)" \
	KBUILD_BUILD_USER=cube KBUILD_BUILD_HOST=cube \
	KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH:-0}" \
	"$(basename "$image")" >/tmp/build-$arch.log 2>&1 || {
	tail -40 /tmp/build-$arch.log >&2
	exit 1
}

cp "$image" "$out/vmlinuz"
cp .config "$out/config"
sha256sum "$out/vmlinuz" | cut -d' ' -f1 >"$out/vmlinuz.sha256"
echo "$arch: $(cat "$out/vmlinuz.sha256")"
