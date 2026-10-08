# Services and the portal

A thread's agent can run a web server in its machine as a **service** and
give the user a URL for it. The URL goes to cubed's **portal**, which passes
plain HTTP and WebSocket traffic to the service through the gateway and the
runner, the path cubed already uses for the guest's sshd. The portal is
private: it listens only on a private address of the cubed host (a Tailscale
address, typically) and has no login of its own.

## For thread agents: `cube service`

A command an agent runs ends in its own transient systemd unit, and a server
it started goes with it. `cube service` runs the server as a separate,
supervised unit instead and registers its port for the portal:

```
cube service start NAME --port PORT [--cwd DIR] [--env KEY=VALUE]... [--wait SECONDS] [--json] -- COMMAND...
cube service open NAME --port PORT [--wait SECONDS] [--json]
cube service list [--json]
cube service status NAME [--json]
cube service logs NAME [-n LINES] [-f]
cube service restart NAME [--wait SECONDS] [--json]
cube service stop NAME [--json]
```

- `start` writes the registration, starts the unit
  (`cube-service-NAME.service`, as `agent`, in the caller's directory or
  `--cwd`, with the same environment as agent commands plus `PORT`,
  `HOST=0.0.0.0` and the `--env` values), waits up to `--wait` seconds
  (default 60) until something accepts connections on the machine's LAN
  address and port, sends one `GET /`, and prints the status line and the
  URL. If the unit fails, exits or never listens, it says so with the last
  lines of its output and exits 1; the registration stays so that `logs`,
  `restart` and `stop` work. `start` with a name in use replaces it.
- `open` registers a server that already runs on its own (its own unit, a
  container) under a name; it is not supervised and has no logs here.
- `list` and `status` show each service's state, restarts, whether it
  listens and its URL; `logs` reads the unit's journal.
- `stop` removes the registration first (the portal stops routing to it),
  then stops and deletes the unit.

