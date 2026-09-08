#!/usr/bin/env bash
# Host firewall setup for cube on a Docker + UFW host. REQUIRES ROOT.
# Idempotent; safe to re-run (it rewrites its own managed block each time).
# Phase 4's installer will absorb this.
#
# Two independent layers block cube traffic on this kind of host:
#
# 1. FORWARD (routed egress, cube -> world): host Docker sets the FORWARD
#    policy to DROP and br_netfilter makes bridge traffic traverse it.
#    Fix: ACCEPT in DOCKER-USER (runs before Docker's DROP) ONLY the NAT'd
#    bridges that actually route out — incusbr0 (management) and cbr-build
#    (the transient image builder). Production cube bridges (cbr-<cube>, NAT
#    off, no default route) get NO forward accept on purpose: a rooted agent
#    that adds a default route still cannot forward to other cubes or host
#    Docker networks — those packets hit Docker's DROP. Cubes egress only via
#    the on-link proxy (INPUT path, layer 2), never routed forwarding.
#
# 2. INPUT (on-link, cube -> host services on the bridge gateway): UFW's
#    default-deny incoming DROPS udp/tcp from cubes to the gateway — ICMP
#    passes via UFW's defaults, which masked this. Verified 2026-08-26:
#    `[UFW BLOCK] IN=cbr-crudtest ... DPT=53`. Without this fix cubes cannot
#    reach the bridge dnsmasq (DNS) or the cubed egress proxy — the spike
#    only "had DNS" through its 1.1.1.1 fallback + NAT, which the NAT-less
#    egress design removes.
#    Fix: ACCEPT only DNS (53), the egress-proxy port, and cubed's listener
#    (CUBED_PORT, for the portal HAIRPIN: OAuth-style flows inside a cube
#    resolve their portal origin to the bridge gateway) from incus-bridge
#    interfaces in ufw-before-input, persisted in /etc/ufw/before.rules
#    (survives reboot AND `ufw reload`). Everything else from cubes to the
#    host stays denied. The cubed port is NOT a hole into the UI/API: cubed
#    itself 403s any non-portal request from a cube source IP and pins
#    portal requests to the requesting cube's own portals (see the
#    cube-source guard in packages/server/src/index.ts).
#
# Cube bridges all use the `cbr` prefix; the builder is `cbr-build`.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash $0"; exit 1; }

PROXY_PORT=3128   # cubed egress proxies listen on <bridge-gateway>:3128
# cubed listeners (portal hairpin). 17777 is services-smoke's temporary
# listener — harmless when nothing binds it (connection refused).
CUBED_PORTS="${CUBED_PORTS:-7777 17777}"

echo "== 1. FORWARD: DOCKER-USER accepts for NAT'd bridges only =="
echo "==    (not reboot-persistent; Docker rebuilds its chains at start)  =="
if command -v iptables >/dev/null && iptables -S FORWARD 2>/dev/null | grep -q DOCKER-USER; then
  # Drop any legacy blanket cbr+ accept from earlier versions of this script.
  for dir in -i -o; do
    while iptables -C DOCKER-USER "$dir" cbr+ -j ACCEPT 2>/dev/null; do
      iptables -D DOCKER-USER "$dir" cbr+ -j ACCEPT
    done
  done
  for dir in -i -o; do
    for br in incusbr0 cbr-build; do
      iptables -C DOCKER-USER "$dir" "$br" -j ACCEPT 2>/dev/null \
        || iptables -I DOCKER-USER "$dir" "$br" -j ACCEPT
    done
  done
  echo "  DOCKER-USER: incusbr0 + cbr-build accepted; blanket cbr+ removed"
else
  echo "  (no DOCKER-USER chain — host Docker not detected; skipping)"
fi

