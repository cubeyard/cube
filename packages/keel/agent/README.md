# cube-agent

keel's guest agent (masterplan K-5a): one static musl binary at
`/sbin/cube-agent` in `base.erofs`, started (and started again) by
`cube-init`. It runs in the base root as root and speaks protocol 4's
`DaemonFrame` on the virtio-serial port named `cube.0`
(`packages/runner-protocol/proto/runner.proto`, header and "guest daemon <->
runner"), framed and checked with `cube-runner-protocol`'s `write_frame` and
`read_daemon_frame`. cubed keeps the agent loop and every secret; the guest
gets placeholders only.

```text
cube-init (PID 1)
└─ cube-agent                      base root, root cgroup
   ├─ channel: cube.0 ─ DaemonFrame ─ runner's ctl.sock
   │    ch 0   hello on connect, status when GuestInfo changes
   │    ch>0   req guest{op,data} | machine_setup | snapshot_* → one ans
   ├─ machine_setup → /run/keel/{layers/N, rw, root, workload.mnt, setup.json}
   ├─ journal  /run/keel/rw/state/ops/<id>  (= /var/lib/cube/ops in the workload)
   └─ supervisor thread (50 ms)
/sys/fs/cgroup/cube-ops/<id>       one cgroup per operation
   └─ cube-agent wrap OPDIR         detached; reparented to cube-init
      └─ /bin/bash -c COMMAND       setns(workload.mnt), uid agent, cwd /workspace
```

## What it does

- **hello and status.** `hello` on channel 0 when the runner's end connects
  (`GuestInfo`: `ready`, `reason`, `limits` (cube-guest's), `epoch` (the
  journal's lease epoch), `capabilities`, `build` (sha256 of the binary),
  `kernel`, `boot_id`). Every new connection starts not ready ("waiting for
  machine_setup"); `status` follows each `machine_setup` answer.
- **reset by the runner.** Any runner frame on channel 0 breaks the channel
  rules: the agent ends the connection, opens the port again and says
  `hello` about 100 ms later. A runner uses this when no `hello` comes
  500 ms after a connect (runner.proto's header): it sends a `req` with
  `guest.op = "hello"` on channel 0 and waits 2 s for `hello`. The guest
  misses a disconnect when the runner connects again right after it
  closed (both reach the guest at once and the agent reads no EOF), and
  after a restore the runner connected to before `cont` (QEMU sends no
  `PORT_OPEN` then).
- **machine_setup**, idempotent: validates the documents (`hostname`, `env`,
  `hooks/pre-setup`, `hooks/pre-resume`; anything else is
  `INVALID_ARGUMENT/unknown_document`), needs at least 32 bytes of entropy
  (mixed into `/dev/urandom`), mounts each layer partition read-only as
  EROFS, formats a blank writable disk (`mke2fs`) or checks it (`e2fsck -p`),
  never formats anything else, assembles the overlay in the setup's order
  and gives the workload root its own `proc`, a read-only `sysfs`, a `/dev`
  with only the character devices programs expect (no disks, no virtio
  ports), tmpfs `/run` and `/tmp`, and `state/` at `/var/lib/cube`. It then
  pivots a mount namespace into that root, keeps it as
  `/run/keel/workload.mnt`, adds the `agent` account in `upper/` when the
  image has none (uid 1000 unless taken), sets the host name, and composes
  the command environment (defaults, then the image's `Env`, then the
  account's own variables, then the `env` document). Another layer list
  under an assembled root is `FAILED_PRECONDITION/layers_changed`; the list is
  kept in `/run/keel/setup.json`, so this holds across agent restarts.
- **ready** once the setup is applied, the journal is recovered, and the
  workload root has bash, sudo, flock, git, gh, curl and a CA bundle;
  otherwise `reason` names what is missing. Until then every guest operation
  but `hello` is `UNAVAILABLE/not_ready`.
- **OPERATIONS** `hello`, `exec`, `get`, `cancel` with cube-guest's semantics
  and journal format: a key is journaled before anything runs; the same key
  and request returns the recorded state; another request is `CONFLICT`;
  lease epochs never go back (`LEASE_STALE`); records are never deleted; a
  cancel can come before its command. Each command's wrapper runs in its
  own cgroup, so the timeout, a cancel and the end of the main process kill
  the whole tree (`cgroup.kill`, as `KillMode=control-group`), and results
  carry `memory.peak` and OOM kills. An agent that starts again adopts the
  operations whose cgroups still exist; a record without an end and without
  a cgroup (a boot) is `Interrupted`. Nothing is run twice.
- `read`, `write`, `stat`, `services`, `portal` are answered `UNSUPPORTED`
  and not advertised (K-5b, K-5c); `install` never exists for keel.
  `snapshot_prepare` and `snapshot_done` are `UNIMPLEMENTED` (K-5f).

## Not yet (later K-5 rows)

Generated files (`/etc/hosts`, `/etc/hostname`, sudoers, `/etc/cube/env`),
the runner's CA in the bundle, the clock from PTP, hooks and `recover`
output for `cube hooks` (K-5d); file operations (K-5b); services and the
`cube` command (K-5c); templates (K-5e); `snapshot_prepare`/`snapshot_done`
and a driver check of the reset after a restore (K-5f). `ready` will
include the generated files and
the CA once K-5d writes them.

## Tests

- `cargo test -p cube-agent`: unit tests, and `tests/journal.rs`, which runs
  the journal and the real wrapper on the host with process groups standing
  in for cgroups (an ordinary user cannot create them). Offline.
- `keel-agent-check` (`packages/keel/agent-check`): boots a disposable keel
  machine under QEMU (TCG, KVM or HVF), talks `DaemonFrame` to the agent,
  checks setup, readiness, the workload root, the journal, an agent restart
  under a running command and a power-off, a boot with no runner connected
  and a runner that goes away and comes back (a fresh `hello`, working
  channels, and the agent's CPU time from `/proc` while it waits), ten
  immediate reconnects, each recovered by the reset above when the plain
  `hello` does not come (`results.json` `idle.immediateReconnect` counts
  both; the plain count is information only), and runs
  the Workspace contract's exec part
  (`packages/server/test/keel-agent-contract-test.ts`) over the channel:

  ```sh
  pnpm install --frozen-lockfile    # the contract test imports cubed's src
  packages/keel/kernel/build.sh x86_64 && packages/keel/base/build.sh x86_64
  sh packages/keel/agent-check/test-image.sh x86_64 /var/tmp/kac/image-x86_64.tar
  cargo build --release -p keel-agent-check
  target/release/keel-agent-check --qemu ~/.local/opt/qemu-11.1.2/bin/qemu-system-x86_64 \
    --qemu-img ~/.local/opt/qemu-11.1.2/bin/qemu-img \
    --kernel packages/keel/out/x86_64/vmlinuz --base packages/keel/out/x86_64/base.erofs \
    --mkfs /usr/bin/mkfs.erofs --tar /var/tmp/kac/image-x86_64.tar --out /var/tmp/kac/x86_64-tcg \
    --arch x86_64 --accel tcg --contract "node packages/server/test/keel-agent-contract-test.ts"
  ```

  `test-image.sh` needs Docker (and binfmt for the other architecture); it
  builds Debian trixie with sudo, git, gh and curl and passwordless sudo for
  `agent` (the line K-5d will write). It is a test image, not cube's.