Rules: names are 1-24 lowercase letters, digits and dashes, starting with a
letter; ports are 1024-65535, one service per port, at most 16 services per
machine. A service must listen on `0.0.0.0` (or the machine's address), not
only on 127.0.0.1: the portal connects over the machine's network.
`start` names the problem when a port answers only on loopback. Many dev
servers need a flag (`vite --host 0.0.0.0`) and some check the Host header
(Vite's `server.allowedHosts`: allow the portal's suffix, for example
`.sslip.io`). Services restart when they fail (at most 5 times a minute) and
when the machine boots again. Without a configured portal the command says
so instead of printing a URL; the service still runs.

The CLI is the guest helper itself (`/usr/local/bin/cube` is a shim for
`cube-guest cli`). It needs root for units and registrations and gets it
through the agent's sudo. Registrations are JSON files under
`/var/lib/cube/services/`, written atomically under the helper's lock. Pi and
Claude Code threads learn about it from one sentence in their instructions.

## How the command gets into machines

- **New machines** get the helper and the shim from their seed, like the
  rest of the helper.
- **Machines from a template**: the template key includes the helper's
  hash, so a new helper means a new template. Each machine's seed writes the
  current helper anyway. A template's seal removes `cube-service-*` units
  (and their registrations go with `/var/lib/cube`); a template machine's
  first boot removes any that a failed seal left.
- **Existing machines** (made by an older cubed, a reused disk) are brought
  up to date when cubed resumes them: on every machine boot and on every
  cubed start, before the agent opens. The helper's `hello` reports a
  `build` (the sha256 of its file). When it differs from the helper cubed
  ships, cubed sends the new helper with the helper's `install` operation
  (content-addressed; it also writes the shim). A helper from before
  `install` existed has no `build`; cubed then replaces it once with a few
  of its own ordinary commands (`cube:helper:<epoch>:<n>`): the gzipped
  helper in chunks under `/var/tmp`, checked against its sha256 and
  installed by the new helper's own `install` as root. These commands are
  cubed's, not the agent's, so they do not keep a disk at archive. A failure
  is logged ("the machine's cube command could not be brought up to date")
  and does not stop the thread.
- Every resume also writes `/etc/cube/portal.json` with the `portal`
  operation: the machine's URL template, or why there is no portal.

A running command keeps the helper code it started with; the journal format
did not change, so commands that span a replacement finish normally.

## The portal

```
browser ──HTTP──▶ cubed portal (CUBED_PORTAL_LISTEN:CUBED_PORTAL_PORT)
                     │ Host → thread label + service name → registered port
                     ▼
                 cube-gateway dial route (control socket, Upgrade: cube-tcp)
                     ▼
                 Iroh frame channel → runner → guest 10.77.0.2:PORT
```

Each service has its own origin:

```
http://<service>-<thread label>.<suffix>:<port>/
```

The thread label is the first 10 hex characters of an HMAC-SHA256 of the
thread id under a random key in `CUBED_STATE/portal/key`, so labels are
stable for a thread and not derivable from thread ids. With the default
domain the suffix embeds the IP: `100-101-102-103.sslip.io`, which public
DNS (sslip.io, or nip.io) answers with 100.101.102.103 for any name. A
loopback portal can use `localhost` instead (`http://web-<label>.localhost:7780/`):
browsers and curl resolve every `*.localhost` name to the machine they run
on themselves (RFC 6761), with no DNS at all, so it works only in a browser on
cubed's own host.

### Setting it up

The portal is off unless `CUBED_PORTAL_IP` is set, except under Homebrew
(below). Settings (environment of the cubed service; nothing in a live
installation changes by itself):

| variable | default | meaning |
|---|---|---|
| `CUBED_PORTAL_IP` | (off) | the private address browsers use, e.g. the cubed host's Tailscale IP (`tailscale ip -4`) |
| `CUBED_PORTAL_PORT` | `7780` | the portal's port, in every URL |
| `CUBED_PORTAL_LISTEN` | `CUBED_PORTAL_IP` | the address it binds; private or loopback IPv4 only |
| `CUBED_PORTAL_DOMAIN` | `sslip.io` | `sslip.io` or `nip.io` (IP embedded), a wildcard domain of your own that resolves to the IP, or `localhost` (loopback IP and listen address only) |

cubed refuses public addresses and `0.0.0.0` for both the IP and the listen
address, `localhost` (or any `*.localhost` domain) with an IP or listen address
outside 127.0.0.0/8, and refuses to start on a malformed setting.

**Homebrew.** The formula's `cubed` launcher reads
`~/.config/cubed/environment`; when it sets none of `CUBED_PORTAL_IP`,
`CUBED_PORTAL_LISTEN` and `CUBED_PORTAL_DOMAIN`, the launcher sets
`CUBED_PORTAL_IP=127.0.0.1 CUBED_PORTAL_DOMAIN=localhost`: a portal on
`127.0.0.1:7780` (or `CUBED_PORTAL_PORT`) with URLs that open in a browser on
the same Mac. Settings of your own are kept as they are, a partial one
included; `CUBED_PORTAL_IP=` (empty) turns the portal off. Other devices
need the Tailscale setup below, not `localhost`.

A Tailscale setup:

```
CUBED_PORTAL_IP=$(tailscale ip -4)   # e.g. 100.101.102.103
# restart cubed; /api/health then reports "portal": "listening"
```

Every running machine learns the new URLs at that restart. Use Tailscale
ACLs to decide which devices may reach the port. To serve it on port 80
(URLs without a port), give cubed's account the right to bind it or use
`CUBED_PORTAL_LISTEN=127.0.0.1` behind a private proxy on port 80 that
keeps the Host header.

### What it allows

- Only Host values of exactly the form above, with the configured suffix
  and port, case-insensitive. Anything else (the IP itself, cube's own
  host, another suffix or port, absolute-form request targets) is a 404 or
  400 from the portal; no cube page, API or static file is served on it.
  This is what defeats DNS rebinding: a page on a public name that rebinds
  to the portal's IP still sends its own name as Host.
- Only services registered in the guest, read with the helper's
  `services` operation (cached 2 s), only while cubed has the thread's
  machine running and the thread is not archived or archiving. The portal
  never starts or resumes a machine: a sleeping thread answers 503.
- Only the registered port, through the gateway's dial route, which itself
  allows only port 22 and 1024-65535. The request never names a target.
- Hop-by-hop headers and any `Forwarded`/`X-Forwarded-*` the browser sent
  are dropped; the portal sets `X-Forwarded-For/Host/Proto`. Cookies a
  service sets lose their `Domain` attribute, so they stay with that one
  service's host and are never shared with cube or other services.
- At most 64 open connections per thread (the gateway gives a machine 256
  flows for everything). Responses stream with backpressure; a browser that
  goes away closes the connection to the service.
- WebSocket and other HTTP/1.1 upgrades are passed through as they came and
  the two connections joined. The gateway closes a flow idle for 10
  minutes, so a WebSocket needs some traffic (pings) within that time.

Stopping a service takes it off the portal within the 2 s cache (a dial
that fails drops the cache at once). Archiving a thread takes its services
off at once (the thread is archived before its machine is released, which
ends open connections).

### Caveats

- **HTTP only.** Traffic between the browser and the portal is plain HTTP;
  rely on the private network (Tailscale encrypts it) and do not expose the
  port elsewhere. Browsers treat sslip.io and other IP or domain origins as
  insecure contexts (no service workers, no `crypto.subtle`, no secure
  cookies); `*.localhost` origins are secure contexts (loopback never leaves
  the machine).
- **No login.** Anyone who can reach the port and knows a URL reaches the
  service. Labels are hard to guess, not secret: they appear in transcripts
  and logs.
- **localhost reaches only the browser's own machine.** A
  `*.localhost` URL opened on another device (a phone, another computer on the
  tailnet) goes to that device, not to cubed. Agents inside a thread's machine
  cannot open these URLs either: `localhost` there is the machine itself.
- **DNS.** sslip.io and nip.io are public resolvers you depend on; they see
  the names asked for (service name, thread label, private IP). Resolvers
  with rebinding protection (some routers, Pi-hole, dnsmasq
  `--stop-dns-rebind`, some corporate DNS) refuse public names that resolve
  to private addresses, and web filters (Fortinet and similar) may answer
  them with an address of their own; allow `sslip.io` there, use a wildcard
  record in your own DNS (`CUBED_PORTAL_DOMAIN`), or Tailscale's split DNS. Tailscale
  MagicDNS forwards other names to your resolvers, so the same applies.
- Every portal origin is a sibling under one suffix; the portal strips
  cookie domains, but a service still shares the browser's
  per-site state (for example `localStorage` is per origin and fine, while
  some heuristics treat a whole registrable domain together).

## Validation and gaps

Covered offline (`pnpm test`): the CLI and the new helper operations
(`guest_helper_test.py`, processes in place of systemd units), the
gateway's port policy and a dial to a service port
(`cargo test -p cube-gateway`), and the portal end to end over a local
guest (`portal-test.ts`): helper refresh at activation, the CLI's URL,
exact-host routing and refusals, forwarded headers, host-only cookies,
WebSocket upgrade, an abandoned 64 MiB download, no wake of a stopped
machine, stop and archive, and the chunked bootstrap of an old helper.
Once, by hand: headless Chromium (with `--host-resolver-rules` mapping
`*.sslip.io` to the offline portal, not real DNS) loaded a service's page by
its URL, completed a WebSocket round trip through the portal, kept the
service's cookie host-only, and got the portal's 404 for the bare IP.

The loopback default (`localhost`): `portal-test.ts` runs end to end with
the settings the Homebrew launcher produces, and
`scripts/homebrew-formula-test.ts` runs the generated launcher with no
environment file, other settings, a Tailscale IP, `CUBED_PORTAL_IP=` and a
partial configuration. Once, by hand on Linux, against cubed's real portal on
127.0.0.1:7780 with real name resolution (no host rules, no hosts entries):
curl, and headless Chromium 153, Firefox 155 and WebKit 26.6 (Playwright),
loaded two services of one thread by their `*.localhost` URLs, completed a
WebSocket round trip through the portal, kept each service's cookies on its
own host (a `Domain=localhost` attribute stripped), reported a secure
context, and could not read or post to cube's API; cube's API refused the
service host as Host. CI's `homebrew` job checks that curl and Safari on
GitHub's macOS runner reach a loopback server by a `*.localhost` name.

Not yet verified: a real VM (systemd units surviving the command's unit,
journal logs, restart at boot, the LAN address probe, a template build with
services, the gateway and a remote runner carrying the traffic), the
bootstrap against a real v1 helper in a VM, a browser on a Tailscale network
resolving sslip.io, macOS/HVF runners, and the Homebrew default on a real
Mac with a running thread machine. These need
`scripts/test-node-transport.sh` on a KVM host and a manual check.
