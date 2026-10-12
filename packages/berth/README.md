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
berth image pull --dir /abs/dir --mkfs-erofs /abs/mkfs.erofs --image <registry/repository@sha256:…>
berth vm --dir /abs/dir --qemu /abs/qemu-system-<arch> --qemu-img /abs/qemu-img \
  --keel /abs/keel/out/<arch> --image <registry/repository@sha256:…> [--accel kvm|hvf|tcg] \
  --allow-peer <control peer> --node-id node-<name> \
  [--network loopback|direct|relay] [--listen ip:port] [--labels k=v,...] [--max-machines 8]
```

- QEMU, qemu-img and the keel release (`vmlinuz`, `base.erofs`) are given
  by absolute path on every start; berth never searches `PATH` or home
  directories. Before it touches `--dir` it starts the QEMU with `-machine
  none` and reads keel's QEMU floor over QMP (runner.proto's header:
  `virtio-rtc-pci`, `virtio-serial-pci` and `virtserialport`,
  `virtio-balloon-pci` with `free-page-reporting`, a versioned machine type,
  the `mapped-ram` capability, migration mode `cpr-reboot`, the migration
  commands, the accelerator); a QEMU below it is refused with what it
  lacks (QEMU 8.2.2: `virtio-rtc-pci` and `mapped-ram`); on x86-64 it also
  needs `vmgenid`, which every machine gets (`guid=auto`, so a restore
  reseeds the guest's random generator). `Platform.qemu_version` is its
  version and path.
- `--image` names the one image every machine is built on, pinned by
  digest; `berth image pull` must have put it into `--dir` first (berth vm
  does not pull). A machine's layer disk holds its layers from creation on,
  and the machine keeps that image: a runner started with another refuses to
  start it (`FAILED_PRECONDITION image_changed`).
- The runner's CA: `DIRECTORY/.berth/ca/` (0700) with `ca.key` (0600, never
  logged or sent) and `ca.pem`, made on the first start and kept. Half a
  pair, a key others can read, or a certificate that does not carry the key
  is refused, never replaced. The certificate is `Runner.ca_pem` and goes to
  every machine in `machine_setup`; nothing signs with the key until the
  runner's network (B-4).
- Each machine is `DIRECTORY/<16 hex>`: `machine.json` (its journal, written
  whole and renamed before an answer), `rw.qcow2` (vdc, the writable disk,
  created once and never replaced), `layers.vmdk` (vdb, read-only, the
  image's layers from the cache), `ctl.sock` (`cube.0`), `qmp.sock`, `qev.sock`
  (QMP for the runner's event reader), `console.log`, `qemu.log`,
  `argv.json`, `events.log`. vda is the keel base, read-only. The newest
  versioned machine type is pinned when a machine is created; a QEMU
  without it does not start the machine (`FAILED_PRECONDITION machine_type`).
- Verbs: `runner.get`, `machine.create` (`STOPPED`), `start` (QEMU runs it:
  `RUNNING` with a new `boot_id`), `stop` (QMP `quit`), `delete` (stops it;
  `RETAINED` when asked to retain or when the runner interrupted it,
  otherwise the directory is deleted: `DELETED`), `discard` (a retained
  machine's directory is deleted), `get`, `list`, `watch`. Ids are never
  reused. Mutations are fenced as on `berth host`.
- Each QEMU runs in a process group of its own. When the runner stops
  (Ctrl-C, SIGTERM) it quits its machines' QEMUs and marks them with the
  `Interrupted` condition (`runner_stopped`); a runner that starts after a
  crash tells the QEMUs it finds over their QMP sockets to quit and marks
  their machines `Interrupted` (`runner_restarted`). It never starts a
  machine on its own; a successful start clears the condition.
- The guest channel (`src/vm/channel.rs`, runner.proto's header): when
  QEMU runs, the runner connects to `ctl.sock` and reads QMP's
  `VSERPORT_CHANGE` for the agent's port. Once the agent has the port open
  (at most 120 s after a boot, 30 s after it closed it) it waits 500 ms for
  `hello`, then sends the reset on channel 0 once and waits 2 s; a second
  miss marks the machine unhealthy in `status.guest.reason`. A deadline for
  the port that passes is not trusted: the reset goes anyway. Every `hello`
  starts a session (`DaemonFrame.session`, new for this machine, else the
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
  boot's setups. `Boot.mac` and `MachineStart.policy` are not used before
  the network (B-4).
- Not yet: a network device, pulls by the runner and the cache limit,
  templates, diagnosis and snapshots (masterplan rows B-4, B-7, B-8, B-9,
  S-7a). `stop` is QMP `quit`, a power cut for the guest (`e2fsck` on the
  next boot): keel has no controlled power-off yet.

Test: `packages/server/test/runner-vm-test.ts` (refusals always; keel
machines with `CUBE_TEST_BERTH_QEMU`, `CUBE_TEST_BERTH_QEMU_IMG`,
`CUBE_TEST_BERTH_KEEL`, `CUBE_TEST_BERTH_IMAGE` and `CUBE_TEST_BERTH_MKFS`;
with an image that has keel's tools it runs the Workspace contract over
cubed's `RunnerGuestTransport`).

## `berth image pull`: images into a vm directory's layer cache

```text
berth image pull --dir /abs/dir --mkfs-erofs /abs/mkfs.erofs \
  --image ghcr.io/<owner>/<name>[:tag]@sha256:<digest>
```

The first part of masterplan row B-7; machines do not use the layers yet
(B-7 wires them into `machine_start`, B-2 brings `machine_setup`).

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
- **Never half-done.** A pull holds the directory's lock (never beside a
  running `berth vm` or another pull) and removes what a crashed pull left.
  A failed pull keeps the layers it finished, each complete. SIGINT or
  SIGTERM stops it, kills and reaps mkfs.erofs and removes temporary files.
- Not yet: eviction under a limit in `host.json` (U6; `LayerCache::evict`
  exists) and checking free space before a conversion.

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
