# Handoff

Short operational context for the next session, not a release log. Updated
2026-09-08; live verification below is the last recorded evidence, not a fresh
launch sign-off. Completed phase reports and review histories remain in Git.

## Start here

- [README.md](README.md): product, installation and everyday commands.
- [DEVELOPING.md](DEVELOPING.md): mock/VM loops, releases, launcher and env vars.
- [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), [.impeccable/](.impeccable/):
  product and design contracts. The quieter, more machined rendition wins.
- [SECURITY.md](SECURITY.md): deployment boundary and vulnerability reporting.
- [PLAN.md](PLAN.md): architecture decisions and roadmap; dated phase statuses
  are historical, not a current completion checklist.

Leverage pi rather than rebuilding it: pi owns the agent loop, JSONL session
history, compaction, provider auth/refresh, model catalog and tool definitions.
Development credentials and account status are machine-local; never record
them here.

## Before launch: unresolved verification

These were still open in the last handoff. Confirm or close them with explicit
evidence; do not infer acceptance from a successful build.

1. **Real thread on arm64:** on the Mac, connect GitHub, create/check a project
   and start a thread, proving cube-node import and nested container execution.
   Install and app-only upgrade were user-tested; this path was not recorded.
2. **Real-Incus UI acceptance:** use a fresh disposable registry to create a
   two-repository project, start a thread, prove both guest mounts, the additional
   repository's read-only access and the primary repository diff. Automated
   multi-repo smokes passed; the complete UI path remained a follow-up.
3. **macOS launcher edge paths:** destroy, base-changing reboot upgrade and a
   collision on SSH port 2222 were not recorded as verified.
4. **Automatic-release failure cleanup:** draft/tag removal was reviewed and
   lint-checked, but not exercised. Cancellation cleanup cannot make GitHub's
   unconditional DELETE atomic against a concurrent human undraft.
5. **First-run onboarding:** the earlier handoff queued an empty-state setup
   checklist (connect GitHub → create project → open thread and `/login`), an
   actionable GitHub badge and a repository picker. Confirm current completion;
   GitHub is needed for push/PR even when anonymous public-repo reads work.

Pushes, PRs, releases and destructive acceptance steps require explicit
authorization. A shipped-file push to main triggers a release only when the
repository Actions variable `CUBE_RELEASES_ENABLED` is `true`; leave it unset
through the public repository import and source-only launch.
Do not expose cubed publicly: it has no application-level authentication.

## Last recorded live evidence