echo "== 2. INPUT: DNS(53) + proxy($PROXY_PORT) + cubed($CUBED_PORTS, portal hairpin) for incus bridges =="
RULES=/etc/ufw/before.rules
if [ -f "$RULES" ]; then
  cp -a "$RULES" "$RULES.cube-bak"
  # 1) Strip any prior cube-managed block: the sentinel-delimited block this
  #    script writes, AND legacy lines from the intermediate (blanket) version.
  awk '
    /^# >>> cube-incus-input/ { skip=1; next }
    /^# <<< cube-incus-input/ { skip=0; next }
    skip { next }
    /cube-incus-input/ { next }                                # legacy comment
    /Added by cube scripts\/host-firewall/ { next }            # legacy comment
    /^-A ufw-before-input -i (incusbr0|cbr\+)( |\t)/ { next }   # legacy + our rules
    { print }
  ' "$RULES.cube-bak" > "$RULES.stripped"
  # 2) Insert a fresh sentinel-wrapped block at the *filter section's COMMIT
  #    (a user-added *nat section above it must not receive filter rules).
  awk -v proxy_port="$PROXY_PORT" -v cubed_ports="$CUBED_PORTS" '
    /^\*/ { table = $0 }
    /^COMMIT$/ && table == "*filter" && !done {
      print "# >>> cube-incus-input (managed by scripts/host-firewall.sh) >>>"
      print "# cubes may reach EXACTLY the host services they need on their bridge"
      print "# gateway: DNS (53) and the cubed egress proxy (" proxy_port "). NOT a blanket"
      print "# accept — cubes are untrusted and must not reach cubed or other daemons."
      print "-A ufw-before-input -i incusbr0 -p udp --dport 53 -j ACCEPT"
      print "-A ufw-before-input -i incusbr0 -p tcp --dport 53 -j ACCEPT"
      print "-A ufw-before-input -i cbr+ -p udp --dport 53 -j ACCEPT"
      print "-A ufw-before-input -i cbr+ -p tcp --dport 53 -j ACCEPT"
      print "-A ufw-before-input -i cbr+ -p tcp --dport " proxy_port " -j ACCEPT"
      print "# cubed listeners: portal hairpin only — cubed 403s non-portal requests"
      print "# from cube source IPs (own-portal check in index.ts)."
      split(cubed_ports, ports, " ")
      for (i in ports) print "-A ufw-before-input -i cbr+ -p tcp --dport " ports[i] " -j ACCEPT"
      print "# <<< cube-incus-input <<<"
      done = 1
    }
    { print }
  ' "$RULES.stripped" > "$RULES.cube-tmp"
  if ! grep -q '>>> cube-incus-input' "$RULES.cube-tmp"; then
    echo "no *filter COMMIT found in $RULES — not touching it"
    rm -f "$RULES.cube-tmp" "$RULES.stripped"
    exit 1
  fi
  mv "$RULES.cube-tmp" "$RULES"
  rm -f "$RULES.stripped"
  echo "  before.rules rewritten (backup at $RULES.cube-bak)"
  ufw reload
else
  echo "  (no $RULES — UFW not installed; using raw INPUT accepts instead)"
  add_input() { iptables -C INPUT "$@" 2>/dev/null || iptables -I INPUT "$@"; }
  # Drop legacy blanket accepts first.
  for br in incusbr0 cbr+; do
    while iptables -C INPUT -i "$br" -j ACCEPT 2>/dev/null; do
      iptables -D INPUT -i "$br" -j ACCEPT
    done
  done
  for br in incusbr0 cbr+; do
    add_input -i "$br" -p udp --dport 53 -j ACCEPT
    add_input -i "$br" -p tcp --dport 53 -j ACCEPT
  done
  add_input -i cbr+ -p tcp --dport "$PROXY_PORT" -j ACCEPT
  for port in $CUBED_PORTS; do
    add_input -i cbr+ -p tcp --dport "$port" -j ACCEPT
  done
fi

echo
echo "DONE. Verify from a cube: getent hosts archive.ubuntu.com (via gateway DNS)."
