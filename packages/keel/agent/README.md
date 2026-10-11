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
   ├─ supervisor thread (50 ms)
   ├─ services thread (200 ms)    /run/keel/rw/state/services/NAME.{json,log}
   └─ cube socket                 /run/cube/agent.sock in the workload root
/sys/fs/cgroup/cube-ops/<id>       one cgroup per operation
   └─ cube-agent wrap OPDIR         detached; reparented to cube-init
      └─ /bin/bash -c COMMAND       setns(workload.mnt), uid agent, cwd /workspace
/sys/fs/cgroup/cube-services/NAME  one cgroup per service
   └─ cube-agent service-run …      detached; copies the output to the log
      └─ /bin/bash -c COMMAND       setns(workload.mnt), uid agent, PORT HOST CUBE_SERVICE
```

## What it does

- **hello and status.** `hello` on channel 0 when the runner's end connects
  (`GuestInfo`: `ready`, `reason`, `limits` (cube-guest's), `epoch` (the
  journal's lease epoch), `capabilities`, `build` (sha256 of the binary),
  `kernel`, `boot_id`, `hooks`: each hook's last outcome in this machine).
  Every new connection starts not ready ("waiting for
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
  account's own variables, then keel's fixed lines and the `env` document).
  It writes what today's seed writes (below, "Generated files"). Another layer list
  under an assembled root is `FAILED_PRECONDITION/layers_changed`; the list is
  kept in `/run/keel/setup.json`, so this holds across agent restarts.
- **ready** once the setup is applied (with the generated files and the
  runner's CA), the journal is recovered, and the workload root has bash,
  sudo, flock, git, gh, curl and a CA bundle;
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
- **Files** `read`, `write`, `stat` (`fs.read`, `fs.write`, `fs.stat`,
  `fs.absolute`) with cube-guest's rules: a relative path is in the
  workspace, an absolute one anywhere in the workload root but `/proc`,
  `/sys` and `/dev`, never with `..`. Paths are resolved inside the
  workload root (`openat2` with `RESOLVE_IN_ROOT`, `paths.rs`), so an
  absolute link names the workload's file and the base root is out of
  reach; what was resolved is opened with every link refused, so a link
  swapped in after the check fails the operation. In the workspace the
  agent writes as root and gives what it makes to `agent`; a path that
  leads out of it (itself or through its links) is reached with the
  `agent` account's permissions, on a thread of its own whose credentials
  alone change. A write replaces the file atomically (temporary file,
  fsync, rename), keeps its mode, checks `expectedSha`, and is journaled
  under its key like a command (repeated key: the recorded result;
  another request: `CONFLICT`; cut off before its result:
  `COMPLETION_UNKNOWN`, never done again).
- **Services** (`services.list`, `portal.configure`): the workload's
  `cube` command is this binary, bind-mounted read-only at
  `/usr/local/bin/cube` (an empty file in `upper/` is its mount point).
  It sends its arguments and directory to the agent over
  `/run/cube/agent.sock` and prints what comes back; only the `agent`
  account and root are served (`SO_PEERCRED`). `cube service start, open,
  list, status, logs [-f], restart, stop` keep cube-guest's options,
  texts and exit statuses and its registrations
  (`/var/lib/cube/services/NAME.json`). A command service runs as `agent`
  in the workload root in its own cgroup, with `PORT`, `HOST=0.0.0.0` and
  `CUBE_SERVICE`; its main process is `cube-agent service-run`, which
  copies the output into `NAME.log` (1 MiB, then one older `NAME.log.1`).
  The agent starts it again 2 s after it fails, at most 5 starts in 60 s
  (then `failed`), not after exit status 0 (systemd's `Restart=on-failure`,
  `StartLimitBurst=5`), finds it again by its cgroup after an agent
  restart, and starts every registered command again on a boot's first
  `machine_setup`. `services` lists the registrations (with `probe`:
  whether each listens) and `portal` keeps cubed's URL template or the
  reason there is none (`/var/lib/cube/portal.json`). The address the
  portal will reach is the machine's on its private link; until the
  runner's network exists (B-4) that is 127.0.0.1, so "listens only on
  127.0.0.1" is not caught yet.
- **Generated files** (`generated.rs`), on every `machine_setup`:
  `/etc/cube` is `state/etc-cube`, bound read-only, with `env` (keel's
  lines and the `env` document, for every command), `hooks/pre-setup` and
  `hooks/pre-resume` (the boot documents, 0755; removed when the setup has
  none) and `ca.pem`; `/etc/hosts` (localhost and the host name),
  `/etc/hostname`, `/etc/resolv.conf` (the runner, `192.168.127.1`) and
  `/etc/sudoers.d/cube` (passwordless sudo for `agent`, the CA variables
  kept) are files in `state/generated`, each bound over its path (an empty
  file in `upper/` is the mount point when the image has none; no
  `/etc/sudoers.d`, no sudoers file). The binds are made once per boot,
  before the workload namespace; the files behind them are rewritten in
  place. The runner's CA (`ca_pem`, PEM certificates only, else
  `INVALID_ARGUMENT/bad_ca`) goes into the image's bundle as a block
  between `# cube: begin` and `# cube: end` lines, replaced on every setup,
  and into `/usr/local/share/ca-certificates/cube-runner.crt`, so
  `update-ca-certificates` keeps it in the bundle it writes again;
  `/etc/gitconfig` gets git's credential helper for github.com (the
  placeholder in `GH_TOKEN`) and `/etc/environment` the CA variables, each
  as such a block. `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
  `SSL_CERT_FILE` and `CURL_CA_BUNDLE` name the image's bundle. Paths in the
  root are resolved inside it and written with every link refused. Template
  publishing (K-5e) leaves cube's blocks, `cube-runner.crt` and the empty
  mount points out. Not done: the `-CApath` hash link and a Java keystore.
  The agent also sets `fs.protected_hardlinks` and `fs.protected_symlinks`.
- **Hooks**: cubed runs them as commands (its preparation and resume
  scripts); the agent writes the project's two from the boot documents and
  reports each hook's last outcome from the agent account's
  `~/.cache/cube/NAME.status` in `hello` and `status.guest.hooks`.
  `cube hooks [-n LINES] [--json]` is cube-guest's: the four hooks, their
  last outcomes and log tails, read inside the workload root with the
  caller's own permissions (`hooks.rs`).
- **Clock** (`clock.rs`): every 500 ms the agent compares `CLOCK_REALTIME`
  with the host's PTP clock ("Virtio PTP", else "KVM virtual PTP", picked
  by `/sys/class/ptp/*/clock_name`) and steps it when they are 20 ms or more
  apart, so realtime is right again within that interval after a pause or a
  restore. Without a PTP clock it says so on the console.
- **recover before answering**: an agent that starts with the root
  assembled recovers its journal before it serves the channel, and every
  setup recovers it before `ready`.
- `install` never exists for keel.
  `snapshot_prepare` and `snapshot_done` are `UNIMPLEMENTED` (K-5f).

## Not yet (later K-5 rows)

Templates (K-5e, which also leaves `/usr/local/bin/cube`'s mount point and
cube's generated lines and files out of a template); `snapshot_prepare`/`snapshot_done`
(K-5f).

## Tests

- `cargo test -p cube-agent`: unit tests, `tests/journal.rs`, which runs
  the journal and the real wrapper on the host with process groups standing
  in for cgroups (an ordinary user cannot create them), and
  `tests/services.rs`, the same for services with the real `service-run`
  wrapper and the `cube` socket. Offline.
- `keel-agent-check` (`packages/keel/agent-check`): boots a disposable keel
  machine under QEMU (TCG, KVM or HVF), talks `DaemonFrame` to the agent,
  checks setup, readiness, the workload root, the journal, an agent restart
  under a running command and a power-off, a boot with no runner connected
  and a runner that goes away and comes back (a fresh `hello`, working
  channels, and the agent's CPU time from `/proc` while it waits), ten
  immediate reconnects, each recovered by the reset above when the plain
  `hello` does not come (`results.json` `idle.immediateReconnect` counts
  both; the plain count is information only), a reset sent on purpose
  right after a `hello` so that the next `hello` comes while
  `machine_setup` waits (`restore.lateHello`), three restores into a new
  QEMU (`stop`, `migrate` to `file:` with `mapped-ram` in mode
  `cpr-reboot`, `-incoming defer`) with the runner connected before `cont`,
  each kept to the runner's connect rule, refused until `machine_setup`,
  ready from its `status`, and finding the command that ran at the save by
  its key (`restore.restores`), file operations over the channel (a write
  kept across the boot and the restores; links that stay in the workload
  root; `/proc`, `/sys`, `/dev` and `..` refused; `/etc` refused and
  `/tmp`, `/home/agent` owned by `agent` out of the workspace), services,
  the generated files, the runner's CA (also across
  `update-ca-certificates`), git's credential helper, `cube hooks`, a
  refused CA, and the guest's realtime within 1 s of the host's after a 3 s
  pause (`results.json` `clock`), and runs the Workspace contract (leases,
  files, commands, services, and cubed's resume script running the
  pre-resume hook) (`packages/server/test/keel-agent-contract-test.ts`)
  over the channel:

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

  `--control reconnect|late-hello|restore` (`--reset off` is `reconnect`)
  leaves the reset out of one of those three places, a negative control
  expected to fail at that place's check; `--control clock` boots without
  `virtio-rtc-pci` and is expected to fail at the clock check under TCG
  and HVF (under KVM the agent follows "KVM virtual PTP" instead, so it
  passes there and says so in `clock.source`). A failed run writes no
  `results.json`.

  `test-image.sh` needs Docker (and binfmt for the other architecture); it
  builds Debian trixie with sudo, git, gh and curl and passwordless sudo for
  `agent` (keel writes the same line). It is a test image, not cube's.
