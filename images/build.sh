#!/usr/bin/env bash
# Build a cube image profile: provision a throwaway Ubuntu 24.04 container,
# then publish it under the profile alias.
#
#   sg incus-admin -c "images/build.sh cube-node"
#
# The builder gets a static IP on its own NAT'd cbr bridge (same recipe as
# cubes): DHCP on incus bridges never completes under host Docker (spike 1
# finding), and external DNS (1.1.1.1) over NAT keeps the build independent
# of the host-firewall INPUT fix that gateway DNS needs.
#
# Rebuild = re-run (the old image stays until the new one publishes, then the
# alias moves). Cubes pick the new image up on their next recreate.
set -euo pipefail
PROFILE="${1:?usage: build.sh <profile>  (e.g. cube-node)}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="$DIR/$PROFILE/provision.sh"
[ -f "$PROVISION" ] || { echo "no such profile: $PROVISION"; exit 1; }
BUILDER="cube-builder-$PROFILE"
POOL="${CUBE_POOL:-cube}"
NET="cbr-build"                 # cbr prefix: covered by the host firewall rules
SUBNET="10.90.250.1/24"
IP="10.90.250.10"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

log "Builder bridge $NET ($SUBNET, NAT on, DHCP off)"
incus network show "$NET" >/dev/null 2>&1 || incus network create "$NET" \
  ipv4.address="$SUBNET" ipv4.nat=true ipv4.dhcp=false ipv6.address=none

log "Init builder ($BUILDER; nesting on so the docker postinst behaves)"
incus delete -f "$BUILDER" >/dev/null 2>&1 || true
incus init images:ubuntu/24.04 "$BUILDER" --storage "$POOL" --network "$NET" \
  -c security.nesting=true

log "Static network config ($IP) + start"
incus file push - "$BUILDER/etc/systemd/network/05-eth0-static.network" \
  --uid 0 --gid 0 --mode 0644 <<NET
[Match]
Name=eth0
[Network]
Address=$IP/24
Gateway=${SUBNET%%/*}
NET
incus start "$BUILDER"
incus exec "$BUILDER" -- bash -c 'rm -f /etc/resolv.conf; echo "nameserver 1.1.1.1" > /etc/resolv.conf'
incus exec "$BUILDER" -- bash -c \
  'for i in $(seq 30); do getent hosts archive.ubuntu.com >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1' \
  || { echo "builder never got network — check DOCKER-USER accepts (scripts/host-firewall.sh)"; exit 1; }

log "Provision from $PROVISION"
incus exec "$BUILDER" -- bash -s < "$PROVISION"

log "Publish as image alias '$PROFILE'"
# Publish FIRST, move the alias after: deleting the old image up front would
# leave no working image at all if the publish fails (sol review finding).
incus stop "$BUILDER"
OLD_FP="$(incus image list "$PROFILE" -f csv -c f | head -n1)"
# zstd: the exported tarball ships on the cube-node disk as
# cube-node.tar.zst (scripts/vm/build-cube-node.sh) — keep the stored
# compression in line with the name.
FP="$(incus publish "$BUILDER" --compression zstd | tr '\r' '\n' | sed -n 's/.*fingerprint: *//p' | tail -n1)"
[ -n "$FP" ] || { echo "publish returned no fingerprint"; exit 1; }
incus image alias delete "$PROFILE" >/dev/null 2>&1 || true
incus image alias create "$PROFILE" "$FP"
if [ -n "$OLD_FP" ] && [ "$OLD_FP" != "$FP" ]; then
  incus image delete "$OLD_FP" || true
fi
incus delete "$BUILDER"
incus network delete "$NET" || true
printf '\033[1;32mPASS\033[0m image published: %s\n' "$(incus image list "$PROFILE" -f csv -c lfs)"
