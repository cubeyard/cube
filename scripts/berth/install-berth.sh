#!/usr/bin/env bash
# Installs one `berth vm` from a berth release bundle, without starting it:
# the binary under <prefix>/libexec/berth-<version>/, a start script under
# <prefix>/bin/ with every path absolute, and a systemd user unit or a launchd
# user agent in --unit-dir. It never replaces a file, never loads, enables or
# starts a unit, never enrolls, never makes, reads or prints the runner's
# key, and prints the operator's next commands as text. Before writing
# anything it checks the QEMU, the accelerator and the keel files by running
# this berth as far as its banner in a throwaway directory (with a throwaway
# key berth makes there), which it removes.
#
# Usage (from the unpacked bundle, berth-<release>-<platform>/share/berth/):
#   install-berth.sh --prefix /abs --dir /abs/state --keel /abs/keel/<arch> \
#     --qemu /abs/qemu-system-<arch> --qemu-img /abs/qemu-img --mkfs-erofs /abs/mkfs.erofs \
#     --image <registry/repository@sha256:…> --network loopback|direct|relay [--relay-only] \
#     [--listen <ip:port>] --node-id node-<name> --allow-peer <control peer> --max-machines N \
#     --unit-dir /abs --unit-name <name> --kind systemd|launchd \
#     [--seed-from /abs/berth-dir]   # a directory holding the image already (images/, layers/)
# Without --seed-from the check pulls the image into the throwaway directory.
set -euo pipefail

fail() { echo "install-berth: $*" >&2; exit 1; }
refuse() { echo "install-berth: $*" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd -P)
berth_src=$(cd "$here/../.." && pwd -P)/bin/berth
[ -x "$berth_src" ] || fail "no berth beside this script ($berth_src); run it from the unpacked bundle"

prefix='' dir='' keel='' qemu='' qemu_img='' mkfs='' image='' network='' relay_only=0 listen=''
node_id='' allow_peer='' max_machines='' unit_dir='' unit_name='' kind='' seed=''
while [ "$#" -gt 0 ]; do
  case "$1" in
  --relay-only) relay_only=1; shift; continue ;;
  --prefix | --dir | --keel | --qemu | --qemu-img | --mkfs-erofs | --image | --network | --listen | --node-id | \
    --allow-peer | --max-machines | --unit-dir | --unit-name | --kind | --seed-from)
    [ "$#" -ge 2 ] || fail "$1 needs a value"
    value=$2 ;;
  *) fail "unknown argument $1" ;;
  esac
  case "$1" in
  --prefix) prefix=$value ;; --dir) dir=$value ;; --keel) keel=$value ;; --qemu) qemu=$value ;;
  --qemu-img) qemu_img=$value ;; --mkfs-erofs) mkfs=$value ;; --image) image=$value ;;
  --network) network=$value ;; --listen) listen=$value ;; --node-id) node_id=$value ;;
  --allow-peer) allow_peer=$value ;; --max-machines) max_machines=$value ;; --unit-dir) unit_dir=$value ;;
  --unit-name) unit_name=$value ;; --kind) kind=$value ;; --seed-from) seed=$value ;;
  esac
  shift 2
done

