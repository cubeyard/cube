# cube-netstack

A guest's network in user space, without policy or secrets. Taken out of
[`cube-gateway`](../gateway) without behaviour change (masterplan B-3) so that
`berth vm` can give each keel machine its own stack; today only the gateway
uses it, for protocol-3 runners.

| Module | What it is |
|---|---|
| `lan` | one LAN per guest on raw Ethernet frames: smoltcp, 10.77.0.0/24, DHCP (fixed lease .2, router and resolver .1, MTU 1500), TCP to 80/443 handed to a `FlowHandler`, everything else reset or dropped, dialling into the guest |
| `dns` | the guest's DNS: A records only, AAAA empty, other types NOTIMP |
| `addr` | the upstream address check: globally routable unicast and none of this host's own addresses |
| `ca` | a CA kept in a directory (`ca.key` 0600, `ca.pem` 0644) and the leaf cache for intercepted HTTPS |
| `http` | TLS termination by SNI, the `Host` checks, hop-by-hop headers, the host resolver and the upstream connection with the address check |

What a guest may reach and which secrets a request carries are the caller's:
the gateway asks cubed per request and substitutes placeholders itself.

The `test-hooks` feature lets `Upstream` map hosts to local fakes without the
address check; release builds never enable it (`cube-gateway`'s own
`test-hooks` turns it on).

`cargo test -p cube-netstack` runs the unit tests offline. The LAN end to end
(a smoltcp test guest, DHCP, DNS, HTTPS, refusals, dialling in) is tested
through the gateway in `packages/gateway/tests/lan.rs`.
