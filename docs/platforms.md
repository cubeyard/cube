# Platforms, source checkouts and fresh state

## Support matrix

| | cubed | cube-runner (thread machines) |
|---|---|---|
| macOS, Apple Silicon | signed release (`darwin-arm64`), Homebrew or `install.sh` | HVF; Homebrew QEMU. Verified as a remote runner in production; the same-Mac loopback setup ([macOS with Homebrew](macos.md)) is unverified on real hardware |
| macOS, Intel | no release; source checkout only | not supported: the runner refuses `x86_64` macOS |
| Linux x86-64 (glibc) | signed release | KVM, QEMU 7.2+; verified with real guests |
| Linux arm64 (glibc) | signed release | no runner release |
| Windows, musl | no | no |

Everything needs Node 26 only when running from source (releases bundle it),
Git, OpenSSH (`ssh`, `ssh-keygen`), and a Debian 13 genericcloud image for the
runner's architecture. Pi-based threads need a model provider Pi supports;
Claude Code threads need Claude Code and a Claude Max login on the cubed host.

## Linux and source checkouts

On a Linux laptop with KVM the same local-runner flow works from a checkout
or from the signed release (`install.sh`, [cubed updates](cubed-updates.md)):

```sh
pnpm install --frozen-lockfile && pnpm build
cargo build --locked -p cube-runner -p cube-gateway
CUBE_RUNNER=target/debug/cube-runner pnpm cubed runners init-local --state "$HOME/.cube-host"
# (downloads debian-13-genericcloud-amd64.qcow2; --image /absolute/file.qcow2 uses one you have)
target/debug/cube-runner run --home "$HOME/.cube/runner"     # terminal 1
pnpm cubed --state "$HOME/.cube-host"                          # terminal 2
```

Both are foreground processes; `init-local` enrolls the runner while it runs
it once. Runners on other machines (relay or direct mode), always-on service
profiles with a dedicated account, drain, backup and restore are in [runner
operations](runner-operations.md); `cubed runners enroll --config` admits
one. Development checks: [DEVELOPING.md](../DEVELOPING.md).

## Fresh state, not migration

State schema 102 (thread machines, runner protocol 3) does **not migrate**
older registries or execution stacks: cubed refuses a v100/v101 registry, a
version-1 runner config and a protocol-2 runner. For a fresh start, stop cubed
and choose a different empty `CUBED_STATE` directory; create projects and
enroll freshly initialized VM runners. This does not erase old installations or
runner workspaces. Never copy a live Pi session into two hosts: each session
requires one writable owner.
