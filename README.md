# cube

Your own coding-agent box: a web UI of threads, each running the real
[pi](https://github.com/earendil-works/pi) terminal against its own isolated
sandbox — on a single VM you own. Self-hosted alternative to hosted agent
sandboxes (Amp Orbs and the like).

Every thread gets an unprivileged system container with inner Docker, a
capped disk, and default-deny egress behind a per-thread allowlist proxy.
The agent's tools run inside the container; your credentials never do.

> **Vibe-coded software:** cube was built largely with AI assistance and human
> review. It is experimental; inspect it carefully before trusting it with
> important work or credentials.

## Install

Three things on the host: a hypervisor, `ssh`, and `curl`. Nothing else runs
on the host — no Node, no Docker, no Incus, no Nix; the VM carries all of it.

**macOS** (Apple Silicon or Intel, uses HVF):

```sh
brew install cubeyard/tap/cube
cube up
```

Homebrew installs both the launcher and QEMU.

**Linux** (x86_64 or arm64) with KVM (`/dev/kvm`):

```sh
sudo apt install qemu-system qemu-utils genisoimage ovmf curl openssh-client
```

Then install the launcher manually (also works on macOS after `brew install qemu`):

```sh
mkdir -p ~/.local/bin
curl -fL https://github.com/cubeyard/cube/releases/latest/download/cube \
  -o ~/.local/bin/cube
chmod +x ~/.local/bin/cube                     # anywhere on PATH works
cube up
```

`cube up` checks the host, downloads the VM (~1.1 GB the first time),
boots it, and prints the URL — usually **http://127.0.0.1:7777**.
The first-run wizard offers GitHub login or a skip. Sign in to your model
provider separately with `/login` in the agent terminal.

## Everyday use

```sh
cube status     # VM status and available updates
cube upgrade    # update the VM and app; keep all data
cube down       # stop the VM
cube up         # start it again
cube logs       # follow server logs
cube events     # lifecycle events and timings
cube ssh        # open a shell on the VM
cube version    # launcher and installed release
```

Updates download only what changed. App-only updates apply without a
reboot. With Homebrew, run `brew upgrade cube` to update the launcher;
manual installations update it through `cube upgrade`.

State lives in `~/.cube`. Stop the VM before `brew uninstall cube`, which
keeps that data. **To delete the VM and all its data**, run
`cube destroy --yes` before uninstalling.

## Using it from other machines

The web UI has no authentication; your Tailnet is the access boundary.
Cube binds to the host's Tailscale IPv4 when available, otherwise only
loopback. To require Tailscale:

```sh
CUBE_BIND=tailscale cube up
```

Loopback stays available. Public addresses and `0.0.0.0` are refused.
Set `CUBE_BIND=127.0.0.1` for local-only use. Stop and restart the VM
after changing the bind setting.

## Development and contributing

See [DEVELOPING.md](DEVELOPING.md) for building from source, the VM and
mock development loops, configuration, and releases. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before sending a change;
[PLAN.md](PLAN.md) covers architecture and the phase plan.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md), not in
a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE). Vendored tooling retains its own notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
