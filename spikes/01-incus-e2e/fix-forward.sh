#!/usr/bin/env bash
# Fix incus-bridge networking on a host that ALSO runs Docker. REQUIRES ROOT.
#
# Why this is needed (Spike 1 finding, 2026-08-26):
#   Host Docker sets the iptables FORWARD policy to DROP and inserts its own
#   chains. Because install-incus.sh loads br_netfilter (bridge-nf-call-iptables
#   defaults to 1 under Docker), EVERY frame on an incus bridge -- on-link
#   DHCP/DNS to the incus gateway AND routed egress alike -- traverses the
#   FORWARD chain and hits Docker's DROP. Only ICMP happens to pass. Symptoms:
#   incus containers get an IPv6 SLAAC address but NO IPv4 DHCP lease, cannot
#   resolve DNS, and cannot open any TCP connection. apt / docker pull all hang.
#
#   Docker exposes DOCKER-USER as the supported extension point that runs before
#   its DROP. Accepting incus-bridge traffic there restores full connectivity.
#
# Idempotent. Covers incusbr0 (management) and every per-orb bridge, which cube
# names with a "cbr" prefix so a single `cbr+` wildcard rule matches them all
# (present and future -- the rule is valid before the bridge exists).
#
# NOTE: these rules are NOT persistent across reboot on their own. Persist with
#   `apt-get install -y iptables-persistent` (netfilter-persistent save), or
#   re-run this script from a boot unit. Docker resets bridge-nf to 1 on start,
#   which is fine -- this fix works WITH bridge-nf=1.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo bash $0)"; exit 1; }

command -v iptables >/dev/null || { echo "iptables not found"; exit 1; }
if ! iptables -S FORWARD 2>/dev/null | grep -q DOCKER-USER; then
  echo "No DOCKER-USER chain -- host Docker not detected; nothing to fix."
  exit 0
fi

add() {  # add rule only if absent
  iptables -C "$@" 2>/dev/null || iptables -I "$@"
}
for dir in -i -o; do
  add DOCKER-USER "$dir" incusbr0 -j ACCEPT   # incus management bridge
  add DOCKER-USER "$dir" cbr+     -j ACCEPT   # all cube per-orb bridges
done

echo "DOCKER-USER now:"
iptables -S DOCKER-USER
echo
echo "DONE. incus-bridge DHCP/DNS/TCP should now work under host Docker."
echo "Persist across reboot with: apt-get install -y iptables-persistent"
