# Platforms, source checkouts and fresh state

## Support matrix

| | cubed | berth vm (thread machines, keel) |
|---|---|---|
| macOS, Apple Silicon | signed release (`darwin-arm64`), Homebrew or `install.sh` | HVF; Homebrew's QEMU 11.1.x, without `-sandbox` ([berth vm on a Mac](macos.md#berth-vm-on-a-mac)) |
| macOS, Intel | no release; source checkout only | no |
| Linux x86-64 (glibc) | signed release | KVM, glibc 2.39 or newer; a QEMU at or above keel's floor (QEMU 11.1.2 at an explicit path; Ubuntu 24.04's 8.2.2 is refused), run with `-sandbox on` |
| Linux arm64 (glibc) | signed release | no berth release |
| Windows, musl | no | no |

`berth vm` is the runner ([runner
operations](runner-operations.md#berth-vm-runner-protocol-4)); each release
carries it with keel's kernel and base. The protocol-3 runner `cube-runner`
is retired ([runner operations](runner-operations.md#protocol-3-runners-retired)).

Everything needs Node 26 only when running from source (releases bundle it),
Git, and an OCI image pinned by digest for the machines (`--image`). Pi-based threads need a model provider Pi supports;
Claude Code threads need Claude Code and a Claude Max login on the cubed host.

## Linux and source checkouts

On a Linux laptop with KVM the same local-runner flow works from a checkout
or from the signed release (`install.sh`, [cubed updates](cubed-updates.md)),
with a QEMU at or above keel's floor (11.1.x), its `qemu-img`, `mkfs.erofs`
and keel's `vmlinuz` and `base.erofs` for x86_64 (a release's, or
`packages/keel` built):

```sh
pnpm install --frozen-lockfile && pnpm build
cargo build --locked -p berth -p cube-gateway
pnpm cubed runners init-local --state "$HOME/.cube-host" --image '<registry/repository@sha256:…>' \
  --berth "$PWD/target/debug/berth" --keel /abs/keel/x86_64 --qemu /abs/qemu-system-x86_64 \
  --qemu-img /abs/qemu-img --mkfs-erofs "$(command -v mkfs.erofs)"
target/debug/berth vm --dir "$HOME/.cube/berth" --qemu /abs/qemu-system-x86_64 --qemu-img /abs/qemu-img \
  --keel /abs/keel/x86_64 --mkfs-erofs "$(command -v mkfs.erofs)" \
  --image '<the same image>' --max-machines 2          # terminal 1
pnpm cubed --state "$HOME/.cube-host"                  # terminal 2
```

Both are foreground processes; `init-local` enrolls the runner while it runs
it once, and running it again changes nothing. Runners on other machines (relay or direct mode), always-on service
profiles with a dedicated account, drain, backup and restore are in [runner
operations](runner-operations.md); `cubed runners enroll --config` admits
one. Development checks: [DEVELOPING.md](../DEVELOPING.md).

## Fresh state, not migration

State schema 102 does **not migrate**
older registries or execution stacks: cubed refuses a v100/v101 registry, a
version-1 runner config and a protocol-2 runner. For a fresh start, stop cubed
and choose a different empty `CUBED_STATE` directory; create projects and
enroll freshly initialized VM runners. This does not erase old installations or
runner workspaces. Never copy a live Pi session into two hosts: each session
requires one writable owner.
