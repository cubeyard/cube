# Spike 1 — Incus end-to-end: FINDINGS

**Date:** 2026-08-26
**Host:** dedicated Hetzner box, Ubuntu 24.04.4, kernel 6.8.0-136, 62 GiB RAM,
977 GB free. Host Docker 29.1.3 (overlay2) already running (kiss-trader etc.).
**Incus:** 6.0.6 (Zabbly LTS), ZFS pool `cube` (loop-backed, 18.9 GiB).

## Outcome: PASS — Incus backbone confirmed.

Every core requirement validated end-to-end on this host:

| Requirement | Result |
|---|---|
| Orb with `security.nesting` + idmap | ✅ launches, boots |
| Inner dockerd storage driver | ✅ **overlay2** (not vfs) |
| `shift=true` idmapped workspace | ✅ `dev`(1000) inside == `diz` on host, bidirectional writes |
| Inner docker egress (pull images) | ✅ pulled postgres:16 + node:24 |
| Portal: host → `orbIP:8080` (inner-published port), zero extra plumbing | ✅ `{"db_reachable":true}` — web talked to postgres |
| `incus` reports orbIP (host proxy can learn it) | ✅ `10.90.1.10` on eth0 |
| stop/start persistence | ✅ rootfs + inner images survive; processes die → wake hook = `docker compose up -d` |
| Per-orb disk quota (ZFS) | ✅ hard cap at 5 GiB, ENOSPC, orb+dockerd survive full-disk |
| Concurrent exec | ✅ two streaming execs clean |

Inner Docker pinned to **28.5.2** (28.x, avoids incus#2757). Node **24.20.0**.
Whole spike footprint: ~1 GiB on the ZFS pool.

## MAJOR FINDING — host Docker breaks incus-bridge networking

This host runs Docker, and that broke incus networking in two linked ways.

### 1. Incus-bridge traffic does not pass on a Docker host
`install-incus.sh` loads `br_netfilter` (so the inner dockerd can use it). Under
that, **every** frame on an incus bridge — on-link *and* routed — is subject to
host Docker's forwarding policy, which drops it. Symptom matrix from inside a
fresh orb:

| Traffic | Result |
|---|---|
| ICMP (ping) egress + on-link | PASS (misleading!) |
| **TCP egress** (`1.1.1.1:443`) | **FAIL** |
| **UDP/TCP to gateway:53** (on-link DNS) | **FAIL** |
| IPv6 SLAAC address | assigned (RA is ICMPv6, so it works) |
| IPv4 DHCP lease | **never completes** |

So a container comes up with an IPv6 address, no IPv4, no DNS, and no TCP —
`apt` and `docker pull` hang. **ICMP passing is a trap**: an early ping test
looked fine and hid the real breakage.

**Fix (needs root, now applied):** the coexistence step that lets incus bridges
forward on a Docker host. Added to `install-incus.sh` and to a standalone
`fix-forward.sh` (details in that file's header). Per-orb bridges are now named
with a **`cbr` prefix** (`lib.sh`) so ONE wildcard entry covers every current
and future orb bridge. After the fix, TCP egress + DNS work. **NOT
reboot-persistent** on its own — production must persist it (or re-run it from
a boot unit); Docker resetting `bridge-nf` on start is fine, the fix works with
it enabled.

### 2. DHCP still won't complete even after that fix → we went static
Even with egress restored, the DHCPv4 handshake never completes on an incus
bridge under host Docker (dnsmasq is healthy and authoritative; `networkctl
renew` yields no lease, no DHCPv4 log lines). Rather than chase it, we switched
to **static IPs**, which:
- is what **PLAN already mandates** ("static IPs on the managed bridge"),
- is deterministic and needs no further root round-trips,
- is how cubed will assign orb addresses anyway.

Implementation (`02-up.sh`): create the per-orb bridge with an explicit subnet
and **`ipv4.dhcp=false`**, then `incus file push` a static
`05-eth0-static.network` into the orb rootfs *before* start (so it boots static
from second one), and rewrite `/etc/resolv.conf` to a real file after start
(the image ships it as a systemd-stub symlink; `nsswitch` is `files dns`, so
glibc reads it directly). Orb = `10.90.1.10` on `cbr-spike01` (`10.90.1.1/24`).

**Open question for the host/design:** DHCP-under-Docker is unsolved (likely
needs bridge-nf turned off for incus bridges — needs root, and Docker re-enables
it on start). Static sidesteps it entirely — recommend cube stays static (the
allocator owns IPs).

## Secondary findings / script bugs fixed

- **`orb_ip()` picked the wrong IP.** `incus list -c 4` lists the orb's *inner*
  docker bridge IPs (172.x, unreachable from host) alongside eth0, and returned
  `172.18.0.1` first → portal FAIL. Now reads eth0 authoritatively from inside
  the orb. (For cubed: learn orbIP from the orb's cube-bridge interface, not the
  first address incus lists.)
- **Quota test gave a false negative.** `dd if=/dev/zero` "wrote" 6 GiB into a
  5 GiB volume in <2s at 3.5 GB/s — because the ZFS pool has **lz4 compression**
  and zeros collapse to nothing. Re-tested with `/dev/urandom`: write stops at
  the cap with `Disk quota exceeded`. Also, the original test piped `dd | tail`,
  masking dd's ENOSPC exit behind tail's 0. Both fixed in `04-lifecycle.sh`
  (urandom + no pipe). **Lesson: always size/quota-test with incompressible
  data on ZFS.**
- **`04-lifecycle.sh` dmesg check needs root** (`dmesg_restrict=1`); it now uses
  `sudo -n` so it degrades instead of hanging.

## Files changed this spike
- `install-incus.sh` — added Docker/incus forwarding coexistence step.
- `fix-forward.sh` — NEW standalone root fix (full writeup in header).
- `lib.sh` — per-orb bridge `cbr-spike01`; static `ORB_SUBNET/GW/IP`;
  `orb_ip()` reads eth0 from inside.
- `02-up.sh` — bridge with static subnet + DHCP off; push static netcfg; fix
  resolv.conf; print orbIP.
- `04-lifecycle.sh` — quota test uses urandom (no pipe); `sudo -n` dmesg.

## State left behind
- Image alias `cube-orb-spike01` (335 MiB) published on the `cube` pool.
- Orb `orb-spike01` RUNNING on `cbr-spike01`, inner compose stack live at
  `10.90.1.10:8080`. Leave for Spike 2, or `incus delete -f orb-spike01` +
  `incus network delete cbr-spike01` + `incus storage volume delete cube
  spike01-docker` to reclaim.

## Consequence
Backbone confirmed → proceed to **Spike 2 (pi SDK headless)**. Carry forward:
static-IP orbs (no DHCP), the `cbr` bridge naming, and "host Docker
coexistence" as a first-class host-setup concern.
