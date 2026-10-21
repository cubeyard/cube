# cube-netstack

A guest's network in user space, without policy or secrets. Taken out of
[`cube-gateway`](../gateway) without behaviour change (masterplan B-3):
[`berth vm`](../berth) gives each keel machine its own stack (B-4), and the
gateway, now only the credential proxy, uses its HTTP half.

| Module | What it is |
|---|---|
| `lan` | one LAN per guest on raw Ethernet frames: smoltcp, with the addresses an `Addressing` names (`berth vm`: 192.168.127.0/24, fixed in the guest, no DHCP; `Addressing::P3`, 10.77.0.0/24 with DHCP, was the protocol-3 gateway's and has no caller now). TCP to 80/443 handed to a `FlowHandler`, everything else reset or dropped, dialling into the guest |
| `dns` | the guest's DNS: A records only, AAAA empty, other types NOTIMP |
| `addr` | the upstream address check: globally routable unicast and none of this host's own addresses |
| `ca` | a CA kept in a directory (`ca.key` 0600, `ca.pem` 0644) and the leaf cache for intercepted HTTPS; with feature `loaded-ca`, `Ca::from_loaded` for a CA its owner loads (berth's runner CA), whose leaves name the certificate's own issuer |
| `http` | TLS termination by SNI, the `Host` checks, hop-by-hop headers, the host resolver and the upstream connection with the address check (`connect_avoiding` adds addresses to refuse as this host's own) |
| `placeholder` | how a placeholder secret (`cube_ph_<name>_<22 base62>`) looks in header values, also in a decoded `Basic` credential: the gateway substitutes them, berth refuses them; no secret is here |

What a guest may reach and which secrets a request carries are the caller's:
the gateway asks cubed per request and substitutes placeholders itself;
berth decides from the machine's policy and never substitutes.

The `test-hooks` feature lets `Upstream` map hosts to local fakes without the
address check; release builds never enable it (`cube-gateway`'s own
`test-hooks` turns it on).

`cargo test -p cube-netstack` runs the unit tests offline. The LAN end to end
(DNS, HTTPS, refusals, dialling in, with a fixed address and no DHCP) is
tested through berth in `packages/berth/src/vm/egress/tests.rs`; the DHCP
path lost its end-to-end test with the gateway's LAN.
