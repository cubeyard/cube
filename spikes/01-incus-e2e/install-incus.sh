#!/usr/bin/env bash
# Install Incus (Zabbly 6.0 LTS repo, >=6.0.6 for the CVE-2025-64507 fix) plus
# a loop-backed ZFS storage pool. REQUIRES ROOT.
#
# Non-disruptive: unlike the sysbox install this does NOT touch dockerd, so
# kiss-trader and centaur-registry keep running untouched.
#
# Usage:  sudo bash install-incus.sh [pool_size]   (default 20GiB)
set -euo pipefail
POOL_SIZE="${1:-20GiB}"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo bash $0)"; exit 1; }

echo "== Zabbly incus 6.0 LTS repo =="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
cat > /etc/apt/sources.list.d/zabbly-incus.sources <<SRC
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/lts-6.0
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
SRC
apt-get update
apt-get install -y incus zfsutils-linux

echo "== Version (need >= 6.0.6) =="
incus version || true

echo "== Group membership for $SUDO_USER =="
usermod -aG incus-admin "${SUDO_USER:?run via sudo so we know the user}"

echo "== Minimal init (default profile + incusbr0; we add our own pool/net) =="
incus admin init --minimal || echo "(already initialized)"

echo "== Loop-backed ZFS pool '$POOL_SIZE' (works on any host, no spare disk needed) =="
incus storage show cube >/dev/null 2>&1 || incus storage create cube zfs size="$POOL_SIZE"
incus storage show cube | head -20

echo "== Kernel modules the inner docker needs (FAQ: containers can't modprobe) =="
modprobe br_netfilter || true
echo br_netfilter > /etc/modules-load.d/cube-inner-docker.conf

echo "== Docker/incus FORWARD coexistence fix (Spike 1 finding) =="
# Host Docker's FORWARD policy DROP + br_netfilter (loaded above) drops ALL
# incus-bridge traffic (DHCP/DNS/TCP; only ICMP passes). Accept incus bridges in
# DOCKER-USER, which runs before Docker's DROP. cube names per-orb bridges cbr*
# so one wildcard rule covers them all. See fix-forward.sh for the full writeup.
if command -v iptables >/dev/null && iptables -S FORWARD 2>/dev/null | grep -q DOCKER-USER; then
  for dir in -i -o; do
    for br in incusbr0 cbr+; do
      iptables -C DOCKER-USER "$dir" "$br" -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER "$dir" "$br" -j ACCEPT
    done
  done
  echo "  DOCKER-USER accepts installed for incusbr0 + cbr+ (NOT reboot-persistent;"
  echo "  run 'apt-get install -y iptables-persistent' to save)."
else
  echo "  (no host Docker detected -- skipping)"
fi

echo
echo "DONE. Log out/in (or 'newgrp incus-admin'), then run 01-image.sh."
echo "If inner docker later hits AppArmor pivot_root denials (incus#791), try:"
echo "  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # and check dmesg"
