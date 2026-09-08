# Security policy

cube runs coding agents against repositories and keeps provider and GitHub
credentials on the VM host. Security reports are taken seriously.

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

cubed does not provide application-level authentication. Keep it on loopback
or a trusted private network such as a Tailnet; never expose it directly to the
public internet. The launcher refuses public bind addresses, but operators are
responsible for the surrounding VM, network, and access controls.
