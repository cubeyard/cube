# cube

Self-hosted coding-agent threads, each in its own virtual machine. You talk to
a chat in your browser; it starts threads in your projects; every thread's
agent works in a fresh Debian machine of its own, with only HTTP and HTTPS
through cube's gateway, and reports back. Closing the tab or restarting cube
does not discard accepted work.

**Experimental software.** It runs agents with real tools against your
repositories and your GitHub token. Read [security and the private
network](docs/security.md) before exposing it to anything but your own
browser.

- **cubed** is the control plane: the web UI, [OptChat](docs/optchat.md) (one
  endless chat that starts and steers threads), the agents (Pi, or Claude Code
  with your own login), projects, and the gateway every thread machine's
  traffic goes through.
- **cube-runner** hosts the thread machines: one QEMU VM per active thread,
  several per runner, on Linux with KVM or on an Apple Silicon Mac with
  Hypervisor.framework.
- **keel** (in development, [packages/keel](packages/keel/README.md)) is what
  runs inside a thread machine: a guest kernel, a small init and the guest
  agent, booted directly with OCI images as read-only layers, in about 0.1 s
  and built for suspend and resume. The runner does not use it yet.
- Threads run `read`, `write`, `edit`, bounded `bash`, `codemode` (one
  model-written script calling those tools) and `cube service` (web servers
  with a URL for you). They write [artifacts](docs/artifacts.md): documents
  you read beside the chat, comment on, and act from (a confirmed pull request
  merge).

## Install

On an Apple Silicon Mac, with [Homebrew](https://brew.sh):

```sh
brew trust cubeyard/tap
brew install cubeyard/tap/cube
cubed runners init-local    # one time: Debian's arm64 cloud image (~340 MB) and the local runner
brew services start cubeyard/tap/cube-runner
brew services start cubeyard/tap/cube
open http://127.0.0.1:7777
```

Then run `gh auth login` and connect a model under **models**. After
`==> Installing cubeyard/tap/cube`, Homebrew prints nothing for a while
(14 to 32 seconds on GitHub's macOS runners); see [install
progress](docs/macos.md#install-progress). Everything else about the Mac
setup is in [macOS with Homebrew](docs/macos.md). Linux and source checkouts:
[platforms](docs/platforms.md).

## Update

```sh
brew update
brew upgrade cubeyard/tap/cube cubeyard/tap/cube-runner
brew services restart cubeyard/tap/cube-runner cubeyard/tap/cube
```

`brew update` fetches the tap now; without it Homebrew may not see a new
release for up to a day. The services keep running the old version until
restarted.

## More

- [macOS with Homebrew](docs/macos.md): what the formulas install, first run,
  settings, file locations, removal, troubleshooting.
- [Platforms](docs/platforms.md): support matrix, Linux and source checkouts,
  fresh state. [Security](docs/security.md): what is and is not sandboxed.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit; [DESIGN.md](DESIGN.md),
  [PRODUCT.md](PRODUCT.md); [HANDOFF.md](HANDOFF.md) for the current status.
- [docs/runner-operations.md](docs/runner-operations.md): runners, machines
  per runner, diagnostics, service profiles, backup and restore.
- [docs/cubed-updates.md](docs/cubed-updates.md): signed releases, the managed
  launcher and its user service, browser updates.
- [docs/optchat.md](docs/optchat.md), [docs/artifacts.md](docs/artifacts.md),
  [docs/skills.md](docs/skills.md),
  [docs/services.md](docs/services.md), [docs/usage.md](docs/usage.md),
  [docs/project-hooks.md](docs/project-hooks.md) (a project's pre-setup and
  pre-resume hooks: the project page, OptChat, `cube hooks`).
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md). Apache-2.0;
  dependencies retain their [notices](THIRD_PARTY_NOTICES.md).