# Paths: absolute, and plain enough to sit unquoted in a unit and a plist.
path_ok() {
  case "$2" in
  '') fail "$1 is required" ;;
  /*) ;;
  *) fail "$1 must be an absolute path: $2" ;;
  esac
  case "$2" in *[!A-Za-z0-9._/+@=_-]*) fail "$1 has characters this installer does not write into a unit: $2" ;; esac
}
for pair in "--prefix:$prefix" "--dir:$dir" "--keel:$keel" "--qemu:$qemu" "--qemu-img:$qemu_img" \
  "--mkfs-erofs:$mkfs" "--unit-dir:$unit_dir"; do
  path_ok "${pair%%:*}" "${pair#*:}"
done
[ -z "$seed" ] || path_ok --seed-from "$seed"
for file in "$qemu" "$qemu_img" "$mkfs"; do [ -x "$file" ] || fail "not an executable file: $file"; done
for file in vmlinuz base.erofs; do [ -f "$keel/$file" ] || fail "--keel has no $file: $keel"; done
[ -z "$seed" ] || [ -d "$seed/images" ] || fail "--seed-from has no images/: $seed"

# berth keeps each machine's sockets at <--dir>/<16-hex machine id>/qmp.sock and
# refuses a --dir where that path exceeds 100 bytes (packages/berth/src/vm/mod.rs:
# MAX_SOCKET_PATH, checked in VmRunner::open). Measured on the physical path.
socket_max=100
socket_tail=26 # 1 + 16 + 1 + length of "qmp.sock"
# The physical path of an absolute path: its nearest existing directory resolved,
# then the components that do not exist yet as given (--dir is never made here).
physical() {
  p=$1 rest=''
  while [ ! -d "$p" ]; do
    rest="/${p##*/}$rest"
    p=${p%/*}
    [ -n "$p" ] || p=/
  done
  p=$(cd "$p" && pwd -P)
  [ "$p" != / ] || p=''
  printf '%s%s\n' "$p" "$rest"
}
dir_physical=$(physical "$dir")
[ $((${#dir_physical} + socket_tail)) -le "$socket_max" ] ||
  fail "--dir $dir_physical is too long: berth needs <dir>/<16-hex machine id>/qmp.sock within $socket_max bytes"
printf '%s\n' "$image" | grep -Eq '^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$' ||
  fail "--image must be pinned: <registry/repository>@sha256:<64 hex>"
case "$network" in
loopback | direct) [ -n "$listen" ] || fail "--network $network needs --listen <ip:port>" ;;
relay) ;;
*) fail "--network must be loopback, direct or relay" ;;
esac
[ "$relay_only" = 0 ] || [ "$network" = relay ] || fail "--relay-only goes with --network relay only"
case "$listen" in *[!][0-9a-fA-F.:]*) fail "--listen must be <ip:port>: $listen" ;; esac
case "$node_id" in node-*) ;; *) fail "--node-id must start with node-" ;; esac
case "$node_id" in *[!a-z0-9-]*) fail "--node-id may hold a-z, 0-9 and -" ;; esac
case "$allow_peer" in *[!0-9a-f]* | '') fail "--allow-peer must be the control peer, 64 hex" ;; esac
[ "${#allow_peer}" -eq 64 ] || fail "--allow-peer must be the control peer, 64 hex"
case "$max_machines" in '' | *[!0-9]* | 0*) fail "--max-machines must be a positive number" ;; esac
case "$unit_name" in '' | *[!a-z0-9-]*) fail "--unit-name may hold a-z, 0-9 and -" ;; esac
case "$kind" in systemd | launchd) ;; *) fail "--kind must be systemd or launchd" ;; esac
case "$(uname -s)" in
Linux) accel=kvm ;;
Darwin) accel=hvf ;;
*) fail "berth vm runs on Linux (KVM) or macOS (HVF), not $(uname -s)" ;;
esac

# The bundle's berth, by its own word.
version_json=$("$berth_src" version)
version=$(printf '%s' "$version_json" | sed -n 's/.*"softwareVersion":"\([0-9][0-9.]*\)".*/\1/p')
protocol=$(printf '%s' "$version_json" | sed -n 's/.*"protocolVersion":\([0-9]*\).*/\1/p')
[ -n "$version" ] && [ "$protocol" = 4 ] || fail "this berth does not say runner protocol 4: $version_json"

libexec=$prefix/libexec/berth-$version
berth=$libexec/berth
start=$prefix/bin/start-$unit_name.sh
log=$prefix/log/$unit_name.log
if [ "$kind" = systemd ]; then
  unit=$unit_dir/$unit_name.service template=$here/berth-vm.service.in
else
  unit=$unit_dir/dev.cube.$unit_name.plist template=$here/dev.cube.berth-vm.plist.in
fi
[ -f "$template" ] || fail "no unit template beside this script: $template"
# Nothing is ever overwritten; all is checked before anything is written.
[ ! -e "$start" ] || refuse "refusing to overwrite $start"
[ ! -e "$unit" ] || refuse "refusing to overwrite $unit"
if [ -e "$berth" ] && ! cmp -s "$berth_src" "$berth"; then
  refuse "refusing to replace $berth, which differs from this bundle's berth $version"
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
kernel_sha=$(sha256 "$keel/vmlinuz")
base_sha=$(sha256 "$keel/base.erofs")

# The check: this berth up to its banner, in a throwaway directory, on
# loopback with a throwaway node id; it never listens beyond 127.0.0.1.
# Under /tmp whatever TMPDIR says: macOS's per-user TMPDIR is too long for
# berth's socket rule above (/private/tmp on macOS is short).
check=$(mktemp -d /tmp/install-berth.XXXXXX)
pid=''
# SIGTERM: a background job of a script starts with SIGINT ignored, and berth
# stops on either. It has 120 s, then it is killed.
stop_check() {
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 120 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pid=''
}
cleanup() {
  stop_check
  rm -rf -- "$check"
}
trap cleanup EXIT
mkdir "$check/dir"
real=$(cd "$check/dir" && pwd -P)
[ $((${#real} + socket_tail)) -le "$socket_max" ] ||
  fail "the check directory $real is too long for berth's $socket_max-byte socket paths"
if [ -n "$seed" ]; then
  cp -R "$seed/images" "$check/dir/images"
  [ ! -d "$seed/layers" ] || cp -R "$seed/layers" "$check/dir/layers"
  echo "install-berth: the check uses the image in $seed (copied, not changed)"
else
  echo "install-berth: the check pulls $image into a throwaway directory (no --seed-from)"
fi
"$berth_src" vm --dir "$check/dir" --qemu "$qemu" --qemu-img "$qemu_img" --keel "$keel" --mkfs-erofs "$mkfs" \
  --image "$image" --accel "$accel" --network loopback --listen 127.0.0.1:0 --allow-peer "$allow_peer" \
  --node-id node-install-check --max-machines 1 2>"$check/banner" &
pid=$!
waited=0
until grep -q '^waiting for cubed' "$check/banner" 2>/dev/null; do
  kill -0 "$pid" 2>/dev/null || { cat "$check/banner" >&2; fail "berth stopped before its banner"; }
  [ "$waited" -lt 1800 ] || { cat "$check/banner" >&2; fail "no banner within 1800 s"; }
  sleep 1
  waited=$((waited + 1))
done
stop_check
banner=$(cat "$check/banner")
printf '%s\n' "$banner" | grep -q "meets keel's floor" || fail "QEMU does not meet keel's floor: $qemu"
printf '%s\n' "$banner" | grep -q "^accelerator: $accel," || fail "berth does not report accelerator $accel"
printf '%s\n' "$banner" | grep -q "vmlinuz $kernel_sha, base.erofs $base_sha" || fail "berth does not report the keel files' hashes"
echo "install-berth: check passed:"
printf '%s\n' "$banner" | grep -E "^(berth |qemu:|accelerator:|keel:|image:)" | sed 's/^/  /'

# Write: the binary (if new), the start script, the unit.
mkdir -p "$libexec" "$prefix/bin" "$prefix/log" "$unit_dir"
if [ ! -e "$berth" ]; then
  cp "$berth_src" "$berth.tmp.$$"
  chmod 0755 "$berth.tmp.$$"
  mv "$berth.tmp.$$" "$berth"
fi
extra=''
[ -z "$listen" ] || extra=" --listen $listen"
[ "$relay_only" = 0 ] || extra="$extra --relay-only"
umask 022
cat >"$start.tmp.$$" <<SCRIPT
#!/bin/sh
# berth $version vm $unit_name, written by install-berth.sh. Every path is absolute.
exec $berth vm --dir $dir \\
  --qemu $qemu --qemu-img $qemu_img \\
  --keel $keel --mkfs-erofs $mkfs --accel $accel \\
  --image $image \\
  --network $network$extra \\
  --allow-peer $allow_peer \\
  --node-id $node_id --max-machines $max_machines
SCRIPT
chmod 0755 "$start.tmp.$$"
mv "$start.tmp.$$" "$start"
sed -e "s|@UNIT@|$unit_name|g" -e "s|@START@|$start|g" -e "s|@PREFIX@|$prefix|g" -e "s|@LOG@|$log|g" \
  -e "s|@PLIST@|$unit|g" "$template" >"$unit.tmp.$$"
chmod 0644 "$unit.tmp.$$"
mv "$unit.tmp.$$" "$unit"

echo "install-berth: wrote"
echo "  $berth"
echo "  $start"
echo "  $unit"
echo "Nothing was started, loaded or enrolled. Next, yourself:"
if [ "$kind" = systemd ]; then
  echo "  ln -s $unit ~/.config/systemd/user/   # or copy it there"
  echo "  systemctl --user daemon-reload && systemctl --user enable --now $unit_name.service"
else
  echo "  launchctl bootstrap gui/\$(id -u) $unit"
fi
echo "  then enroll it from the cubed host with a version-2 config that says \"protocol\": 4:"
echo "  cubed runners enroll --config <runner.json>   (docs/runner-operations.md)"
