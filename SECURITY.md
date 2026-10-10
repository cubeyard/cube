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

Thread machines: a runner runs no command of its own for a thread. Each active
thread gets a QEMU virtual machine on its runner, and the agent's commands run
as user `agent` inside that guest (with passwordless sudo in the guest). The
guest is the thread's sandbox, the isolation boundary between a thread and the
runner host. QEMU
itself runs as the runner account and is hardened only by
`-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`
on Linux (nothing on macOS); a guest escape through a QEMU bug has that
account's authority, so the runner host as a whole is not a sandbox. Give the
runner account no control-plane, provider, GitHub, SSH or cloud credentials,
no sudo and no privileged group other than `kvm`. A retained machine disk
(a thread archived with changes) stays readable by the runner account.

**The host runner is not a sandbox.** `cube-runner host --dir DIRECTORY`
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

A guest's only network is raw Ethernet frames, carried by the runner over Iroh
to `cube-gateway` next to cubed. The gateway gives each VM a private LAN and
terminates every TCP connection: only ports 80 and 443 are served, other TCP
is reset, and an upstream is refused unless every address it resolves to is
public unicast (no loopback, RFC 1918, link-local/metadata, CGNAT, ULA or
mapped forms) and none of the gateway host's own interface addresses, so a
guest cannot reach cubed, the runner, the LAN or a cloud metadata service. A
request with more than one Host header is refused before any decision.
This round the policy allows every public host: the boundary does not stop
an agent sending what it can read (its workspace, the project's repositories)
to a public HTTPS server. HTTPS is intercepted with a per-installation CA
(`CUBED_STATE/gateway/ca.key`, 0600, never leaves that directory; treat it as
an installation credential and back it up with the state). cubed decides every
request (method, host, path, thread) on a 0600 socket; a deny, a timeout or a
malformed answer is a 403. Clients that pin certificates or ignore the system
CA bundle fail against the interception.

Secrets never enter a guest, its seed or the runner. The guest sees a
placeholder (`GH_TOKEN=cube_ph_github_…`); the gateway substitutes the host's
GitHub token only when cubed's policy returns it, and the policy returns it
only for that VM's own placeholder, over HTTPS, to github.com and
api.github.com. The token is the host's `gh auth token` (or
`CUBED_GITHUB_TOKEN`), so the agent acts with that account's GitHub authority
on those hosts, including pushes; use an account whose repository access you
accept for agents. The gateway keeps no secret beyond the request it serves.

cubed reaches the guest with the system OpenSSH client through the gateway; it
generates each VM's host key and pins it, and its per-VM client key may only
run the guest helper (`restrict,command=`). Nothing listens on the runner for
the guest. The runner's frame channel is authorized per VM by the latest
epoch-fenced `vm.start` (gateway peer and a per-start token). See the
[runner security and operations runbook](docs/runner-operations.md).
Snapshots, finer per-request policy (macaroons) and a separate download exit
are later work.

Work artifacts ([docs/artifacts.md](docs/artifacts.md)) are agent-written
documents the browser renders as data: raw HTML is shown as text, links are
http(s), mailto or cube's own pages, images are links, and Mermaid diagrams
are shown as images of their SVG. Their only side effect is a typed
`github.merge` action, which agents can declare but never run: cubed checks
the repository against the artifact's project and the pull request's live
head, the user confirms the exact target, and cubed merges with the host's
GitHub token pinned to that head. Anyone who can reach cubed can confirm one,
like every other control. A thread may revise any artifact of its own
project, not another project's; a revision keeps the earlier ones whole,
runs nothing, and keeps a merge pinned to the head it names.

Claude Code threads run the unmodified `claude` binary on the cubed host, as the
cubed user, with that user's own Claude login. cubed never stores Claude
credentials. The child's environment is an allow-list (home, path, locale,
temporary and XDG directories, proxies and certificates, `CLAUDE_CONFIG_DIR` and
`CLAUDE_CODE_OAUTH_TOKEN`) plus the workspace variables: no `ANTHROPIC_*`
variable, no Bedrock/Vertex/Foundry switch, and none of cubed's provider, Git or
cloud credentials. Claude Code starts with `--setting-sources ""`,
`--strict-mcp-config` and an empty MCP configuration, so the user's settings
hooks and MCP servers do not load, and `--tools` limits it to the mod's
allow-list. The mod sends Bash, Read, Write and Edit to the thread's machine (a
file path outside the workspace names a file in that machine, read and written
with the guest `agent` account's permissions, never one on the cubed host) and
refuses every other tool not on that list (MCP tools and unknown built-ins
included) and every subagent. Claude Code itself still runs on the cubed host with the cubed user's
authority and reads its own login from its config directory: it is not
sandboxed either, and these guards depend on Claude Code honouring its flags
and hooks, which no real session has verified yet. The mod reaches the
thread workspace on a mode-0600 Unix socket under `CUBED_STATE/run` that serves
only workspace routes; the thread's lease token, passed in the child's
environment, is the authorization, and it stops working when the thread's lease
is released. That token cannot renew or release cubed's own lease over the
routes; only cubed does.
