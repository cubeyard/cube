# Security policy

cube runs coding agents against repositories and keeps provider and GitHub
credentials on the control-plane host. Security reports are taken seriously.

## Supported versions

Security fixes target the latest release and `main`. Pre-1.0 releases do not
receive guaranteed backports.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/cubeyard/cube/security/advisories/new).
Please include the affected version, impact, reproduction steps, and any known
mitigation. Do not open a public issue with vulnerability details.

If private reporting is unavailable, open a public issue containing no
sensitive details and ask the maintainer for a private contact channel.

## Important deployment boundary

cubed does not provide application-level authentication. It defaults to loopback;
use an authenticated private proxy or explicitly configured Tailscale/private
network binding for remote access. Every permitted network client has full Cube
access. `CUBED_HOST=0.0.0.0` listens on all IPv4 interfaces, not only Tailscale;
firewall/network controls must enforce the private boundary. The HTTP host
allowlist is not a substitute for those controls. Never expose cubed directly
to the public internet. Operators are responsible for network/access controls.

Images attached to OptChat messages are kept under `CUBED_STATE/optchat/media`
and served to every client admitted by that boundary. cubed takes only PNG,
JPEG, GIF and WebP, recognized by their bytes, and serves a message's image
with `nosniff`, a sandboxing content security policy and a same-origin
resource policy; they are sent to the chat's model provider with the turn.

The optional service portal (`CUBED_PORTAL_IP`, off by default) is a second
listener with the same boundary: no authentication, plain HTTP, bound only to
a private or loopback IPv4 address. Anyone who reaches it and knows a service
URL reaches that thread's web server. The Homebrew launcher turns it on by
default on loopback under `*.localhost`: a thread's agent can then show a
page in a browser on that Mac without further setup, in a secure context of
the service's own origin, and any local process can reach the port. It routes only exact per-service Host
names to ports the guest registered, serves nothing of cube's and never starts
a machine; see [docs/services.md](docs/services.md).

GUI-driven cubed updates do not add an application authorization layer. Every
client admitted by that deployment boundary can request an update when the
operator has explicitly set `CUBED_GUI_UPDATES=1`. The HTTP process is limited to
a random capability inherited from its foreground supervisor; the local control
socket and persisted status are mode 0600. Release manifests are Ed25519-signed
and bind artifact size and SHA-256. The installed public key is the trust anchor;
key rotation or supervisor upgrades require the external installer. Keep the
release signing key in protected release automation, and verify the initial key
through a trusted channel. The canonical cubed update-key fingerprint is
`SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451`
(SHA-256 of DER-encoded SPKI) and is pinned under `scripts/cubed/`. Updates
preserve the external state and credential directories, but only the exact
state-schema/rollback contract in a signed manifest is supported. Runner
software is outside this update mechanism.

Thread machines: a runner runs no command of its own for a thread. Each open
thread gets a keel machine under QEMU on its `berth vm` runner, and the
agent's commands run as user `agent` inside that guest. The
guest is the thread's sandbox, the isolation boundary between a thread and the
runner host. QEMU
itself runs as the runner account and is hardened only by
`-sandbox on` on Linux (nothing on macOS); a guest escape through a QEMU bug has that
account's authority, so the runner host as a whole is not a sandbox. Give the
runner account no control-plane, provider, GitHub, SSH or cloud credentials,
no sudo and no privileged group other than `kvm`. A retained machine disk
(a thread archived with changes) stays readable by the runner account.

