#!/usr/bin/env bash
# Create the per-orb network + capped inner-docker volume, launch the orb
# unprivileged with nesting (NO published ports, no proxy devices), then bring
# up the inner compose stack.
. "$(dirname "$0")/lib.sh"

log "Per-orb bridge network ($ORB_NET) -- static subnet $ORB_SUBNET, DHCP off"
# NAT stays ON here -- the orb needs egress to pull postgres/node images for the
# stack. Default-deny (ipv4.nat=false) + egress-proxy is Spike 3.
# DHCP is OFF: under host Docker, incus-bridge DHCP never completes (NOTES.md),
# and PLAN wants static IPs anyway. The orb gets $ORB_IP via a pushed networkd
# file below; dnsmasq still runs for DNS on $ORB_GW.
if ! incus network show "$ORB_NET" >/dev/null 2>&1; then
  incus network create "$ORB_NET" \
    ipv4.address="$ORB_SUBNET" ipv4.nat=true ipv4.dhcp=false ipv6.address=none
fi

log "Capped inner /var/lib/docker volume ($DOCKER_VOL_SIZE on ZFS pool '$POOL')"
incus storage volume show "$POOL" "$DOCKER_VOL" >/dev/null 2>&1 \
  || incus storage volume create "$POOL" "$DOCKER_VOL" size="$DOCKER_VOL_SIZE"

log "Workspace + seed the compose stack into it"
mkdir -p "$WORKSPACE"
cp -r "$SPIKE_DIR/stack/." "$WORKSPACE/"

log "Init orb from $ORB_IMAGE (unprivileged + nesting + isolated idmap)"
incus delete -f "$ORB_NAME" >/dev/null 2>&1 || true
incus init "$ORB_IMAGE" "$ORB_NAME" \
  --storage "$POOL" \
  --network "$ORB_NET" \
  -c security.nesting=true \
  -c security.syscalls.intercept.mknod=true \
  -c security.syscalls.intercept.setxattr=true \
  -c security.idmap.isolated=true \
  -d root,size="$ROOT_SIZE"

log "Attach shifted workspace + capped docker volume"
incus config device add "$ORB_NAME" workspace disk \
  source="$WORKSPACE" path=/workspace shift=true
incus config device add "$ORB_NAME" dockerlib disk \
  pool="$POOL" source="$DOCKER_VOL" path=/var/lib/docker

log "Inject static network config ($ORB_IP) into the orb rootfs (DHCP is off)"
# Pushed while stopped so the orb boots with a static IP from the first second.
# 05- sorts before the image's 10-netplan-eth0.network, so this wins.
incus file push - "$ORB_NAME/etc/systemd/network/05-eth0-static.network" \
  --uid 0 --gid 0 --mode 0644 <<NET
[Match]
Name=eth0
[Network]
Address=$ORB_IP/24
Gateway=$ORB_GW
DNS=$ORB_GW
DNS=1.1.1.1
NET

incus start "$ORB_NAME"
ok "orb started: $(incus list "$ORB_NAME" -f csv -c s)"

log "Point resolv.conf at working resolvers (glibc reads it directly; nsswitch=files dns)"
# The image ships /etc/resolv.conf -> systemd stub; replace it with a real file
# so docker pull can resolve. dnsmasq on $ORB_GW resolves; 1.1.1.1 is the fallback.
exec_root 'rm -f /etc/resolv.conf; printf "nameserver %s\nnameserver 1.1.1.1\n" '"$ORB_GW"' > /etc/resolv.conf'
echo "orb IPv4 = $(orb_ip)"

wait_inner_docker

log "Inner storage driver (want overlay2, NOT vfs)"
driver="$(exec_in 'docker info -f {{.Driver}}')"
echo "driver=$driver"
[ "$driver" = "overlay2" ] && ok "inner docker uses overlay2" || fail "inner docker fell back to $driver"

log "Workspace ownership as seen inside the orb (validates shift=true idmap)"
exec_in 'id; ls -ld /workspace; touch /workspace/.owned-by-dev && ls -l /workspace/.owned-by-dev'
echo "Host sees:"; ls -l "$WORKSPACE/.owned-by-dev"

log "Inner: docker compose up the two-service stack"
exec_in 'cd /workspace && docker compose up -d && docker compose ps'
