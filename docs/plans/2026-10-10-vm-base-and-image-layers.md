# keel: VM base and image layers, one guest layout on Linux and macOS

Status 2026-10-10: research and plan. The kernel (work package 1) is built in
`packages/keel/` and was booted and snapshot-tested on the maintainer's Mac;
nothing else is built and no runner uses keel yet. Written with the
maintainer before implementation; it settles the direction and the order of
work, not every interface. It builds on runner protocol 4 (PR #142, open),
whose later stages are the VM runner, the guest daemon over virtio-serial,
the runner's network stack and the credential proxy. The work packages are
sized so that cube threads can build most of them; runner acceptance still
needs a Linux host with KVM and a Mac (see "Where the work can run").

## Why

A thread machine today boots the Debian 13 genericcloud qcow2 with firmware,
is configured on first boot by a cloud-init seed (`vm-seed.ts`), runs
`cube-guest` (Python) under systemd and is reached over SSH. A project
template is a sealed qcow2 that must be scrubbed of the build machine's
identity (ARCHITECTURE.md, "Templates"). That works, but:

- firmware, GRUB, cloud-init and systemd come before the guest helper is up
  (about 25 s from start to tests done in the VM runner spike,
  docs/plans/2026-10-04-vm-runner.md);
- a template is a whole disk, so its integrity depends on the seal removing
  everything identity-bearing, and a deleted file's bytes may survive in a
  qcow2 cluster;
- the guest is one fixed image: a project cannot choose its own toolchain
  image, and any image would need Python, systemd and sshd for cube;
- nothing in it is designed for suspending a machine and resuming it later;
- macOS (HVF, arm64 guests) and Linux (KVM, x86-64 guests) boot through
  different firmware paths.

**keel** (`packages/keel`) is everything cube puts inside a thread machine
before the project's own software: a guest kernel, `cube-init` and the guest
agent, booted directly with QEMU. The guest's root filesystem is assembled
from **read-only EROFS layers** converted from OCI images, with overlayfs and
one writable disk on top, the layout of containerd's VM runtime
[nerdbox](https://github.com/containerd/nerdbox). The same layout, QEMU
arguments, init and agent run on both platforms; only the kernel and base are
built per architecture. SSH, cloud-init, the seed disk, systemd and Python
leave the guest.

## Target layout

```
keel release (versioned apart from cubed, digest-pinned, per architecture)
  vmlinuz
  base.erofs: cube-init (C, PID 1) + cube-agent (Rust, static)

per thread machine
  vda  base.erofs                      read-only, shared by every machine
  vdb  layers.vmdk -> vdb1..vdbN       read-only, one GPT partition per layer
         template layer (the project's setup)
         image layers (OCI, converted to EROFS, cached by digest)
  vdc  rw.qcow2 (ext4)                 writable, the thread's own, retained

base root (vda, read-only): cube-init (PID 1) and cube-agent run here
workload root = overlayfs(lower = template, image layers N..1; upper = vdc),
  assembled by cube-agent when the runner sends the machine's layer list over
  the channel; commands and services run inside it
```

QEMU, the same on both platforms apart from machine and console:

```
-machine virt-11.1 | pc-q35-11.1   (pinned: snapshots need the same machine)
-kernel <keel>/vmlinuz
-append "console=<ttyAMA0|ttyS0> root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init"
-drive if=virtio,format=raw,readonly=on,file=<keel>/base.erofs
-drive if=virtio,format=vmdk,readonly=on,file=<machine>/layers.vmdk
-drive if=virtio,format=qcow2,discard=unmap,file=<machine>/rw.qcow2
-device virtio-serial-pci -chardev socket,id=ctl,path=<machine>/ctl.sock,server=on,wait=off
-device virtserialport,chardev=ctl,name=cube.0
-device virtio-rtc-pci
-device virtio-balloon-pci,free-page-reporting=on
-netdev ... -device virtio-net-pci,...   (the runner's network, protocol 4)
```

No firmware and no seed drive. The kernel command line carries only settings
that are the same for every machine (console, the fixed guest address, clock
sync); identity, boot documents and the layer list arrive over the control
channel after the agent connects (below).

## How each piece works

**EROFS.** A read-only, compact Linux filesystem (in the kernel since 5.4).
`mkfs.erofs` builds an image from a directory or straight from a tar stream
(`--tar=f`, no root needed, ownership and modes preserved); `--aufs` converts
OCI whiteouts (`.wh.*`) into overlayfs whiteouts so each OCI layer is a valid
overlay lower layer. Always pass `-b4096`: on Apple Silicon the default block
size follows the host's 16 KiB pages and a 4 KiB guest kernel rejects it
(nerdbox documents the same). `-zlz4hc` decompresses fastest, `-zzstd` gives
smaller layers; the kernel has both. `-T0 --all-time` makes digests
reproducible. erofs-utils is in Homebrew (1.9.4) and Debian 13 (1.8.6, which
has `--quiet` but no `-q`).

**Layer disk.** Following nerdbox (`internal/erofs/gpt.go`, `vmdk.go`), the
layers of one machine are one virtual disk: a small file with a protective
MBR and primary GPT (one partition per layer) followed by the layer files,
stitched together by a VMDK descriptor (`twoGbMaxExtentFlat`, one `FLAT`
extent per file). No layer is copied; the descriptor is a few lines of text in
the machine's directory, and every machine reads the same cached files.
nerdbox switches to this form above 8 layers because virtio-blk has only
`vda`..`vdz`; cube always uses it, so the guest has one code path. **QEMU
silently ignores `RW <n> ZERO` extent lines**, which nerdbox writes as
padding, so cube pads with a zero-filled file as a `FLAT` extent.

**cube-init** (C, static, PID 1, in the base root). Does the bring-up below
that must happen before anything else (mounts, cgroup2, loopback), starts
`cube-agent`, starts it again if it dies, reaps orphaned processes and handles
power-off. It is small on purpose: if PID 1 dies the kernel panics and the
machine is gone. References: nerdbox's `vminitd` (`pkg/vminit/initd`) for the
bring-up, libkrun's init for a small VM init (C through v1.15, Rust on
`main`), tini for PID 1 behaviour; all Apache-2.0 or MIT.
Considered and not used: tini exits when its child exits, so an agent crash
would take PID 1 and the machine with it, and it does no mounts or power-off;
s6 (`s6-svscan` with `s6-linux-init`) would do the job but brings a
configuration format and several binaries for a short fixed list of tasks.

**Workload root.** The base root is fixed and the same for every machine; the
project's root is assembled after boot, the way nerdbox does it: its
`vminitd` runs from its own base image and the host sends `Mount.MountAll`
(type, in-VM source such as `/dev/vdb3`, target, options) and
`Bundle.Create` (files, such as the image configuration) over the channel
once connected. keel does the same over `DaemonFrame`: the runner sends the
partition-to-layer list, overlay order and image configuration; the agent
mounts each partition read-only as EROFS, formats the writable disk on first
use if it is blank, mounts overlayfs (first `lowerdir` is topmost) and runs
commands and services in that root (its own mount namespace, `pivot_root`).
This needs no manifest on disk, keeps the base snapshot-able before any
project data is mounted, and lets one booted base serve any image.

**cube-agent** (Rust, static, musl). The guest daemon of protocol 4 and the
replacement for `cube-guest`, sshd, cloud-init and systemd:

- It speaks protocol 4's `DaemonFrame` over the virtio-serial port `cube.0`
  (`hello`, `status`, `req`/`ans` per channel, `abort`; schema in
  `packages/node-transport/proto/runner.proto`, PR #142). The runner forwards
  `guest` streams to it without interpreting them, and it implements the same
  operations as `cube-guest` (`OPERATIONS`: keys journaled before anything
  happens, lease epochs, nothing run twice), so cubed's
  `RunnerGuestTransport` does not change.
- It finds its port by name (`/sys/class/virtio-ports/*/name` = `cube.0`):
  the kernel names the device `vport<virtio device index>p<port>`, so the
  node depends on how many virtio devices come first.
- It supervises processes with cgroup v2 directly, the subset of systemd cube
  uses today:

  | `cube-guest` today (systemd) | cube-agent |
  |---|---|
  | transient unit per command, `KillMode=control-group` | one cgroup per operation id; `cgroup.kill` kills the tree |
  | `RuntimeMaxSec` | timeout in the agent |
  | `ExecStopPost` records the result | the agent waits for the process; result in `/var/lib/cube/ops/<id>` as today |
  | peak memory and OOM kills from the unit's cgroup | `memory.peak`, `memory.events` |
  | `cube service` units, `Restart=on-failure` with a burst limit | restart loop with a limit |
  | journal, `journalctl` for `cube service logs` | a bounded log file per service |
  | `cube-guest-recover.service` before sshd | recover before answering on the channel |

- An agent that restarts (crash or upgrade) finds running operations again by
  their cgroups, as systemd finds units today; their children were reparented
  to `cube-init`.
- It is one static binary that stays in the base root, so images need no
  Python, systemd, sshd or cube files. The guest's `cube` command
  (`cube service`, `cube hooks`) is the same binary under another name, made
  visible in the workload root.

The kernel already has what this needs: cgroup v2 with memory, pids and
freezer controllers, cgroup BPF, PSI, `FHANDLE`, inotify, signalfd/timerfd.

**Guest bring-up without cloud-init and systemd.** What the seed and systemd
do today, split between `cube-init` (before the agent) and `cube-agent`
(after the runner has sent the machine's data):

- Mounts: proc, sysfs, devtmpfs, devpts, `/dev/shm`, tmpfs on `/run` and
  `/tmp`, cgroup2 on `/sys/fs/cgroup` with `+cpu +cpuset +io +memory +pids`
  in `cgroup.subtree_control` (as nerdbox's `vminitd`), loopback up.
- Network: every machine gets the **same fixed address** on its own private
  link to the runner (one address for all, for example `192.168.127.2/24`
  with the runner at `.1`, and one IPv6 ULA pair), set from the kernel command
  line (`ip=` autoconfiguration, built in) or by the agent with netlink. The
  runner's address is the default route and the only nameserver;
  `/etc/hosts` holds localhost and the machine's hostname. No DHCP client, and
  nothing about the address identifies the machine, so a snapshot can be
  restored as any machine.
- Hostname, the `agent` account (added to the image's `/etc/passwd` and
  `/etc/group` in the writable layer, with sudo as today), placeholders and
  hooks: from the identity the runner sends after connect.
- The runner's egress CA (protocol 4's `Runner.ca_pem`): appended to the
  image's bundle (`/etc/ssl/certs/ca-certificates.crt`, or the distribution's
  equivalent) between marker lines so a restart replaces it instead of adding
  another copy; a hash symlink in `/etc/ssl/certs` for `-CApath` users; the
  Java keystore when the image has one. Calling `update-ca-certificates`
  instead costs most of a second when a JVM hook is installed. The same
  environment variables as today's seed (`NODE_EXTRA_CA_CERTS`,
  `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, kept through sudo).
- Clock: the agent keeps `CLOCK_REALTIME` in step with the virtio-rtc PTP
  clock (`/dev/ptp0`) all the time, not only after a resume, so a resume needs
  no special message for time.

**Images.** The default image is an ordinary OCI image cube publishes (Debian
plus git and the tools threads use today). A project may name its own image;
it is pinned by digest, never by tag. The runner resolves the image index to
the manifest for its platform (`linux/arm64` or `linux/amd64`), fetches the
layers (anonymous bearer tokens for public registries), converts each layer
once (`layers/sha256:<diff_id>.erofs`) and passes the image configuration
(Env, User, WorkingDir) to the agent. Conversion follows containerd's EROFS
differ (`plugins/diff/erofs`, `internal/erofsutils`): decompress the layer
(gzip or zstd) as a stream, hash the uncompressed tar on the way to check the
`diff_id`, and pipe it into `mkfs.erofs --tar=f --aufs --quiet
-Enoinline_data -b4096 -U <uuid>` with a UUID derived from the layer digest,
so the same layer always gives the same file. containerd's faster
alternative, `--tar=i`, writes only a metadata index in front of the original
tar data; measure it before choosing. A registry that serves native EROFS
layers can skip conversion. Minimum image
requirements: `/bin/sh` and `git`; document them. Registry credentials never
reach a runner or a guest.

**Templates become a layer.** A build machine runs pre-setup and setup with an
empty writable disk; its overlay upper directory then holds exactly what setup
changed, already in overlay format, and `mkfs.erofs` of it is the template
layer. Identity material is created at runtime in the writable disk and never
lands in a layer; setup must still not write secrets into the upper
directory, so the seal's checks remain for the template layer.

**Network.** The guest has one virtio-net device. Under protocol 4 the VM
runner's own network stack carries it, with the egress policy cubed sends in
`MachineStart` and credentials substituted through the `credential` stream;
keel only needs the device and the kernel's IPv4/IPv6 stack. The shape that
works for this, and that cube-gateway already follows: a user-space TCP/IP
stack per machine on the host side (ARP, DHCP if wanted, DNS, TCP and UDP
termination, an ICMP echo proxy), one egress decision per new connection
before the host dials out, and interception of HTTP and HTTPS on the ports
the policy names by peeking at the Host header or the TLS SNI, without
relying on proxy environment variables in the guest.

**Kernel.** Linux **7.2.9** (stable) for now, moving to the next longterm
release when kernel.org announces it; 7.0 itself is no longer maintained
upstream and 6.12/6.18 longterm get fixes until December 2028. 7.x brings what
keel uses next: order-0 free page reporting (7.1, more memory returned through
the balloon), virtio `IN_ORDER` (7.0) and opt-in fsync after overlayfs
metadata copy-up (7.0); virtio-rtc (6.16) gives the guest the host's clock
after pause and restore. EROFS page cache sharing (7.0) only works within one
kernel, so it does not help between machines.

The configuration is one `make savedefconfig` file per architecture
(`packages/keel/kernel/defconfig-<arch>`, about 500 lines, no modules),
derived from nerdbox v0.2.5's (`28c86e8e16c62a08079531ebe99e24a7bdad3d62`)
with these changes: virtio-rtc, zstd EROFS, ACPI on x86-64 (q35 needs it for a
clean power-off), and none of nerdbox's `kernel/patches/`, which serve its
libkrun VMM (vsock datagrams, "Transparent Socket Impersonation"). It already
had virtio-pci and -mmio, virtio-blk, virtio-scsi, virtio-net, virtio-console,
virtio-rng, virtio-balloon with `PAGE_REPORTING`, EROFS, overlayfs, ext4, GPT,
cgroups, user namespaces and seccomp. The build fails if a defconfig no longer
describes the kernel exactly (`KEEL_REFRESH=1` writes a new one for review
after a version bump). virtio-rtc appears in the guest as a PTP clock
(`/dev/ptp0`, "Virtio PTP"), not as an RTC device.

**Why virtio-serial and not vsock.** vsock is a guest protocol; its host side
is either Linux's `vhost-vsock` module or an external vhost-user daemon. QEMU
on macOS has neither (Homebrew's 11.1.1 has no vsock and no vhost-user
devices), so a VMM would have to implement vsock itself in user space. A
virtio-serial port works the same on both platforms and is one private Unix
socket per machine on the host: no machine can reach another or other host
processes through it. It carries one byte stream per port, so channels are
multiplexed in `DaemonFrame`. vhost-vsock on Linux would be faster in theory,
but the control channel carries commands, output and small files; bulk data
(clones, packages) goes over the network.

## Verified so far

On the maintainer's Mac (Apple Silicon, QEMU 11.1.1 from Homebrew, HVF),
2026-10-10, with throwaway test inits that are not kept in the repository;
the kernels built from the committed defconfigs are byte-identical to the ones
measured.

| Question | Result |
|---|---|
| Kernel build | about 2 min per architecture in OrbStack (10 cores); a rebuild gives the same `vmlinuz` hash |
| Direct boot, mount LZ4 and zstd EROFS layers from virtio-blk, overlayfs over both with a tmpfs upper, write through it, power off | QEMU start to power-off 0.08–0.15 s arm64/HVF, 0.8 s arm64/TCG, 1.6 s x86-64 (q35)/TCG; virtio-rtc binds |
| Snapshot and resume of a running 512 MiB guest, arm64/HVF | boot to first message on virtio-serial 0.07 s; `stop` + `migrate file:` 0.24 s, file 36 MiB (pages in use only; 53 MiB on disk with `mapped-ram`); a new QEMU loads the state in 0.07–0.15 s (0.07 s with `mapped-ram`); the guest continues with its next message; EROFS reads keep working |
| The same under TCG, arm64 and x86-64 | continues; x86-64 save 0.52 s, 67 MiB, load 0.13 s |
| Guest clocks across a suspend | `CLOCK_MONOTONIC` and `CLOCK_REALTIME` stop while suspended (realtime is behind by the pause); the virtio-rtc PTP clock is within 1–7 ms of the host |
| Two EROFS files stacked by a VMDK descriptor with `FLAT` extents | `qemu-img convert` output is byte-identical to layer 1 + padding + layer 2 |
| A `RW <n> ZERO` extent line | ignored without an error: virtual size 12 → 8 KiB, layer 2 moved |
| Devices in Homebrew's QEMU 11.1.1 | present: `virtio-serial-pci`, `virtserialport`, `virtio-balloon-pci` (`free-page-reporting`), `virtio-rtc-pci`, `memory-backend-shm`, `in_order` on virtio-blk/net; absent: vsock, vhost-user devices, virtio-pmem, `vmgenid` (arm64; x86-64 has it), virtio-mem |

Not verified: anything on Linux/KVM, the layer disk inside a guest, overlay
of real OCI layers, balloon memory release, a snapshot with a writable disk
attached.

How it was measured, so package 3 can rebuild it as keel's boot check: a
static C init as PID 1 in an initramfs (`-initrd`), two EROFS images on
read-only virtio-blk, `-device virtio-rtc-pci`, and a virtio-serial port
named `cube.0` whose host end is a QEMU `server=on,wait=off` socket. The boot
test mounts both layers, overlays them on a tmpfs upper, writes through the
overlay and calls `reboot(RB_POWER_OFF)` with `-no-reboot`; time is QEMU start
to exit. The snapshot test's init writes one line every 200 ms to the port
(counter, `CLOCK_MONOTONIC`, `CLOCK_REALTIME`, the PTP clock read through
`FD_TO_CLOCKID` on `/dev/ptp0`, and a re-read of a file on the EROFS disk
after `POSIX_FADV_DONTNEED`). Over QMP the host runs `stop`,
`migrate uri=file:<path>` (optionally after `migrate-set-capabilities`
`mapped-ram` on both sides), polls `query-migrate` until `completed` and
`quit`s; a new QEMU with the same arguments plus `-S -incoming defer` gets
`migrate-incoming` and `cont`. Two traps: QEMU removes its socket files when
it quits, and a QEMU child that inherits the test's stdout keeps a shell pipe
open after the test dies.

## Built for snapshot and resume

Suspending idle threads to a file and resuming them comes soon after this
layout (protocol 4 reserves `MachineStatus` fields 20–29 for it), so keel is
designed for it from the start:

- **Clock.** The guest's clocks stop while it is suspended. The agent's
  continuous sync from `/dev/ptp0` (bring-up above) corrects
  `CLOCK_REALTIME` within one sync interval of resuming. Timeouts on
  `CLOCK_MONOTONIC` do not count suspended time; decide per timeout whether
  that is wanted.
- **Before saving.** The runner asks the agent to prepare: finish or park what
  it is writing, `sync`, drop the page cache (`/proc/sys/vm/drop_caches`) and
  let free page reporting return memory, so the file holds little more than
  the processes' own memory. The agent answers when it has settled, and holds
  new operations until the runner has saved.
- **Channel.** The host end is a new socket after restore; every channel that
  was open at the snapshot is closed, and the guest sees it close. The agent
  reconnects and the runner opens channels again; every operation is
  idempotent by key with epoch fencing, as today.
- **Disks.** Base and layer disks are read-only and always match. The writable
  disk must be exactly the state saved with the memory: suspend is stop, save,
  quit, and a machine is never booted from that disk while its memory file
  exists (a cold boot deletes the memory file first). Snapshots of a machine
  that keeps running need a qcow2 overlay taken at the same instant (later).
- **Same machine on restore.** Pin the machine type and record the QEMU
  version and keel version with each snapshot; after an upgrade old snapshots
  are dropped and the machine boots cold. `-cpu host` ties a snapshot to its
  runner, which is where it stays; a snapshot also cannot move between
  hypervisors (KVM and HVF register state differ).
- **Memory.** The file holds the pages in use; free page reporting keeps that
  small. `mapped-ram` loads faster and gives fixed offsets. Later, repeated
  saves of the same machine can write only the pages dirtied since the last
  one; a device that writes guest memory outside QEMU's dirty tracking (a
  GPU) would make that unsafe, and keel has none.
- **Identity after boot, not at boot.** VM id, epoch, hostname, placeholders
  and protocol 4's `Boot.documents` reach the agent over the channel after it
  connects, never on the kernel command line or a seed disk. A snapshot of a
  booted template can then later be restored as many machines, faster than
  any boot. Clones also need a fresh random seed: `vmgenid` exists only for
  x86-64, so the runner sends entropy and the agent reseeds on both
  architectures.

What `DaemonFrame` needs beyond PR #142 for keel:

- a version handshake: keel version, kernel version and capabilities, as
  nerdbox's `System.Info` (`version`, `kernel_version`) and protocol 4's
  `GuestInfo` already sketch;
- after every (re)connect: identity, `Boot.documents`, entropy and the
  machine's layer list and image configuration (nerdbox's `Mount.MountAll`
  and `Bundle.Create`), each idempotent so a reconnect after restore can send
  them again;
- prepare-for-snapshot and settled answers (above);
- channel close semantics on restore (above).

## Decisions

- One guest layout, one set of QEMU arguments, one `cube-init` and one
  `cube-agent` for Linux and macOS; architecture only selects the kernel and
  base build.
- QEMU stays the VMM. The control channel is virtio-serial, carrying protocol
  4's `DaemonFrame`; no vsock.
- No SSH, cloud-init, seed disk, systemd or Python in the guest. `cube-init`
  (C) is PID 1; `cube-agent` (Rust) supervises with cgroup v2. Both run from
  the base root; the agent assembles the workload root after the runner sends
  the layer list.
- Every machine has the same fixed guest address on its private link; nothing
  in the guest's network identifies the machine.
- Kernel: nerdbox v0.2.5's config as a defconfig, without its libkrun patches,
  on Linux 7.2.9 until the next longterm release.
- OCI is the build and distribution format for images; the layer disk is
  always GPT + VMDK padded with `FLAT` zero files.
- keel is versioned and released apart from cubed (kernel fixes do not follow
  cubed's releases) and cube pins a keel version. It stays in this repository
  while `DaemonFrame` changes often, since the runner and the agent share it;
  it moves to its own repository once that protocol is versioned with
  compatibility rules.
- keel is built from upstream Linux, nerdbox (Apache-2.0) and its own code.

## Work packages

Each package lists where it can be done (see below) and what counts as done.

**1. Kernel.** Built: `packages/keel/kernel/build.sh`. Remaining: a boot under
KVM on the Linux runner host (comes with package 3).

**2. Layer tooling (Rust, runner side).** OCI layer tar to EROFS by calling
`mkfs.erofs -b4096 -zlz4hc -T0 --all-time --tar=f --aufs`, cache keyed by
diff ID with atomic publish; GPT header and VMDK descriptor writer with
`FLAT` padding. Thread. Done: unit tests, including a `qemu-img convert` byte
comparison and a regression test that no descriptor contains `ZERO`.

**3. cube-init and base.erofs.** Bring-up and supervision of the agent, with
clear failure output on the console; a minimal agent stand-in that mounts a
layer disk and the writable disk into a workload root. Thread (TCG). Done:
the default image's layers mount as a workload root under TCG, KVM and HVF;
a second boot keeps the writable disk's changes. This replaces the throwaway
boot tests as keel's boot check.

**4. cube-agent.** `DaemonFrame` over virtio-serial and the extensions above;
the operations of `cube-guest`; cgroup supervision; services; clock step on
resume; reconnect. Depends on PR #142 and the extensions agreed in it. Thread
for the code (TCG). Done: the Workspace contract tests of
`runner-host-test.ts` pass against a keel machine.

**5. keel release and default image.** CI builds `vmlinuz`, `base.erofs` and
the default OCI image per architecture, with digests; cube pins a keel
version. Publishing to a registry or a release needs explicit authorization.
Done: digests reproducible across two builds.

**6. Protocol 4 VM runner.** QEMU with the arguments above, per-machine
`layers.vmdk`, retained writable disk, image fetch and layer cache with
garbage collection under the journal's retention rules, templates as a layer,
`Boot.documents` delivered over the channel. A new `CUBED_STATE` (old
registries are not migrated) and updates to ARCHITECTURE.md,
docs/platforms.md, docs/runner-operations.md and SECURITY.md (the channel is
a new guest-to-host path the runner treats as hostile). Acceptance on hosts:
`scripts/test-node-transport.sh` on Linux/KVM and on a Mac.

**7. Suspend and resume.** Idle threads saved to a file and resumed on
demand, with the rules above. Acceptance on hosts, with a writable disk and a
running command across the suspend.

**8. Memory.** Balloon with free page reporting; measure that QEMU's resident
memory falls after the guest frees memory, on both platforms.

**Later.** Template snapshots restored as many machines; private images;
virtio-pmem/DAX on Linux.

Packages 2 and 3 are independent and can run in parallel; 4 needs the
`DaemonFrame` extensions settled in PR #142's line of work.

## Where the work can run

Thread machines run with HTTP/HTTPS egress only and, as far as known, without
nested virtualization, so a thread can build kernels and images and boot them
with QEMU's TCG (slow, but enough for boot, mount and snapshot tests; it is
not acceptance for timing). KVM and HVF acceptance, runner smokes and
`scripts/test-node-transport.sh` need the Linux host and the Mac. Mocks are
not runner acceptance.

## Open questions

- Who fetches private images, and where their credentials live.
- Image allow-listing per installation or project.
- Layer cache size limits and when unused layers are deleted.
- Whether to keep qcow2 templates during a transition or switch at once (a new
  `CUBED_STATE` either way).
- Kernel updates: when to move from 7.2.y to the next longterm release, and
  who watches stable releases for security fixes until then.
- Whether suspended time should count against command timeouts.
- `--tar=f` against `--tar=i` for layer conversion: speed and disk use with
  real images.
