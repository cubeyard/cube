# berth

`berth` is cube's runner on runner protocol 4 (`cubeyard/runner/4`, schema
in [`../runner-protocol/proto/runner.proto`](../runner-protocol/proto/runner.proto)).
Where [keel](../keel) is what cube puts inside a thread machine, berth is
where those machines lie: it creates, holds and reports them for cubed. It
replaces `cube-runner` (protocol 3, `packages/node-transport`) step by step.

It has two modes: `berth vm`, whose machines are keel guests under QEMU,
and `berth host`, unsandboxed, for developing runners.

## `berth vm`: keel machines under QEMU

```text
berth vm --dir /abs/dir --qemu /abs/qemu-system-<arch> --qemu-img /abs/qemu-img \
  --keel /abs/keel/out/<arch> --mkfs-erofs /abs/mkfs.erofs --image <registry/repository@sha256:…> \
  [--layer-cache-gib 16] [--accel kvm|hvf|tcg] --allow-peer <control peer> --node-id node-<name> \
  [--network loopback|direct|relay] [--listen ip:port] [--labels k=v,...] [--max-machines 8]
```

- QEMU, qemu-img and the keel release (`vmlinuz`, `base.erofs`) are given
  by absolute path on every start; berth never searches `PATH` or home
  directories. Before it touches `--dir` it starts the QEMU with `-machine
  none` and reads keel's QEMU floor over QMP (runner.proto's header:
  `virtio-rtc-pci`, `virtio-serial-pci` and `virtserialport`,
  `virtio-balloon-pci` with `free-page-reporting`, `virtio-net-pci`, the
  `dgram` network backend, a versioned machine type, the `mapped-ram`
  capability, migration mode `cpr-reboot`, the migration commands, the
  accelerator); a QEMU below it is refused with what it
  lacks (QEMU 8.2.2: `virtio-rtc-pci` and `mapped-ram`); on x86-64 it also
  needs `vmgenid`, which every machine gets (`guid=auto`, so a restore
  reseeds the guest's random generator). `Platform.qemu_version` is its
  version and path.
- `--image` names the one image every machine is built on, pinned by
  digest. berth pulls it when it starts (masterplan B-7), under the
  directory's lock and **before it listens**, unless its record and every
  layer file are in `--dir` already; then nothing goes over the network. A
  layer file that is gone is fetched again. Until the image is there cubed
  finds no runner, and its threads wait as for one that is down. The pull is
  `berth image pull`'s (below), with mkfs.erofs (by path, any version) given
  60 s + 60 s per GiB of tar after its input instead of 120 s + 240 s;
  SIGINT or SIGTERM stops it as they stop that. A machine's layer disk holds
  its layers from creation on, and the machine keeps that image: a runner
  started with another refuses to start it (`FAILED_PRECONDITION
  image_changed`).
- The layer cache (`layers/1/`) is trimmed to `--layer-cache-gib` (16 by
  default; the first run, and any run that gives the flag, writes it to
  `.berth/vm.json`), least recently used first, when berth starts and when a
  machine or template is deleted or discarded. It never removes a layer of
  the runner's image, of a machine that is not deleted, retained ones too
  (their layer disks name the cache's files), or of a template's image.
  Those are kept even beyond the limit (`0` keeps only them), and nothing
  is removed while a machine's layers cannot be read. Each removal is a line on stderr.
- The runner's CA: `DIRECTORY/.berth/ca/` (0700) with `ca.key` (0600, never
  logged or sent) and `ca.pem`, made on the first start and kept. Half a
  pair, a key others can read, or a certificate that does not carry the key
  is refused, never replaced. The certificate is `Runner.ca_pem` and goes to
  every machine in `machine_setup`; the key signs the leaves of the
  runner's HTTPS interception (below), whose issuer is read from this
  certificate (cube-netstack's `Ca::from_loaded`; a leaf is checked to
  verify against it before the runner serves).
- Each machine is `DIRECTORY/<16 hex>`: `machine.json` (its journal, written
  whole and renamed before an answer), `rw.qcow2` (vdc, the writable disk,
  created once and never replaced), `layers.vmdk` (vdb, read-only, the
  image's layers from the cache), `ctl.sock` (`cube.0`), `qmp.sock`, `qev.sock`
  (QMP for the runner's event reader), `console.log`, `qemu.log`,
  `argv.json`, `events.log`, and on a build machine only `template.raw`
  (vdd, below). vda is the keel base, read-only. The newest
  versioned machine type is pinned when a machine is created; a QEMU
  without it does not start the machine (`FAILED_PRECONDITION machine_type`).
- Verbs: `runner.get`, `machine.create` (`STOPPED`), `start` (QEMU runs it:
  `RUNNING` with a new `boot_id`), `stop` (below), `delete` (stops it;
  `RETAINED` when asked to retain or when the runner interrupted it,
  otherwise the directory is deleted: `DELETED`), `discard` (a retained
  machine's directory is deleted), `get`, `list`, `watch`, and the
  templates' `template.publish`, `template.list`, `template.delete` (below).
  Ids are never reused. Mutations are fenced as on `berth host`.
- Each QEMU runs in a process group of its own. When the runner stops
  (Ctrl-C, SIGTERM) it quits its machines' QEMUs and marks them with the
  `Interrupted` condition (`runner_stopped`); a runner that starts after a
  crash tells the QEMUs it finds over their QMP sockets to quit and marks
  their machines `Interrupted` (`runner_restarted`). It never starts a
  machine on its own; a successful start clears the condition.
- The guest channel (`src/vm/channel.rs`, runner.proto's header): when
  QEMU runs, the runner connects to `ctl.sock` and reads QMP's
  `VSERPORT_CHANGE` for the agent's port (QEMU sends at most one per second
  per port and keeps the newest state, so the runner also asks
  `query-chardev` when its event reader connects, and takes `hello`, never
  the event, as the start of a session). Once the agent has the port open
  (at most 120 s after a boot, 30 s after it closed it) it waits 500 ms for
  `hello`, then sends the reset on channel 0 once and waits 2 s; a second
  miss marks the machine unhealthy in `status.guest.reason`. A deadline for
  the port that passes is not trusted: the reset goes anyway. Every `hello`
  starts a session (`DaemonFrame.session`, new for this machine across its
  QEMUs while the runner runs, else the
  reset asks again); the runner ends the channels of the session before
  (`UNAVAILABLE`, completion unknown), sends `machine_setup` (the image's
  layers topmost first, `Boot.documents`, the CA, 32 fresh random bytes,
  the image's `Env`) and puts what the agent says into `status.guest`
  (a watch event). Frames of another session are dropped; a frame that
  breaks the channel rules ends the socket and the runner connects again.
- `guest` streams: fenced as on `berth host`, at most 704 KiB of request
  (a `req` frame stays within 1 MiB), carried as one `req`/`ans` on a fresh
  channel; the agent's refusals come back in `StreamAnswer` (`not_ready`
  until its setup is applied). When cubed stops reading, the runner sends
  `abort` (the operation finishes, its answer is dropped).
- `MachineStart.boot`: only keel's documents (`hostname`, `env`,
  `hooks/pre-setup`, `hooks/pre-resume`; others `INVALID_ARGUMENT
  unknown_document`), at most 256 KiB together, kept in memory for the
  boot's setups. `Boot.mac` is ignored (below).
- The network (masterplan B-4, `src/vm/egress.rs`): every machine has one
  virtio-net device (`-netdev dgram` on a socket pair; QEMU inherits its
  end on fd 3, no socket path, no root) and the same fixed link: the guest
  `192.168.127.2/24` with MAC `02:00:00:00:00:02`, set by the kernel's
  `ip=` on the command line (no DHCP; IPv4 only), the runner at `.1` as
  gateway and resolver. Each QEMU process gets its own cube-netstack LAN in
  the runner: DNS A records (AAAA empty), TCP to ports 80 and 443 only
  (other TCP is reset, other UDP dropped), and HTTP on 80 and HTTPS on 443
  intercepted with the runner's CA (the leaf for the ClientHello's SNI; no
  SNI: closed). A new start or a restore is a new LAN; the old flows reset.
- Egress follows `MachineStart.policy` (`src/vm/policy.rs`; the rules are
  in runner.proto's comment on `EgressPolicy`): a policy berth cannot carry
  out is refused at the start (`INVALID_ARGUMENT egress_policy`; Decide
  rules `UNIMPLEMENTED egress_decide`), a start of a running machine
  replaces its policy, and no policy means no egress. Per request:
  CONNECT and Upgrade refused, `Host` must equal the SNI name, then
  `deny_hosts`, the first matching rule (a credential rule's request goes
  to cubed, below), the default, a `cube_ph_` placeholder anywhere it is
  not a credential rule's, and the address
  check: only public unicast, none of this host's own addresses and none
  of the addresses Iroh's direct paths reach cubed at (remembered for the
  runner's life; over a relay-only connection only `deny_hosts` keeps a
  guest from cubed's hosts). Upstream TLS verifies against the system
  roots. A refusal is a 403 with `x-cube-denied`.
- The lease (`src/vm/presence.rs`): while cubed has a connection to the
  runner, egress follows the policy; when the last one goes, it goes on
  for the policy's `lease` (cubed sends 15 min; absent or 0: it stops at
  once), then new flows and requests are refused, the upstream connections
  of open flows closed and DNS answers SERVFAIL, until cubed connects
  again. An open flow's guest side is not reset or cut: what was already on
  its way to the guest drains, and the connection ends as TCP ends it.
- Reports (`src/vm/report.rs`): every refusal is queued (256 per runner;
  more are dropped and counted in the next report's `dropped_before`) and
  written to cubed on one `report` stream per connection that the runner
  opens (`Open.report`), never from the flow; a write that does not finish
  in 5 s ends that stream and the rest waits for the next connection.
  (cubed reads and logs them; using them is the C phase.)
- Credentials (masterplan B-5, `src/vm/egress.rs`): a request a credential
  rule matches never goes out from the runner. It goes, placeholder and
  all, over a `credential` stream (`Open.credential`, with the machine's
  `ref` and fence) on cubed's newest connection, as one HTTP/1.1 exchange
  after cubed's `StreamAnswer`; cubed checks the machine and fence and
  carries it to cube-gateway's credential proxy, which holds the token and
  turns it back into the placeholder in the answer. Without a connection
  from cubed (the lease does not apply), when cubed refuses, or when the
  stream is not open and answered within 10 s: 503 with `x-cube-error`
  and a `credential_unavailable` report. An answer under way when cubed
  goes ends as an upstream failure does: what the runner has drains to the
  guest, then its connection ends.
- Dial (masterplan B-6, `src/serve.rs`, `src/vm/mod.rs`): cubed's portal
  opens a `dial` stream (`Open.dial`: the machine's `ref`, fence and a
  port); the runner checks the port (1024 to 65535 only, so not 22: keel
  runs no sshd), the fence as for `guest`, and that the machine runs, then
  connects from the LAN's address to the guest's port (10 s, the LAN's
  own limit), answers `StreamAnswer` and carries the bytes both ways, each
  direction ending on its own (FIN to FIN). A reset or a lost connection
  from cubed drops the guest's connection. It needs cubed's connection and
  nothing else: the egress lease does not apply.
- Templates (masterplan B-8, `src/vm/template.rs`): a machine created with
  `MachineSpec.build` (from the base only; with a template
  `INVALID_ARGUMENT build`) is a build machine, and only it gets a template
  disk, vdd: `template.raw`, raw, blank and sparse, `size.disk_gib` large,
  made only if the directory's file system has B-7's room for a blob of
  that size (3 × it + 2 GiB; else `RESOURCE_EXHAUSTED disk_space`). Other
  machines have no vdd, and their agent refuses to publish.
  `template_publish {from, fence, key, meta}` (`key` 1 to 128 printable
  ASCII characters and `meta` at most 4 KiB, both cubed's and opaque) needs
  a running build machine (`FAILED_PRECONDITION not_build`, `UNAVAILABLE
  not_running`): the agent cleans its `upper/` of cube's things (the
  runner's CA in any form, marker blocks, mount points, the agent account,
  identity; keel's `template.rs`), checks it and writes it to vdd as one
  EROFS layer (its refusal, such as `busy` or `seal_failed`, is the
  answer, and the machine stays as it was). Then QEMU is quit, vdd's EROFS
  superblock checked (magic, block size, size within the disk; else
  `FAILED_PRECONDITION template_disk`, the machine kept), and the disk
  becomes `DIRECTORY/templates/<id>.erofs` (the build machine's id): its
  record written as `publishing`, the disk renamed, cut to the layer's
  size, made read-only (0444) and hashed, the record `ready`. The build
  machine is deleted, as p3 releases its build VM. Asked again with the
  same key and meta, the same template (another: `ALREADY_EXISTS
  template`). The agent has 10 min (`completion_unknown` after); the call
  holds the runner's one-mutation-at-a-time lock meanwhile, so another
  mutation waits, but the runner's own stop does not. A runner that starts
  finishes a publication whose disk was moved and forgets one whose disk
  was not.
- A machine created with `source = template_id` gets the template as the
  topmost partition of its layer disk, above the image's layers, and in
  `MachineSetup.layers` (`Layer.template_id`). The template must be ready
  (`NOT_FOUND template`; deleted: `FAILED_PRECONDITION template_removing`)
  and built on the runner's image: on another `--image` it is refused
  (`FAILED_PRECONDITION template_image_changed`, masterplan B-8 D3) and
  stays until it is deleted. `template_delete` makes it `REMOVING`; it goes
  (file and record) once no machine that is not deleted, retained ones
  too, is made from it (p3's rule; gone: `NOT_FOUND`). `template_list` and
  `Runner.templates` (hello and watch) list ready and removing ones, with
  `users` and `bytes`. Templates are not the layer cache's (B-8 D2): never
  trimmed and not in its limit, though on the same disk; while one exists,
  the layers of its image stay in the cache.
- Not yet: diagnosis and snapshots (masterplan rows B-9, S-7a).
- `stop`, `delete` and the runner's own shutdown stop a machine the same
  way: the runner asks the agent to shut down (`DaemonRequest.shutdown`:
  SIGTERM to the workload, SIGKILL to what is left after 10 s, sync, the
  writable disk remounted read-only; done only when all of that held) and
  waits at most 30 s for done in the session it asked in, then quits QEMU.
  `machine.json`'s `stopped` and the `Stopped` condition say `controlled`
  (status true: what the machine wrote is on its disk) or `forced` (no
  session, an error or no answer: QEMU was quit as a power cut, `e2fsck` on
  the next boot); a start clears it. The guest does not power off. cubed's
  call timeout (15 s) is shorter than a forced stop can take (30 s and up to
  20 s for QEMU to quit): cubed sees `completion_unknown` and asks again,
  which waits for the first stop (a cubed change for C-1/C-2).

Tests: `packages/server/test/runner-vm-test.ts` (refusals always; keel
machines with `CUBE_TEST_BERTH_QEMU`, `CUBE_TEST_BERTH_QEMU_IMG`,
`CUBE_TEST_BERTH_KEEL`, `CUBE_TEST_BERTH_IMAGE` and `CUBE_TEST_BERTH_MKFS`;
with an image that has keel's tools it runs the Workspace contract over
cubed's `RunnerGuestTransport`) and `runner-image-test.ts` (the same
variables and `CUBE_TEST_BERTH_IMAGE_B`: the pull before listening, a warm
start, a lost layer, SIGINT and SIGKILL during a conversion, and the cache
limit with a retained machine; for host gates, not in CI). With a ready
image `runner-vm-test.ts` also runs templates (V10; `CUBE_TEST_BERTH_IMAGE_B`
for `template_image_changed`, `CUBE_TEST_BERTH_FSCK` for fsck.erofs on the
layer).

## `berth image pull`: images into a vm directory's layer cache

```text
berth image pull --dir /abs/dir --mkfs-erofs /abs/mkfs.erofs \
  --image ghcr.io/<owner>/<name>[:tag]@sha256:<digest>
```

What `berth vm` does itself when it starts (above), by hand: always a
full resolve, with keel-layers' longer mkfs.erofs limits, while berth is
stopped.

- **Pinned, public, this platform.** The image is named with its registry
  and a digest (a tag is only a label); `linux/amd64` or `linux/arm64`, the
  runner's own. An index must have exactly one entry for it (attestations
  and other platforms are skipped; `amd64` variants such as `v3` are not
  taken); the manifest's configuration must say the same platform. Public
  registries only (U4): an anonymous bearer token when asked, nothing
  stored. HTTPS only, also across redirects; the token is not sent to the
  CDN a blob redirects to.
- **Checked before used.** Index and manifest bytes must hash to their
  digests (at most 4 MiB); the configuration and each layer blob must match
  their descriptor's size and digest, written to `images/.tmp-*` first.
  Conversion reads a blob only after that, and keel-layers publishes the
  layer only if the tar matches the `diff_id` and ends properly (at most 32
  GiB per tar). Foreign layers (`urls`) and unknown media types are refused.
- **Cached once.** `layers/1/sha256:<diff_id>.erofs` (the `1` is the layer
  format, masterplan H2); a layer already there is not fetched again.
  `images/sha256:<digest>.json` records what was resolved: the platform's
  manifest, configuration and `Env`, each layer's blob, `diff_id`, cached
  file and sizes, and the `mkfs.erofs` path and version.
- **Room first.** Before each blob the images directory and the cache must
  each have 3 × the blob's size + 2 GiB free (`statvfs`; `statfs` on
  macOS); otherwise the pull stops with both numbers, before the blob is
  fetched.
- **Never half-done.** A pull holds the directory's lock (never beside a
  running `berth vm` or another pull) and removes what a crashed pull left.
  A failed pull keeps the layers it finished, each complete. SIGINT or
  SIGTERM stops it, also while it waits on the registry (a document has 120
  s in all), kills and reaps mkfs.erofs and removes temporary files. On
  Linux mkfs.erofs also dies with a SIGKILLed berth (`PR_SET_PDEATHSIG`);
  macOS has no such thing, and there it runs on until its input, which ends
  with berth, is read (keel-layers' README).

## `berth host`: unsandboxed, for developing runners

`berth host --dir DIRECTORY` runs in the foreground on a Mac or Linux host.
Each machine is `DIRECTORY/<16 hex>`, and a thread named to this runner runs
its commands and file operations **as the user who started berth, on that
host, with that user's files, network and gh/git logins**. Nothing isolates
it and no egress policy applies. Use it only to develop and debug runners,
in a terminal you watch.

```text
berth keygen --key /abs/control.key               # on the cubed host: prints cubed's control peer
berth host --dir ~/cube-dev --allow-peer <control peer> --node-id node-<name> \
  [--network loopback|direct|relay] [--listen ip:port] [--labels k=v,...] [--max-machines 8] [--python python3]
```

- The first run writes `DIRECTORY/.berth/` (its key, `host.json`, a lock)
  and prints its `peer`. Later runs need only `--dir`; `--network` and
  `--listen` may change.
- A guest operation runs `python3 DIRECTORY/<id>/bin/cube-guest host
  DIRECTORY/<id> call OP` as a child that outlives the stream. One run of
  berth is one boot of its machines.
- Nothing is ever deleted: deleting a machine retains its directory.
- It answers `runner.get`, `machine.create|start|stop|delete|get|list`,
  `watch` and `guest`. Templates, discard, diagnosis, policy, `dial`,
  `credential` and `report` answer `UNIMPLEMENTED`.
- Mutations and guest streams are fenced by `fence.epoch` per machine
  (older: FAILED_PRECONDITION `stale_epoch`); only the enrolled control peer
  may connect.

Enroll it in cubed with a version-2 config that says `"protocol": 4`, then
start threads on it by name (OptChat `spawn` with `runner`); see
ARCHITECTURE.md, "Runner protocol 4 and the host runner".

Tests: `packages/server/test/runner-host-test.ts` and
`runner-host-cubed-test.ts` drive the real binary (`scripts/test-node-transport.sh`).