**The host runner is not a sandbox.** `berth host --dir DIRECTORY`
(runner protocol 4) exists only to develop and debug cube runners from a
thread. A thread started on it by name runs its commands and file
operations directly on that host, as the user who started the runner, with
that user's files, network, SSH keys and gh/git logins; nothing isolates it,
and no egress policy applies. If it runs on the same machine as cubed, the
agent can also reach cubed's unauthenticated API. cubed sends it no
secrets, placeholders or proxy (it uses the host's own logins), never places
a thread there that was not named to it, and never moves a thread there.
Run it only in a terminal you watch, on a host and account whose authority
you accept for the agent, and stop it with Ctrl-C when done; commands it
started keep running until they end.

A guest's only network is one virtio-net device on a LAN of its own inside
berth (cube-netstack): DNS, and TCP to ports 80 and 443 only (other TCP is
reset, other UDP dropped). An upstream is refused unless every address it
resolves to is public unicast (no loopback, RFC 1918, link-local/metadata,
CGNAT, ULA or mapped forms) and none of the runner host's own addresses or
the addresses it reaches cubed at, so a guest cannot reach cubed, the
runner, the LAN or a cloud metadata service (over a relay-only connection
only the policy's `deny_hosts` keeps it from cubed's hosts). Each start
carries cubed's egress policy for the machine; this round it allows every
public host, so the boundary does not stop an agent sending what it can
read (its workspace, the project's repositories) to a public HTTPS server.
HTTPS is intercepted with the runner's own CA (`<dir>/.berth/ca/`, 0600 key,
made on the runner's first start); clients that pin certificates or ignore
the system CA bundle fail against the interception.

Secrets never enter a guest or a runner. The guest sees a placeholder
(`GH_TOKEN=cube_ph_github_…`); a request a credential rule matches (HTTPS to
github.com or api.github.com) goes from the runner over a `credential`
stream to cubed, which checks the machine and its fence and carries it to
`cube-gateway`. The gateway asks cubed's policy, which returns the host's
GitHub token only for that machine's own placeholder, over HTTPS, to
github.com and api.github.com, substitutes it, and turns it back into the
placeholder in the answer. The token is the host's `gh auth token` (or
`CUBED_GITHUB_TOKEN`), so the agent acts with that account's GitHub
authority on those hosts, including pushes; use an account whose repository
access you accept for agents. The gateway keeps no secret beyond the request
it serves.

cubed reaches the guest only over the runner's authenticated, epoch-fenced
`guest` and `dial` streams; nothing listens on the guest except what the
portal dials (ports 1024-65535). See the [runner security and operations
runbook](docs/runner-operations.md). Finer per-request policy (macaroons) and
a separate download exit are later work.

Work artifacts ([docs/artifacts.md](docs/artifacts.md)) are agent-written
documents the browser renders as data: raw HTML is shown as text, links are
http(s), mailto or cube's own pages, images are links, and Mermaid diagrams
(in artifacts and the chat) are drawn by Pele in the browser, with links and
images off, and shown as images of their SVG; cubed checks an artifact's
diagrams with the same library in a worker thread bounded by size, count, a
deadline and a heap cap. No diagram source is sent to a rendering service. Their only side effect is a typed
`github.merge` action, which agents can declare but never run: cubed checks
the repository against the artifact's project and the pull request's live
head, the user confirms the exact target, and cubed merges with the host's
GitHub token pinned to that head. Anyone who can reach cubed can confirm one,
like every other control. A thread may revise any artifact of its own
project, not another project's; a revision keeps the earlier ones whole,
runs nothing, and keeps a merge pinned to the head it names.

Claude Code threads run the unmodified `claude` binary on the cubed host, as the
cubed user. Their model traffic goes through cube-gateway's model channel: a
listener on `127.0.0.1` that the gateway picks a port for. The child gets
`ANTHROPIC_BASE_URL` pointing at it (the thread's id in the path, the
host added to `NO_PROXY`) and `CLAUDE_CODE_OAUTH_TOKEN` set to that thread's
placeholder (`cube_ph_claude_…`), never the real token. The real token is the
host's long-lived one from `claude setup-token`, given to cubed as
`CLAUDE_CODE_OAUTH_TOKEN` in cubed's own environment; cubed does not store it.
Any local process can connect to the listener, so the placeholder is what
authorizes a request: the gateway refuses one without exactly one `claude`
placeholder, to a route other than `POST /v1/messages` and
`POST /v1/messages/count_tokens`, or that cubed's policy denies (the
placeholder must be the live one of the thread the path names; 5 s, fail
closed). It then substitutes the token, sends the request to
api.anthropic.com over TLS and turns the token back into the placeholder in
the streamed answer. Each exchange, refusals included, is kept in
`CUBED_STATE/model-audit.sqlite` (0600, append-only): the request body as the
child sent it and the answer as the child got it, by SHA-256, with an
allow-list of headers (never `Authorization`), and web search results as events
of their own. That file holds the threads' prompts, code and answers in full;
protect it like the state directory. Without the token or the listener a
Claude Code turn fails and says why; there is no fallback to Claude Code's own
login or an API key. Claude Code still reaches some Anthropic services
directly, not through the base URL (start-up bootstrap, feature flags,
telemetry); those requests carry only the placeholder, so Anthropic refuses
them. The child's environment is otherwise an allow-list (home, path,
locale, temporary and XDG directories, proxies and certificates,
`CLAUDE_CONFIG_DIR`) plus the workspace variables: no inherited `ANTHROPIC_*`
or `CLAUDE_CODE_OAUTH_TOKEN`, no Bedrock/Vertex/Foundry switch, and none of
cubed's provider, Git or cloud credentials. The child runs as the cubed user,
so it can still read what that user can, a login Claude Code stored in its
config directory included: the placeholder keeps the token out of its
environment and requests, not out of reach of a process with the cubed user's
authority. Claude Code starts with `--setting-sources ""`,
`--strict-mcp-config` and an empty MCP configuration, so the user's settings
hooks and MCP servers do not load, and `--tools` limits it to the mod's
allow-list. The mod sends Bash, Read, Write and Edit to the thread's machine (a
file path outside the workspace names a file in that machine, read and written
with the guest `agent` account's permissions, never one on the cubed host) and
refuses every other tool not on that list (MCP tools and unknown built-ins
included) and every subagent. Claude Code itself still runs on the cubed host with the cubed user's
authority (it holds a placeholder for its model, not the token): it is not
sandboxed either, and these guards depend on Claude Code honouring its flags
and hooks, which no real session has verified yet. The mod reaches the
thread workspace on a mode-0600 Unix socket under `CUBED_STATE/run` that serves
only workspace routes; the thread's lease token, passed in the child's
environment, is the authorization, and it stops working when the thread's lease
is released. That token cannot renew or release cubed's own lease over the
routes; only cubed does.
