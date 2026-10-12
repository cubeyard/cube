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
  --keel /abs/keel/out/<arch> [--accel kvm|hvf|tcg] --allow-peer <control peer> --node-id node-<name> \
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
  lacks (QEMU 8.2.2: `virtio-rtc-pci` and `mapped-ram`). `Platform.qemu_version`
  is its version and path.
- Each machine is `DIRECTORY/<16 hex>`: `machine.json` (its journal, written
  whole and renamed before an answer), `rw.qcow2` (vdc, the writable disk,
  created once and never replaced), `layers.vmdk` (vdb, read-only; no image
  layers yet), `ctl.sock` (`cube.0`), `qmp.sock`, `console.log`, `qemu.log`,
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
- Not yet: the guest channel (guest streams answer `UNIMPLEMENTED`,
  `status.guest` is empty), a network device, image layers, templates,
  diagnosis and snapshots (masterplan rows B-2, B-4, B-7, B-8, B-9, S-7a).
  `stop` is QMP `quit`, not a clean power-off.

Test: `packages/server/test/runner-vm-test.ts` (refusals always; keel
machines with `CUBE_TEST_BERTH_QEMU`, `CUBE_TEST_BERTH_QEMU_IMG` and
`CUBE_TEST_BERTH_KEEL`).

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
