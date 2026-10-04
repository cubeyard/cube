# cube-gateway

The central network for runner VMs. cubed starts and supervises it (that part
is the SERVER work package of
[the VM runner plan](../../docs/plans/2026-10-04-vm-runner.md), not built yet).
A guest's only network is raw Ethernet frames carried over Iroh from its
runner; the gateway gives each VM a small LAN and is its only way out.

```
guest eth0 ─ QEMU -netdev dgram ─ runner pump ─ Iroh cube/l2/1 datagrams ─ cube-gateway
                                                (gateway dials the runner)    │ per VM: 10.77.0.0/24
                                                                              │ .1 DHCP, DNS, TCP termination
                                                                              │ 80/443 only, everything else RST
                                                                              ├─ POST /v1/decide → cubed (egress.sock)
                                                                              └─ upstream: public addresses only
```

What it does per VM:

- DHCP: fixed lease 10.77.0.2/24, router and resolver 10.77.0.1, MTU 1500
  (frames are fragmented over QUIC datagrams with a 3-byte header).
- DNS: public A records from the gateway host's resolver (TTL 30), AAAA empty,
  other types NOTIMP.
- TCP to port 80 or 443 on any address is terminated by smoltcp; other TCP is
  reset, other UDP dropped, no IPv6. Frames from a foreign MAC are dropped.
- HTTPS is intercepted with a leaf for the SNI name, signed by the
  installation CA (`state/ca.key` 0600, `state/ca.pem` 0644, created once,
  never rotated). No SNI closes the connection; `Host` must equal SNI (421).
- Every request goes to cubed's decision API. Deny, timeout (5 s), socket
  error or malformed answer: `403` with `x-cube-denied: <reason>`.
- Placeholder secrets (`cube_ph_<name>_<22 base62>`) in header values,
  including decoded `Authorization: Basic`, are listed in the decision request
  and substituted only when the answer returns them and only over HTTPS.
- The upstream is the SNI/Host name, never the address the guest dialled. It
  is resolved by the gateway and refused unless every address is public
  unicast (no loopback, RFC 1918, link-local/metadata, CGNAT, ULA, mapped or
  NAT64 forms, documentation ranges). Upstream TLS uses the system roots.
- `CONNECT` and `Upgrade` (WebSocket, HTTP/2 upgrade) are refused.
- cubed reaches the guest's sshd with `POST /v1/vms/{vmId}/dial?port=22`
  (`Upgrade: cube-tcp`), which the `dial` subcommand wraps for OpenSSH's
  `ProxyCommand`. Only port 22 can be dialled.

## CLI

```
cube-gateway serve --state DIR --control SOCK --decide SOCK --network loopback|direct|relay [--listen ADDR]
cube-gateway dial --control SOCK --vm ID --port 22
cube-gateway --version
```

`serve` prints one line on stdout once the control socket listens,
`{"ready":true,"version":…,"peer":…,"caSha256":…}`, and exits when stdin
reaches EOF (cubed's lifeline), on SIGTERM or on SIGINT. The control socket
is created 0600; a stale socket is replaced, a live one is refused.

The control API and the decision API are specified in the plan (Gateway
interfaces). The gateway's Iroh key is `state/iroh.key` (0600). Its endpoint
accepts no connections; it only dials runners. A loopback gateway reaches
loopback runners, direct reaches loopback and direct, relay (N0) reaches all.

The `test-hooks` cargo feature adds `--test-upstream HOST=ADDR` and
`--test-upstream-ca FILE`, mapping hosts to local fakes without the public
address check. Release builds never enable it. The crate's own tests enable
it through a self dev-dependency.

## Tests

`cargo test -p cube-gateway` runs offline:

- unit tests: address classification, DNS, placeholders, decision parsing,
  CA files and leaf chains;
- `tests/lan.rs`: a smoltcp test guest on an in-memory frame pipe: DHCP lease
  and MTU, DNS, HTTPS through an allow decision with Bearer and Basic
  substitution, deny/timeout/malformed decisions, RST for other ports, Host ≠
  SNI, no SNI, private upstreams refused while allowed, no secrets over HTTP,
  upgrades refused, dial into the guest, 4 MiB both ways;
- `tests/link.rs`: the whole gateway over Iroh loopback with a fake runner
  that authorizes the frame hello: attach, lease, `dial` over the control
  socket, wrong token refused, token rotation replacing the connection,
  attach validation, a second gateway refused on a live socket.

## Manual run with a real guest

`dev/run-vm.sh` boots a Debian 13 genericcloud image whose only NIC goes
through `examples/dev-pump.rs` (stands in for the runner's pump) to the
gateway, with `examples/dev-decide.rs` allowing everything. It needs KVM,
QEMU ≥ 7.2, genisoimage and OpenSSH, and keeps all state in its work directory.

```sh
cargo build --release -p cube-gateway --bins --examples
mkdir -p /tmp/gateway-dev && cp debian-13-genericcloud-amd64.qcow2 /tmp/gateway-dev/debian.qcow2
packages/gateway/dev/run-vm.sh /tmp/gateway-dev
```

Results on server1 (2026-10-04, gateway, pump and QEMU 8.2 on one host):

| | |
|---|---|
| boot to guest checks done | 12-13 s |
| DHCP lease 10.77.0.2/24, MTU 1500, DNS via .1 | ok |
| `curl https://example.com` (intercepted, CA from the seed) | 200 in 0.05 s |
| 100 MB HTTPS download (nbg1-speed.hetzner.com), intercepted | 45, 33 and 36 MB/s (host direct: 58-79 MB/s) |
| TCP to 1.1.1.1:22 | refused (RST) |
| `http://169.254.169.254/`, `http://10.77.0.1/` | 403, upstream address is not public |
| `ssh` with `ProxyCommand cube-gateway dial` | ok |
| gateway exit on lifeline EOF | ok |
