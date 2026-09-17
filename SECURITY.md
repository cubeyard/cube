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

cubed does not provide application-level authentication. It binds loopback;
use an authenticated private proxy for remote access. Never expose it directly
to the public internet. Operators are responsible for network/access controls.

The trusted runner is not a sandbox. Its dedicated unprivileged
account is an explicit trust boundary and must carry no control-plane, provider,
Git, SSH, or cloud credentials. Cube does not enforce trusted-runner egress;
operators must enforce network policy at the OS/network layer. See the
[trusted-runner security and operations runbook](docs/trusted-runner-operations.md).
Workspace-relative cwd validation prevents traversal and symlink races on both
Linux and macOS, but commands retain all filesystem authority of that account.
Process-group cancellation is not a cgroup: especially on macOS, a hostile
command can deliberately create a new session and escape descendant cleanup.
