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

The commands below require a published VM release in
[cubeyard/cube](https://github.com/cubeyard/cube/releases). Until the first
release (`v0.1.0`) is available, use
[Building from source](#building-from-source-the-dev-loop).

Three things on the host: a hypervisor, `ssh`, and `curl`. Nothing else runs
on the host — no Node, no Docker, no Incus, no Nix; the VM carries all of it.

**Linux** (x86_64 or arm64) with KVM (`/dev/kvm`):

```sh
sudo apt install qemu-system qemu-utils genisoimage ovmf curl openssh-client
```

**macOS** (Apple Silicon or Intel, uses HVF):

```sh
brew install qemu
```

Then:

```sh
mkdir -p ~/.local/bin
curl -fL https://github.com/cubeyard/cube/releases/latest/download/cube \
  -o ~/.local/bin/cube
chmod +x ~/.local/bin/cube                     # anywhere on PATH works
cube up
```

`cube up` checks the host first (hypervisor, firmware, ports, disk
space), downloads the latest release (~1.1 GB the first time, with
progress), creates a blank data disk, boots, and prints the URL —
usually **http://127.0.0.1:7777**. A busy port is skipped to the next
free one and remembered in `~/.cube/config`. A first-run wizard offers
GitHub login (or skip) before opening projects. Completion is remembered
on the VM. Model-provider `/login` is separate.

GitHub authentication uses the normal `gh auth login --web` device flow and
GitHub CLI's credential store. Cube never stores or refreshes OAuth tokens and
does not request extra scopes such as `workflow`. Credentials remain on the VM
host and are never mounted into a thread container.

```sh
cube status     # release, VM, product, and whether an update exists
cube upgrade    # apply the latest release — app-only releases land in
                # seconds without a reboot; the data disk is always kept
cube down       # stop;  cube ssh / cube logs / cube destroy --yes also exist
```

The launcher is versioned WITH the artifact set it knows how to read:
it ships as an asset on every release and `cube upgrade` refreshes manual
installations (Homebrew installations use `brew upgrade cube`).
Releases carry per-arch artifact SETS (base, app, app tarball,
cube-node) with a manifest and `SHA256SUMS.<arch>`; artifacts are
stored content-addressed under `~/.cube/images`, so an upgrade
downloads only what actually changed. A Homebrew formula is not available yet.

### Homebrew (macOS; pending tap publication)

Once the `cubeyard/homebrew-tap` repository has been published with a
Homebrew-aware release, installation will be:

```sh
brew install cubeyard/tap/cube
cube up
```

Homebrew installs the launcher and QEMU; `cube up` downloads the VM.
Use `brew upgrade cube` for the launcher and `cube upgrade` for the VM.
Stop the VM with `cube down` before uninstalling. `brew uninstall cube`
leaves `~/.cube` intact. To delete
the VM and all its data, run `cube destroy --yes` before uninstalling.
Until the tap is live, use the manual installation above. Maintainers:
see [Homebrew publishing](DEVELOPING.md#homebrew-publishing).

## Using it from other machines

cubed has no authentication; the Tailnet is the boundary. The launcher and
dev loop automatically bind to this node's Tailscale IPv4 when available,
otherwise only loopback. Loopback is always kept. To require Tailscale:

```sh
CUBE_BIND=tailscale cube up                    # launcher (remembered)
CUBE_VM_BIND=tailscale bash scripts/vm/up.sh   # dev loop
```

Public addresses and `0.0.0.0` are refused.

Portal links default to `<service>--<cube>.<host-ip>.sslip.io`: the Tailscale
address when available, otherwise `127.0.0.1`. The host's forwarded port is
included automatically. Set `CUBE_BIND=127.0.0.1` (dev: `CUBE_VM_BIND`) to
force local-only use, or `CUBED_PORTAL_BASE` before boot to override portal
DNS. Changing these settings requires stopping and starting the VM.

## Building from source (the dev loop)

```sh
git clone https://github.com/cubeyard/cube.git
cd cube
bash scripts/vm/dev.sh      # builds base (nix) + app on first run, boots,
                            # drops you into a pi terminal on the VM
```

Additionally needs: node ≥ 26 with npm (pnpm is installed at the version
`package.json` pins), `nix` with a Linux builder for the base image,
e2fsprogs (`mke2fs`), and `zstd`. On macOS: `brew install e2fsprogs
zstd` and put `$(brew --prefix e2fsprogs)/sbin` on PATH; skip the base
build by pointing `CUBE_BASE_IMAGE` at a base qcow2 from a release.

```sh
bash scripts/vm/up.sh      # boot (idempotent; builds what's missing)
bash scripts/vm/down.sh    # stop
bash scripts/vm/sync.sh    # update cubed in the running VM to latest main
                           # (threads and logins survive)
bash scripts/vm/ssh.sh     # shell on the VM
bash scripts/vm/test.sh    # full test portfolio inside the VM
```

Disks and state live in `~/cube/vm/`. Threads, repos, and `/login`
sessions live on the data disk and survive reboots AND rebuilds — no
build script touches it.

## Contributing / more

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change.
[DEVELOPING.md](DEVELOPING.md) covers the dev loops (including a mock backend
that runs without the VM), releases, and environment variables;
[PLAN.md](PLAN.md) describes the architecture and phase plan.

Please report vulnerabilities according to [SECURITY.md](SECURITY.md), not in
a public issue.

## License

Apache-2.0. See [LICENSE](LICENSE). Vendored tooling retains its own notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
