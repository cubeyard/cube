# Spike: QEMU guest with raw L2 frames over Iroh

Question: can a runner host a VM whose only network is a raw Ethernet channel
to a central gateway, so all guest traffic is decided centrally?

```
guest eth0 (virtio-net)
  -> QEMU -netdev dgram,unix          one Ethernet frame per datagram
  -> pump (runner side)               no IP stack, no DNS, no other sockets
  -> Iroh QUIC datagrams, ALPN cube/l2/0, frames fragmented to fit
  -> gateway (central)                smoltcp, DHCP, DNS, TCP termination
  -> upstream sockets for ports 80/443 only; other TCP gets RST
```

- `src/bin/pump.rs`: unix datagram socket <-> Iroh datagrams.
- `src/bin/gateway.rs`: one virtual LAN per connection (10.77.0.0/24,
  gateway .1, guest .2). DHCP and frame inspection are handwritten; smoltcp
  uses AnyIP plus a default route through its own address, and a listening
  socket is created per guest SYN. DNS is forwarded to a host resolver.
- `src/lib.rs`: QUIC datagrams hold ~1160-1410 bytes depending on path MTU
  discovery, so frames carry a 3-byte fragment header and the guest keeps a
  normal 1500 MTU.

## Run

Needs KVM, QEMU >= 7.2 (`-netdev dgram`), genisoimage and a Debian cloud image.

```
cargo build --release
mkdir -p /tmp/l2spike && cd /tmp/l2spike
curl -LO https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
mv debian-13-genericcloud-amd64.qcow2 debian.qcow2
cp <spike>/guest/* . && genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data
<spike>/run.sh /tmp/l2spike   # results in spike.log, gateway log in gateway.log
```

## Results (server1, 2026-10-04, pump and gateway on the same host)

| | via gateway | QEMU user NAT | host |
|---|---|---|---|
| boot to tests done | ~25 s | | |
| DHCP lease, MTU 1500, DNS via gateway | ok | | |
| `curl https://example.com` | 0.11-0.14 s | | |
| 100 MB HTTPS download | 45 MB/s | | 91 MB/s |
| 20 MB HTTPS upload | 22-52 MB/s | | |
| TCP to port 22 | refused (RST) | | |
| `git clone --depth 1` cube (139 MB) | 2.7 s | 2.8 s | |
| `apt-get update` (28.5 MB) | 31 s, once 2.6 s | 30.6 s | |

The 31 s `apt-get update` is not the gateway: QEMU's own NAT shows the same
stall. At the stall every buffer in the gateway is empty and the server only
sends a TLS close after its 30 s keep-alive timeout. The guest reported zero
TCP retransmits.

## Not covered

TLS interception, HTTP policy, secrets, IPv6, ICMP, UDP other than DNS, flow
limits, reconnect after an Iroh drop, relay paths, and RTT across machines.
