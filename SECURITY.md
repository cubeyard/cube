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

The trusted runner is not a sandbox. Its dedicated unprivileged account is an
explicit trust boundary and must carry no control-plane, provider, cloud or
unrelated credentials. A private repository necessarily requires a
repository-scoped, preferably read-only Git credential or deploy key in that
account so allocation can fetch a fresh base. Agent commands run as the same UID
and can access that credential; Cube does not claim otherwise. Cube does not
enforce trusted-runner egress;
operators must enforce network policy at the OS/network layer. See the
[trusted-runner security and operations runbook](docs/trusted-runner-operations.md).
Workspace-relative cwd validation prevents traversal and symlink races on both
Linux and macOS, but commands retain all filesystem authority of that account.
Per-thread Git worktrees or copied directories reduce accidental workspace
collisions only. They do not prevent a command from reading or modifying another
workspace through an absolute path. Container/VM or native process isolation is
separate future work.
Fresh-base fetches use validated remote/ref inputs, a runner-owned bare control
repository and an exact fetched commit OID. They do not checkout or rewrite the
operator's template worktree. Fetch failures fail closed rather than using stale
template state. This is workspace freshness and collision isolation, not
sandboxing or protection from malicious same-UID Git configuration.
Process-group cancellation is not a cgroup: especially on macOS, a hostile
command can deliberately create a new session and escape descendant cleanup.

JEV memory is opt-in. When configured, Cube sends selected conversation text,
tool arguments, and deterministic tool-output excerpts to TypeSafe AI. These
may contain repository content or secrets printed by tools. The JEV key is kept
only on the control-plane host in a mode-`0600` state file and is never returned
by the API, forwarded to a runner, or included in session data. Full outputs
retained for recall remain part of the local Pi session and are withheld from
ordinary browser history; a permitted private-network Cube client can request an
original explicitly from the tool inspector. Do not enable JEV for repositories
whose disclosure policy does not permit this processing.
