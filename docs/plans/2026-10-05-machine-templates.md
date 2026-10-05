# Machine templates (snapshots), proposal

Status: proposal, not built. Follows docs/plans/2026-10-04-vm-runner.md.

## Why

A new thread machine boots from the Debian base image every time. cloud-init
then installs the guest packages, and provisioning runs the repository's
`.agents/setup`. Measured on 2026-10-05 for cubeyard/cube, a thread is ready
in 60-100 s, and most of that time goes to work that a previous thread
already did:

| step | time |
|---|---|
| boot to cloud-init final | ~15 s |
| guest packages (git, gh, curl, build-essential) | ~20-30 s |
| `.agents/setup`: Node, pnpm, rustup, toolchain, `pnpm install`, build | ~25 s |
| checkout | a few s |

A template turns the first two-thirds of this into a copy-on-write overlay.

## Shape

- **What a template is:** the disk of a machine that only cubed used. It was
  booted from the base image, cloud-init finished, and cubed ran provisioning
  (checkout plus `.agents/setup`). Then cubed powered it down and cleaned it.
  No agent ever ran in it, so no agent-written state is copied into later
  threads.
- **Where it lives:** on the runner that built it, as `images/template-<id>.qcow2`.
  It is a read-only qcow2 backed by the base image. A thread's overlay is
  backed by the template instead of by the base image, which makes a chain of
  two. Creating the template moves a file and does not flatten it, so it
  takes no time.
- **Key and lifetime:** project id + project repositories (URL and branch) +
  base image sha256 + guest helper version. It is reused for 72 hours, like
  Amp snapshots. A new thread still checks out its pinned commit and runs
  `.agents/setup` again. The script is idempotent, so on a template that run
  takes seconds, and a template a few commits old is still correct.
- **Building:** cubed builds a template on a runner that is idle, when a
  project has no fresh template there. Builds never take a slot a thread is
  waiting for: with `maxActiveVms = 1`, a thread request cancels a running
  build.
- **Cleaning before the snapshot:**
  - the guest helper's operation journal;
  - the setup log;
  - SSH host keys;
  - `/etc/cube/env` and other per-VM placeholders;
  - cloud-init's instance state, so the next instance-id runs the per-instance
    modules again.

  The per-VM seed rewrites all of these on the first boot of a thread, so this
  cleaning is defence in depth.

## Runner protocol (cube-runner 0.6.0, capability `vm.template`)

- `vm.allocate` gains an optional `template`, the id of a stored template.
- `vm.template {threadId, vmId, epoch}` turns a stopped, uninterrupted VM's
  disk into a template and releases the VM. The answer is
  `{template: {id, bytes, createdAt}}`.
- `template.remove {id}` is refused while any VM that is not released is
  backed by the template.
- `node.status` lists the templates.

## cubed

- A template manager per runner and project. Its build machines are
  registered as cubed-internal machines, not threads, so the UI never shows
  them as threads.
- When allocating, cubed picks the newest fresh template for the thread's
  project on the chosen runner, and falls back to the base image.
- Old templates are removed once they expire and no VM uses them.

## Open questions

1. Should a template include `.agents/setup`, Amp style, or only the guest
   packages? The second needs no project key but saves only ~30 s.
2. Is 72 hours right, or should templates rebuild on every push to the
   project's branch?
3. Disk budget per runner for templates (each ~1-3 GB for cube).
