#!/usr/bin/env bash
# Boot-verify a packaged release by driving the LAUNCHER against it —
# the exact install path a user runs, on a blank data disk, rather than
# a parallel qemu invocation that could drift from it. Then apply the
# release's own app tarball in place, the way an app-only upgrade does,
# and require the product to come back with the same identity.
#
#   bash scripts/vm/verify-release.sh vX.Y.Z <dist-dir>
#
# Needs KVM (it boots the artifacts). Uses its own CUBE_HOME and ports,
# so a dev VM or another release keeps running untouched.
. "$(dirname "$0")/lib.sh"

VERSION="${1:?usage: verify-release.sh vX.Y.Z <dist-dir>}"
DIST="${2:?missing dist dir}"
LAUNCHER="$REPO_ROOT/launcher/cube"
VERIFY_HOME="$(mktemp -d /tmp/cube-verify-XXXXXX)"
export CUBE_HOME="$VERIFY_HOME" CUBE_RELEASE_DIR="$DIST" \
       CUBE_SSH_PORT="${CUBE_VERIFY_SSH_PORT:-2522}" \
       CUBE_PORT="${CUBE_VERIFY_PORT:-7877}" CUBE_BIND="" \
       CUBE_MEM="${CUBE_VERIFY_MEM:-4G}" CUBE_CPUS="${CUBE_VERIFY_CPUS:-2}" \
       CUBE_NO_UPDATE_CHECK=1

cleanup() { bash "$LAUNCHER" down >/dev/null 2>&1 || true; rm -rf "$VERIFY_HOME"; }
trap cleanup EXIT

log "install + boot $VERSION from $DIST (blank data disk)"
bash "$LAUNCHER" up "$VERSION"

log "the install must be USABLE, not merely reachable"
OUT="$(bash "$LAUNCHER" ssh '
  set -e
  # every mutable path on the data disk, by exact dataset
  for pair in cube/state/incus:/var/lib/incus \
      cube/state/cubed:/home/cube/cube cube/state/pi:/home/cube/.pi \
      cube/state/gh:/home/cube/.config/gh; do
    [ "$(findmnt -n -o SOURCE "${pair#*:}")" = "${pair%%:*}" ] || exit 1
  done
  # the seed did its one job, and nothing else can log in
  [ -s /home/cube/.ssh/authorized_keys ]
  systemctl is-active --quiet cube-seed
  # threads cannot provision without the inner image
  incus image info cube-node >/dev/null
  # a real container on the shipped image, with the nesting cubes need
  incus launch cube-node verify-c1 -c security.nesting=true >/dev/null
  for _ in $(seq 30); do
    incus exec verify-c1 -- test -d /proc && break; sleep 1
  done
  incus exec verify-c1 -- true
  incus delete -f verify-c1 >/dev/null
  curl -fsS -o /dev/null localhost:7777/api/threads
  echo CUBE-VERIFY-OK' 2>/dev/null || true)"
# grep, not compare: `cube ssh` allocates a tty and may append \r.
printf '%s' "$OUT" | grep -q CUBE-VERIFY-OK \
  || { fail "verification failed — see $VERIFY_HOME/console.log"; exit 1; }
ok "$VERSION installs, boots on a blank data disk, and runs a nested container"

log "in-place app update must round-trip (cube-app-apply)"
TAR="$(ls "$DIST"/cube-app-"$VERSION"-*.tar.zst | head -1)"
WANT="$(sed -n 's/.*"build_id": *"\([^"]*\)".*/\1/p' "$DIST/manifest-$GUEST_ARCH.json" | head -1)"
bash "$LAUNCHER" ssh cube-app-apply < "$TAR" 2>/dev/null | tr -d '\r' | tail -1
for _ in $(seq 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$CUBE_PORT/api/threads" 2>/dev/null && break; sleep 2
done
GOT="$(bash "$LAUNCHER" ssh cat /opt/cube/app/build-id 2>/dev/null | tr -d '\r')"
[ "$GOT" = "$WANT" ] || { fail "after cube-app-apply the VM reports build '$GOT' (want $WANT)"; exit 1; }
curl -fsS -o /dev/null "http://127.0.0.1:$CUBE_PORT/api/threads" \
  || { fail "cubed did not come back after cube-app-apply"; exit 1; }
ok "$VERSION app tarball applies in place and cubed comes back as $WANT"
