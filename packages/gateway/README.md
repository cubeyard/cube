# cube-gateway

The credential proxy of runner protocol 4 (masterplan B-5). cubed starts and
supervises it (`packages/server/src/gateway.ts`); it is the only process that
holds a real secret a guest uses. The HTTP half (Host checks, hop-by-hop
headers, the public-address check, the upstream) is
[`cube-netstack`](../netstack)'s; the decision call, the secrets and B6 are
the gateway's own.

```
guest ─ berth vm's LAN ─ credential rule matches ─ Open.credential stream ─ cubed (checks machine and fence)
                                                                              │ credential.sock
                                                                              ▼
                                                                         cube-gateway
                                                                              ├─ POST /v1/decide → cubed (egress.sock)
                                                                              └─ upstream over TLS from this host: public addresses only
```

A `berth vm` runner sends each guest request a credential rule matches over a
`credential` stream to cubed, which checks the machine and fence, connects to
`--credential SOCK` (0600, in cubed's 0700 run directory; only cubed
connects, as the same user), writes the stream's `CredentialHeader` (u32
length, at most 64 KiB, then proto3 JSON) and then carries bytes unread. Per
connection the gateway serves one HTTP/1.1 request as HTTPS for the header's
server name (`sni` = `host`, port 443, and the request's `Host` must match):

- `CONNECT` and `Upgrade` are refused, and every placeholder must be of the
  header's credential (else 403);
- cubed's decision API is asked about every request (`egress.sock`; deny,
  timeout (5 s), socket error or malformed answer: 403 with
  `x-cube-denied: <reason>`); placeholder secrets
  (`cube_ph_<name>_<22 base62>`) in header values, including decoded
  `Authorization: Basic`, are listed in the request and substituted only when
  the answer returns them;
- the upstream is the server name, resolved here and refused unless every
  address is public unicast and none of this host's own; upstream TLS uses
  the system roots;
- `Accept-Encoding: identity` is sent upstream, and an answer with any other
  `Content-Encoding` is refused (502);
- B6: each value the gateway substituted (the token, and each `Basic`
  credential it re-encoded) is turned back into the guest's own (its
  placeholder, its encoding) in every answer header and in the body as it
  streams (`src/reverse.rs`: it holds back at most the longest value less
  one byte, so a value split across chunks is found; `Content-Length` is
  dropped when the length may change, except where there is no body).
  A value upstream encodes another way (base64 of the token alone, URL
  encoding) is not found;
- no keep-alive: one request per connection. A redirect is passed on
  (rewritten as above), never followed, and no credential is added to it.

The gateway keeps no state of its own. (Until protocol 3 was retired it was
also the protocol-3 runners' network, with a LAN per VM over Iroh, a control
socket and an installation CA under `CUBED_STATE/gateway`; an installation
that ran those keeps that directory, which nothing reads any more.)

## CLI

```
cube-gateway serve --decide SOCK --credential SOCK
cube-gateway --version
```

`serve` prints one line on stdout once the credential socket listens,
`{"ready":true,"version":…}`, and exits when stdin reaches EOF (cubed's
lifeline), on SIGTERM or on SIGINT, removing its socket. The socket is
created 0600; a stale socket is replaced, a live one is refused.

The `test-hooks` cargo feature adds `--test-upstream HOST=ADDR` and
`--test-upstream-ca FILE`, mapping hosts to local fakes without the public
address check. Release builds never enable it. The crate's own tests enable
it through a self dev-dependency.

## Tests

`cargo test -p cube-gateway` runs offline:

- unit tests: placeholders, decision parsing, the credential header's checks
  (address classification, DNS, Host checks and hop-by-hop headers are
  `cargo test -p cube-netstack`);
- `tests/credential.rs`: the credential proxy over its socket with a local
  TLS upstream: the token upstream and only the placeholder back (Bearer;
  Basic as the guest encoded it; split across chunks at every position),
  identity forced and encoded answers refused, redirects passed on and not
  followed, other credentials' placeholders, a `Host` other than the server
  name and cubed's denial refused, `Content-Length` kept without a
  substitution and for HEAD, 8 MiB up and 16 MiB down, one request per
  connection, a bad or oversized header closing the connection unanswered.

`packages/server/test/gateway-test.ts` drives the real binary from cubed's
supervisor in `scripts/test-node-transport.sh`; the whole chain (berth vm, a
keel machine, cubed, the gateway, a fake GitHub) is
`packages/server/test/runner-vm-test.ts` (V5, V6).