- **2026-09-04:** [vm-v0.6.2](https://github.com/dizk/cube/releases/tag/vm-v0.6.2)
  completed the automatic main-push release path on both architectures, with
  amd64 boot verification. This is a historical checkpoint, not a claim about
  today's latest release.
- The user installed v0.6.0 on Apple Silicon and upgraded to v0.6.1 in place
  (`changed: app`, ~32 MB, no reboot). Linux launcher install, app-only/reboot
  upgrades, down/up and destroy passed; the dev VM portfolio passed 19 suites.
- Projects and GitHub device auth were live-tested on the tailnet build on
  2026-08-28. Automated real-Incus multi-repository coverage passed.
- Persistence acceptance (2026-08-30) preserved projects, threads, credentials
  and Incus instances through an upgrade simulation; foreign ext4 data disks
  were refused. A live model-driven hostile-symlink read resolved in the cube's
  namespace, not the host's. When repeating this check, require actual tool calls
  in the transcript, not an answer from conversation memory.

## Current architecture and contracts

### Projects and threads

Projects prepare access, branch and exact base OIDs before work starts. New
threads require `ready` and seed only those OIDs: no provisioning-time
network/auth lookup. The primary checkout is `/workspace`; optional reference
repositories mount at `/repos/<checkout-name>` and are read-only. Review and
ship operate on the immutable primary repository snapshot.

Threads are the home, newest-first across projects, with a URL-backed project
filter and explicit project/name attribution. Do not use a pre-project populated
database: startup refuses to invent project ownership.

GitHub device auth is owned by cubed (`/api/github/auth`); tokens stay on the VM
host and are installed into `gh`. The UI receives only public flow state.
Project checks refresh auth, not thread provisioning.

### VM, persistence and upgrades

The VM is NixOS, boots UEFI on both architectures and uses these artifact roles:

| Role | Source / purpose |
|---|---|
| base | `scripts/vm/base/`; built with Nix + systemd-repart, no build VM required |
| app disk | `/opt/cube/{bin/cubed,node/,runtime-id,app/}`; built by `build-app.sh` |
| app tarball | Same staged `app/`; applied in place by `cube-app-apply` |
| cube-node | Read-only inner image; inherited when the `images/` tree is unchanged |
| data | Persistent ZFS pool `cube`, with `cube/incus` and `cube/state/*` |

OS is vda, data is vdb; other disks mount by label. The `CUBESEED` seed injects
per-deploy SSH trust. Mutable registry, Incus, pi and gh state lives on the data
disk. Launcher upgrades preserve it; a dev rebake recreates both disks.

Manifest schema 2 binds per-arch artifacts, hashes and sizes plus `runtime_id`
and `images_tree`. Adding an artifact role requires a schema bump. The app disk
and tarball runtime IDs must match. Base/node/runtime changes take the reboot
path; compatible app-only upgrades swap the tarball around a cubed restart.
Overlay `.runtime`/`.build` sidecars support recovery; pruning must retain each
overlay's backing file, even after tarball updates.

`launcher/cube` owns install, upgrade and host preflight. State is in `~/.cube`;
downloads are content-addressed and verified. Unclaimed busy ports move to the
next free port and are remembered. `scripts/vm/sync.sh` deploys `origin/main`,
not the working tree; image-level changes need a rebuild.

### Release and validation

`.github/workflows/release.yml` pins one commit for both native-architecture
builds. Shipped-file pushes to main mint patch tags; push a manual version tag
before main for a minor/major bump. Publishing waits for both architecture legs
and the launcher asset. The amd64 gate boots a blank-data-disk install, runs a
nested container and applies the app tarball; arm64 remains build-verified in CI.
Runs are serialized with `queue: max` to avoid dropping pending releases.

Use `pnpm typecheck` and `pnpm test` for offline checks; the suite list lives in
`scripts/test-offline.sh`. Use the real VM portfolio for Incus/network/storage
changes; mock success is not sandbox acceptance. See DEVELOPING.md for commands.

## Load-bearing invariants

- Credentials stay on the host. Agent push cannot reach the network; push/PR
  are explicit host actions. No host environment passthrough into cubes.
- Keep pi's isolation flags and the extension's fail-closed tool audit. Host-side
  context/extension loading through workspace symlinks can expose credentials.
  File-tool symlinks must resolve inside the guest namespace.
- Cubes have no default route/NAT; egress goes through a source-pinned allowlist
  proxy that resolves and vets public IPs. NIC IP/MAC filtering and bridge-forward
  drops are essential. Upstream DNS forwarding remains an accepted exfil channel.
- Loopback or a trusted Tailnet is the access boundary; terminal WebSockets are
  same-origin and portals are cube-source-guarded. Never use a `*.localhost`
  portal base: it breaks in-cube hairpin access.
- Wake waits for network readiness, not merely Incus `Running`, and restarts
  the egress proxy. Reserve per-cube transitions synchronously; set busy before
  wake and guard deletion against in-flight transitions.
- Thread row IDs remain stable across session changes. Hook failures report an
  error without bricking the cube; hooks must tolerate re-runs.
- Plain HTTP over the Tailnet is an insecure browser context. Feature-detect
  clipboard/crypto APIs; use the existing UID fallback, not `crypto.randomUUID`
  unconditionally. UI is Svelte 5 + Vite, not SvelteKit; freeze completed
  transcript blocks and update only the live tail while streaming.

## VM traps worth retaining

- Keep `profiles/qemu-guest.nix`: it supplies the virtio initrd modules. Serial
  consoles are `ttyAMA0` on arm64 and `ttyS0` on amd64.
- Pair UEFI code/vars by arch; arm64 `virt` requires both at exactly 64 MiB.
  Pad private copies. Use the pflash pair, not `-bios`.
- Mount data before Incus sockets start; ordinary systemd dependencies can
  create a sockets/basic-target cycle. Refuse foreign data disks, never wipe.
- Hosted arm64 runners lack KVM: do not replace repart with nixos-generators'
  VM build. Ubuntu AppArmor can block repart's unprivileged user namespaces.
- GitHub runners' Docker firewall can block Incus bridges; use
  `scripts/host-firewall.sh`. Incus list output uses short fingerprints;
  `incus image info` supplies the full one.
- Build scripts need `CI=true` for pnpm's non-TTY dev/prod purge, a pnpm wrapper
  on PATH and Linux node-pty prebuilds even when staging on macOS.
- `incus-container-only.nix` forks nixpkgs' module with an upstream hash guard.
  A nixpkgs bump requires rebasing the fork and re-measuring the closure.

## Follow-ups, not recorded launch blockers

- Add an arm64 boot gate; distribute UEFI firmware (requires manifest schema 3).
- Pin cube-node inputs (Ubuntu alias, Docker apt key, Node checksums).
- Further base-size reduction and a Homebrew formula.
- Mock service starts are best-effort and mock instances are process-lifetime.
- Guest find/grep ignore only `.git`/`node_modules`, not `.gitignore`.
- Previously recorded UI gaps: stop/cancel, larger-list search/sort and HEAD
  requests on file endpoints. Re-check current implementation before taking on
  one of these; SSE buffers remain process-local in the recorded design.

Keep this file focused on unresolved work and contracts that prevent mistakes.
Put command reference in DEVELOPING.md and completed narratives in Git history.
