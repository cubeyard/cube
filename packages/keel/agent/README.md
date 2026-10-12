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
- **sessions.** Every connection is a session: before its `hello` the agent
  sets realtime from the host's PTP clock once, then makes the session (16
  bytes of sha256 over fresh random bytes, the host's time it just read, the
  time since boot, the boot id and a counter, as 32 hex; `GuestInfo.session`).
  Every frame it sends carries it (`DaemonFrame.session`), set by the
  connection's writer, so an answer made for an older connection is never
  sent on a newer one; a request or `abort` the runner sent for another
  session is dropped unrun. The writer stops between frames when the
  connection ends (cut off only if the runner reads nothing for 2 s), so a
  `hello` never follows half a frame. A restored machine's memory, random
  state included, is the save's; the host's time still makes its session
  new.
- **hello when the host opens the port.** The agent says `hello` when the
  runner's end connects: after a boot, an agent restart, the reset and a
  restore alike (runner.proto's header). When the runner closes its end
  the agent closes the port and opens it again, so the runner sees it in
  QMP (`query-chardev` `frontend-open`); a runner that saves a machine
  closes its end first and waits for that, and the saved agent then waits
  for the host, so the connect to the restored QEMU is an open it sees.
  VMGENID has no part in the handshake: on x86-64 QEMU's `vmgenid` device
  makes the kernel reseed its random generator on a restore (the kernel
  says so in its log, nothing else); arm64 QEMU has no such device. On both,
  `machine_setup`'s entropy is written to `/dev/urandom` and the generator
  reseeded at once (`RNDRESEEDCRNG`), so a restored machine's random numbers
  are its own after its setup. The clock is set from virtio-rtc's PTP clock
  before each `hello` and every 500 ms, not from VMGENID.
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
  root are resolved inside it and written with every link refused. A file
  over 16 MiB is refused rather than rewritten. A target the image has no
  place for (no `/etc/sudoers.d`, a file at `/etc/cube`) is not bound, and
  the machine is not ready ("the image lacks a place for …"). Every CA a
  setup brings is also kept in `state/runner-cas.pem` and every mount point
  the agent makes in `state/mount-points`, for template publishing. Not
  done: the `-CApath` hash link, a Java keystore, and taking a replaced CA
  out of a bundle `update-ca-certificates` wrote (a later follow-up).
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
- **Template publishing** (`template.rs`, the runner's
  `DaemonRequest.template_publish`): a build machine (one with a template
  disk, vdd) turns its `upper/` into an EROFS layer on vdd, which the
  runner keeps as a template and later machines mount as their topmost
  layer. Refused while a command runs (`FAILED_PRECONDITION/busy`), on a
  machine without vdd (`no_template_disk`) and before a setup. Then the
  machine is used up, as a sealed p3 build machine is powered off: the
  services' supervisor stops, every process of the workload is killed, the
  workload's namespace and root are detached, and `upper/` is cleaned in
  place of what is cube's: marker blocks and every PEM certificate equal to
  a CA a setup brought (`state/runner-cas.pem`), in any file; `cube-runner.crt`,
  `cube-runner.pem` and the links to it; the mount points the agent made
  and the paths it binds in every machine (`/etc/hosts`, `/etc/hostname`,
  `/etc/resolv.conf`, `/etc/sudoers.d/cube`, `/usr/local/bin/cube`); the
  `agent` account's lines the layers below lack (a file left equal to the
  layer below goes); and what cube-guest's `seal_final` removes that a keel
  root can have (`/var/lib/cube`, `/etc/cube`, hook logs, shell histories,
  ssh host keys, the machine ids, the random seed). The seal's check then
  looks at every file for a marker line, a runner CA's DER or the start of
  its base64, and refuses (`seal_failed`, nothing written) when any is left,
  or when the build changed a Java keystore while a runner CA was installed
  (keel cannot clean one yet). The base's `mkfs.erofs` writes the layer
  (lz4hc, owners, times and xattrs kept, so whiteouts and opaque
  directories stay overlay's); the agent answers `done` and refuses every
  operation and setup until the machine powers off. A repeated request
  answers as the first; the outcome is kept in `/run/keel/published.json`.
- **snapshot_prepare and snapshot_done** (`snapshot.rs`). Right before a
  save the runner sends `snapshot_prepare`: the agent waits for the
  requests that write (`exec`, `cancel`, `write`, `portal`,
  `machine_setup`, `template_publish`) to answer, syncs, drops the page
  cache and compacts memory, answers `done` and sends a `status` that is
  not ready ("prepared for a snapshot"). From then on every request that
  comes, and the answer of a read that was still running, is held (the
  console says `holding channel N`) until `snapshot_done` (the save
  failed and the runner sent `cont`, or the machine keeps running: what
  was held goes on) or the end of the connection (the machine was saved:
  what was held is dropped, never run). A restored machine's agent still
  holds its old connection (see the reset above); the runner's reset ends
  it, so the restore starts unprepared and not ready, `machine_setup`
  makes it ready, and the runner asks again by key for what it sent. A
  prepare that cannot write the kernel's knobs answers
  `INTERNAL/snapshot_prepare` and leaves the machine unprepared; one let
  go before the writes finished answers `ABORTED`. Commands and services
  keep running: they are frozen with the machine and go on after the
  restore, which is not a boot (`boot_id`, `/run` and `/dev/shm` are
  kept, so services are not started again and cubed's resume script
  answers "already"). The agent does not wait for free page reporting
  (Linux reports free blocks about 2 s after they are freed); what the
  balloon gives back is S-7b's to measure.
- `install` never exists for keel.

## Not yet

The runner's side of a suspend: `berth vm` sending `snapshot_prepare`
before `stop` and `snapshot_done` after a failed save, and the memory
file's rules (S-7a). `berth vm` keeps the connect rule and sessions (B-2).

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
  each after `snapshot_prepare` (answered `done`, the status not ready),
  with an `exec` sent after the prepare and held (the agent's console
  says so; no answer) that never runs, each kept to the runner's connect
  rule, refused at once until `machine_setup`, ready from its `status`,
  and finding the command that ran at the save still running and by its
  key, with `/dev/shm` kept (`restore.restores`), file operations over the channel (a write
  kept across the boot and the restores; links that stay in the workload
  root; `/proc`, `/sys`, `/dev` and `..` refused; `/etc` refused and
  `/tmp`, `/home/agent` owned by `agent` out of the workspace), services,
  the generated files, the runner's CA (also across
  `update-ca-certificates`), git's credential helper, `cube hooks`, a
  refused CA, and the guest's realtime within 1 s of the host's after a 3 s
  pause (`results.json` `clock`), then template publishing: a build
  machine with a template disk runs a setup (a file with its time, a
  deleted image file, a directory made again, a group,
  `update-ca-certificates`, a copy of the bundle in the project, a history,
  hook logs, an ssh host key, a machine id, a running service, and a
  `chmod`, a `chown` and two `mv`s of image files), is refused
  while a command runs, publishes, and refuses everything afterwards; the
  driver checks the layer with `fsck.erofs` (`--fsck`), reads it in place
  (no extraction, so no root or `mknod` on the host, macOS included) and
  finds nothing of cube's in it (no marker or runner CA in any file or
  xattr, as DER or base64; no `cube-runner.*`; no mount point, account
  line, history, hook log, host key or machine id) but the setup's work
  (with the 0/0 whiteout and the opaque directory), and a new machine
  boots with it as its topmost layer (`results.json` `template`). The
  changed image files are in the layer as overlayfs keeps them (metacopy
  inodes without data, redirects to the old names, whiteouts there), and
  the new machine finds their mode, owner, data and entries through the
  image layer below (`template.moves`). And it
  runs the Workspace contract (leases,
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
    --mkfs /usr/bin/mkfs.erofs --fsck /usr/bin/fsck.erofs --tar /var/tmp/kac/image-x86_64.tar --out /var/tmp/kac/x86_64-tcg \
    --arch x86_64 --accel tcg --contract "node packages/server/test/keel-agent-contract-test.ts"
  ```

  `--control reconnect|late-hello|restore` (`--reset off` is `reconnect`)
  leaves the reset out of one of those three places, a negative control
  expected to fail at that place's check; `--control clock` boots without
  `virtio-rtc-pci` and is expected to fail at the clock check under TCG
  and HVF (under KVM the agent follows "KVM virtual PTP" instead, so it
  passes there and says so in `clock.source`); `--control seal` makes the
  build machine's setup leave the runner's CA as DER in a file, so the
  agent refuses to publish (`seal_failed`); `--control redirect` points
  the published layer's redirects at names that do not exist (the
  superblock summed again, so the layer stays valid) before the new
  machine boots, which is expected to fail at the template's last check,
  80 (the moved file cannot be read, the moved directory is empty);
  `--control prepare` leaves `snapshot_prepare` out before the saves, so
  the `exec` sent then is not held and runs, which is expected to fail at
  check 57. Check 81 comes last: a save that fails (`stop`, a `migrate`
  QEMU cannot write, `cont`) after `snapshot_prepare`, an `exec` held
  meanwhile, and `snapshot_done`, after which it runs (`results.json`
  `snapshot.failedSave`). An agent without the snapshot operations fails
  at check 56. Check 82 comes after it: each restore's `hello` starts
  a session none of the machine's earlier ones had, and its `since` is
  within 1 s of the host's time after 3 s saved (`results.json`
  `restore.restores.each[].session`, `helloClockOffsetS`). The agent's
  periodic sync (every 500 ms) also has the clock right by the time the
  reset's `hello` comes (about 600 ms after `cont`), so this check does not
  single out the sync before `hello`: a build without it passes too.
  Check 83 comes last (`--only snapshot` runs it alone, `--only rest`
  everything else, for a machine where the whole run is too long): one
  snapshot restored twice the supported way (the runner closes its end
  while the machine runs, waits until `query-chardev` shows the agent closed
  the port, then stops and saves; each restore is a new QEMU the runner
  connects to after `cont`). Each restore must give a plain `hello` (no
  reset) within 500 ms of `cont`, a session neither the save nor the other
  restore had, the clock within 1 s after 3 s saved, random bytes the other
  restore did not read, and one kernel record of a VM generation change
  with `vmgenid` (x86-64, on by default, `--vmgenid off` leaves it out) or
  none without (`results.json` `sameSnapshot`). `--control snapshot` keeps
  the runner connected through the save, which is expected to fail there
  (no plain `hello`). A failed run writes no `results.json`.

  `test-image.sh` needs Docker (and binfmt for the other architecture); it
  builds Debian trixie with sudo, git, gh and curl and passwordless sudo for
  `agent` (keel writes the same line). It is a test image, not cube's.
