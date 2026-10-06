# Runner operations

This is the operations boundary for Cube **runners**. A runner hosts one QEMU
virtual machine per active thread. It runs no command of its own for a thread:
the agent's tools run inside the thread's VM, reached over SSH through
`cube-gateway` next to cubed. One installation has one immutable
installation/environment binding, speaks runner protocol 3, belongs to the
global Cube pool, hosts a bounded number of active VMs at once (see
[thread machines per runner](#thread-machines-per-runner)), and uses Iroh's
public N0 discovery/relay transport.

> Status: built and verified on Linux/KVM with a real Debian guest, the real
> gateway and cubed (`scripts/smoke-runner-vm.ts`,
> `scripts/smoke-node-adapter.ts`, `scripts/test-vm-e2e.ts`,
> `scripts/test-vm-concurrency.ts` for two VMs on one runner, and a live run
> against GitHub). macOS (HVF) has code paths only and is unverified; runner
> and cubed on separate machines (direct or relay mode) are not verified yet.

| Platform | Lifecycle | Profile |
|---|---|---|
| Linux x86-64 (KVM) | foreground `cube-runner run` | laptop/direct default |
| Linux x86-64 (KVM) | explicit systemd service, dedicated `cube-runner` account in group `kvm` | always-on server |
| macOS arm64 (HVF, unverified) | foreground, LaunchDaemon or per-user LaunchAgent | later |

Packages are native to their manifest's OS and architecture.

## Requirements

- Linux x86-64 with KVM (`/dev/kvm` readable and writable by the runner
  account), or macOS arm64 with Hypervisor.framework (`kern.hv_support` 1).
- QEMU 7.2 or newer (`-netdev dgram`) with `qemu-img`; on Debian/Ubuntu
  `qemu-system-x86` and `qemu-utils`. macOS also needs the arm64 UEFI firmware
  (`edk2-aarch64-code.fd`, shipped with Homebrew QEMU).
- A Debian 13 genericcloud qcow2 image (`debian-13-genericcloud-amd64.qcow2`
  or `-arm64`) supplied by the operator. The runner downloads nothing; it
  copies the image into its state at init and identifies it by sha256.
- Disk for the base image, one qcow2 overlay per VM (up to `--max-disk-gib`,
  default 64 GiB) and retained VM disks.

`runner-serve`/`run` refuse to start without the accelerator or with an older
QEMU, and refuse a base image whose size, mode or sha256 changed.

## Trust and security model

The guest is the thread's sandbox. A thread's commands run as user `agent`
(with sudo in the guest) inside its VM; they cannot see the runner account,
its key or its journal, and they have no network of their own: the VM's only network device is a
`-netdev dgram` unix socket pair inside the VM directory. The runner pumps
those Ethernet frames to `cube-gateway` over Iroh (ALPN `cube/l2/1`) and opens
no other socket for the guest. All guest traffic leaves through cubed's
gateway, which allows HTTP/HTTPS to public addresses only and asks cubed's
policy about every request. The guest holds no real credential: the GitHub
token is a placeholder that the gateway replaces for github.com and
api.github.com, so it never reaches the runner either.

QEMU itself runs **as the runner account** and is not hardened beyond
`-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`
(Linux; no seccomp sandbox on macOS). A guest escape through a QEMU bug would
have the runner account's authority. Keep giving that account no
control-plane, provider, GitHub, SSH, cloud or login credentials, sudo, or
privileged groups other than `kvm`. Do not call the runner host as a whole a
sandbox. The runner account can read every VM disk it hosts, including
retained ones, so the workspace contents are only as private as that account.

The frame channel is authorized per VM by the latest accepted `vm.start`: it
names the gateway's Iroh peer and a frame token (the runner keeps only its
sha256). A peer that is no VM's gateway is closed before any byte is read; a
wrong token, VM or thread is refused; a newer start rotates the token and drops
the old frame connection.

Iroh authenticates the pinned peer IDs and encrypts QUIC end to end. `peerId`
is transport identity; persisted `nodeId` is Cube's logical node identity. N0
operators can observe endpoint IPs and traffic metadata. Relay mode requires no
inbound public listener.

## Foreground install and operation

```sh
bash scripts/setup-dev.sh
bash scripts/runner/package.sh /absolute/private-output/cube-runner.tar.gz
cd /absolute/private-output
sha256sum -c cube-runner.tar.gz.sha256
tar -xzf cube-runner.tar.gz
cd cube-runner
bash scripts/runner/install.sh "$PWD/bin/cube-runner"
"$HOME/.local/bin/cube-runner" init --home "$HOME/.cube/runner" \
  --image /absolute/debian-13-genericcloud-amd64.qcow2 --allow-peer CONTROL_PEER \
  --node-id NODE_ID --thread-id THREAD_ID --env ENVIRONMENT_ID --network relay
"$HOME/.local/bin/cube-runner" run --home "$HOME/.cube/runner"
```

`init` also takes `--qemu PATH`, `--firmware PATH`, `--max-vcpus` (default 4),
`--max-memory-mib` (8192) and `--max-disk-gib` (64); they are recorded in the
immutable installation. The foreground process reports `network ready /
waiting for cubed`. First Ctrl-C refuses new VMs and powers the running guest
down (ACPI, up to 30 seconds); a second Ctrl-C makes QEMU quit at once and
marks the VM `interrupted`. Restart with the same home. A VM that was running
when the runner died is recorded `stopped` and `interrupted` at the next start;
cubed boots it again from the same disk.

## Thread machines per runner

A runner hosts up to `--max-active-vms` thread VMs at once, each its own QEMU
process, qcow2 overlay, seed, frame channel and gateway LAN; threads on one
runner share nothing but the host. `run` and `runner-serve` take
`--max-active-vms auto|N` (N from 1 to 32), or `CUBE_RUNNER_MAX_ACTIVE_VMS`
when the flag is absent. It is a process option, not part of the immutable
installation: restart the runner to change it.

The runner logs the bound and where it came from at every start
(`runner_starting` with `maxActiveVms` and `maxActiveVmsSource` `auto` or
`explicit`), and puts it in the ready line.

`auto`, the default, counts the VMs that fit if every one uses the
installation's per-VM maximum (`--max-vcpus`, `--max-memory-mib`), so the host
is never oversubscribed whatever sizes cubed asks for: host memory less 2 GiB
divided by `--max-memory-mib`, host CPUs divided by `--max-vcpus`, the smaller
of the two, at least 1 and at most 4. With the defaults (4 vCPUs, 8 GiB) a
16 GiB host gets 1, a 32 GiB host with 8 cores gets 2 and a 64 GiB host with 16
cores gets 4. cubed's default VM is 2 vCPUs and 4 GiB, so `init` with
`--max-vcpus 2 --max-memory-mib 4096` lets `auto` count real usage instead of
the larger default bound. Disk is not part of the count; instead `vm.allocate`
refuses a new VM (`CAPACITY_EXCEEDED`, "the runner's disk has less than 4 GiB
free") while the state filesystem has less than 4 GiB free, because a full
disk would fail every running guest. `CUBE_RUNNER_MIN_FREE_DISK_GIB` changes
the floor (0 turns it off). Each overlay still grows up to `--max-disk-gib`
and retained disks stay until discarded, so size the disk for the VMs you
expect to keep. An explicit N is the operator's decision; QEMU commits
memory lazily, and a guest that uses all of it competes with the others.

Systemd: add a drop-in instead of editing the shipped unit, then restart:

```sh
sudo systemctl edit cube-runner.service   # [Service] Environment=CUBE_RUNNER_MAX_ACTIVE_VMS=2
sudo systemctl restart cube-runner.service
```

A drop-in survives upgrades. macOS uses `auto`: install and upgrade rewrite
the LaunchAgent/LaunchDaemon plist, so an explicit bound added to it does not
persist yet. A foreground `cube-runner run` takes the flag directly.

The bound is enforced by the runner: `vm.allocate` beyond it is
`CAPACITY_EXCEEDED`, decided under the runner's mutation lock, so two
requests can never take the last slot. A start waits for QEMU's QMP
without holding that lock, so VMs booting together do not queue behind each
other. A VM holds its slot from allocation until it is released or retained;
a stopped or interrupted VM still holds it.
Lowering the bound only refuses new VMs. The ready line, `node.hello` limits
and `node.status` report it as `maxActiveVms`.

cubed records the bound at enrollment, at every runner check and at every
machine start, and counts its open threads against it: a thread holds a slot
on its runner from creation until its archive finishes, also while its machine
is failed or releasing. A new thread goes to the runner with the lowest share
of used slots, runners with a failed machine last; the count and the new
thread are one `BEGIN IMMEDIATE` registry transaction. If the runner refuses a machine anyway (a lowered bound, the disk floor, a
VM cubed does not know), a new thread whose agent has not opened yet moves to
another runner with a free slot and starts there; otherwise it shows the
reason and cubed's recovery loop tries again every 30 seconds while it holds
its slot. Runners before 0.7.0 report 1 and keep one thread at a time,
exactly as before.

Existing runners: a self-update to 0.7.0 restarts the runner with `auto`, so a
host with room gets more than one VM without any change, and cubed uses the
new bound after its next runner check or machine start. Going back to an
older cubed is safe while no runner hosts more than one open thread; with
several, the older cubed can place a thread on a runner that already holds
one, which the 0.7.0 runner accepts up to its bound. `cubed runners status`
is a separate process using the runners' control keys; run it while cubed is
quiet, as before. Draining and the
self-updater still wait until no VM is active, so a busier runner updates less
often; drain it to make room for an update.

## Always-on service (Linux)

```sh
sudo bash scripts/runner/install.sh --service "$PWD/bin/cube-runner"
sudo bash scripts/runner/initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID \
  /absolute/debian-13-genericcloud-amd64.qcow2
```

`install.sh --service` creates the `cube-runner` system account (QEMU/KVM must
already be installed so the `kvm` group exists), the layout below and the
unit. The unit runs `runner-serve` with `SupplementaryGroups=kvm`,
`TimeoutStopSec=60` and `KillMode=mixed`. `initialize.sh` copies the base image
into the state (it must be readable by the runner account), enrolls the
immutable binding and starts the service. It prints only the public Iroh peer.

On the cubed host, write the runner's private connection config (version 2,
mode 0600, next to a control key whose public peer you passed as
`CONTROL_PEER`) and enroll it. Create a separate control key
(`cube-runner keygen`) for every runner; enrollment refuses a key another runner
already uses, because two endpoints publishing one Iroh identity break each
other's calls:

```json
{"version":2,"binding":{"nodeId":"NODE_ID","threadId":"THREAD_ID","environmentId":ENVIRONMENT_ID},
 "controlKey":"/abs/control.key","serverPeer":"<printed runner peer>","network":"relay"}
```

```sh
node scripts/enroll-runner.ts --state "$CUBED_STATE" --config /abs/runner.json --trusted-runner
```

(`"network":"direct"` or `"loopback"` add `"address":"host:port"`.) The script
makes an authenticated protocol-3 hello first and refuses a protocol-2 runner.
cubed runs its gateway in the widest network mode among enrolled runners; a
wider runner enrolled while cubed runs restarts the gateway at its first use.

| Path | Owner/mode | Purpose |
|---|---|---|
| `/opt/cube-runner/releases/<version>` | root, 0755 | immutable daemon release |
| `/opt/cube-runner/current` | root symlink | selected release |
| `/etc/systemd/system/cube-runner.service` | root, 0644 | service boundary |
| `/var/lib/cube-runner/identity/node.key` | cube-runner, 0600 | Iroh identity secret |
| `/var/lib/cube-runner/state/journal.db` | cube-runner, 0600 | immutable installation, VM records, lease epochs |
| `/var/lib/cube-runner/state/images/<sha256>.qcow2` | cube-runner, 0400 | base image |
| `/var/lib/cube-runner/state/vms/<n>/` | cube-runner, 0700 | `disk.qcow2`, `seed.img`, `console.log`, `qemu.log`, QMP and frame sockets |
| `/run/cube-runner/ready.json` | runtime only | readiness, version, platform, base image hash |

macOS uses `/Library/Application Support/CubeRunner` (system) or
`~/Library/Application Support/CubeRunner` (user) with the same `data/state`
structure; it is unverified this round.

## Status, drain and stop

```sh
sudo systemctl start cube-runner
sudo bash scripts/runner/status.sh
sudo bash scripts/runner/drain.sh
journalctl -u cube-runner --since today --no-pager
```

Drain (SIGUSR1, `systemctl reload`) is local operator authority: `vm.allocate`
and `vm.start` fail with `DRAINING`, running VMs keep running and stay
inspectable. SIGUSR2 resumes. Stop (SIGTERM) refuses new work, powers every
running guest down (30 seconds, then QMP `quit`, then SIGKILL of the QEMU the
runner spawned) and exits. With `CUBE_RUNNER_STOP_POLICY=cancel` QEMU is told
to quit at once. On Linux QEMU also dies with the runner (`PR_SET_PDEATHSIG`),
so a killed runner never leaves a guest running.

`node.status` reports `lifecycle`, `draining`, `activeVms`, `runningVms`,
`maxActiveVms`, `retainedVms` and `retainedBytes`. Logs carry bounded runner
events (`runner_starting`, `runner_ready`, `runner_draining`,
`runner_stopping`) without keys, tokens, seeds or guest output. Each VM's serial
console is in `vms/<n>/console.log`; `vm.inspect` returns its last 16 KiB.

## Retained VMs

Releasing a VM deletes its directory only when cubed found the thread clean
(`retain: false`: the agent never ran a command or wrote a file there, and
the guest's release check is clean) and the VM was never interrupted. Any
other thread (`retain: true`), an interrupted VM and a failed transition keep the disk as
evidence (`retained` / `failed`); they no longer hold the VM slot.
`retainedBytes` shows their size. Inspect a retained disk offline, for
example with `qemu-img info` or by booting a copy. The runner never deletes a
retained disk on its own: the operator discards it from the project page
("retained machines", which lists archived threads with a kept disk) or with
`POST /api/threads/<id>/discard`, which sends `vm.discard` (cube-runner 0.5.0
or newer; an older runner answers `UNSUPPORTED`).

## Self-update

`install.sh --service` (and every upgrade) installs a self-updater beside the
release: `updater/` under the software root, holding the runner scripts and
the pinned release public key (the same Ed25519 key that signs cubed
updates). On Linux a root `cube-runner-update.timer` runs it hourly; on macOS
a launchd job `com.cubeyard.cube-runner-update` does, beside the runner's own
plist. Each run:

1. fetches `cube-runner-<platform>.json` and its `.sig` from the published
   `latest` release (`linux-x64-gnu`, `darwin-arm64`);
2. verifies the signature with the pinned key using the installed runner
   (`cube-runner verify-release`) and stops unless the version is newer;
3. waits (exits, to retry next hour) while the runner has an active thread
   machine (`cube-runner idle` reads the journal read-only);
4. downloads the bundle, checks its size and sha256 against the signed
   manifest and the binary's version, and runs that bundle's `upgrade.sh`
   (drain, switch, readiness, rollback on failure), which also refreshes the
   updater.

The runner account never writes its own binaries; the updater runs as root
on Linux (as the runner's user on macOS). Set `CUBE_RUNNER_SELF_UPDATE=0`
when installing to skip it; `systemctl disable --now cube-runner-update.timer`
or `launchctl bootout gui/$(id -u)/com.cubeyard.cube-runner-update` turns it
off later. Logs: `journalctl -u cube-runner-update` or `logs/update.log`.

## Upgrade

Runners with the self-updater (cube-runner 0.6.0 or newer) upgrade
themselves. To upgrade by hand, or to install the updater the first time:

```sh
sudo bash scripts/runner/upgrade.sh "$PWD/bin/cube-runner"
```

`install.sh` and `upgrade.sh` accept only protocol-3 binaries (cube-runner
0.4.0 or newer). An upgrade drains, stops (guests power down; cubed boots them
again), switches `current`, requires readiness of the new version and restores
the previous release and unit on failure.

**From protocol 2.** A protocol-2 runner executed commands as its own account;
its state cannot be carried over and `upgrade.sh` refuses it. Re-enroll:
archive or finish the runner's threads in cubed, back up the old state, run
`uninstall.sh --keep-state`, move `/var/lib/cube-runner` aside, install the new
release with `--service`, run `initialize.sh` with the base image, and enroll
the new peer in cubed. Opening old state fails with "this state belongs to a
protocol-2 runner". The cube-host (protocol 1) layout and its rollback scripts
are gone.

## Backup, restore and quarantine

```sh
sudo bash scripts/runner/backup.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/restore.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/acknowledge-recovery.sh --i-reviewed-retained-vms
sudo systemctl start cube-runner
```

Backup stops the service first (guests power down) and archives the whole state
root: the Iroh private key, the journal, the base image and every VM disk with
the guest's files. Keep the archive and its checksum private and together; it
can be large. Restore never starts the service and creates
`restore-quarantine`: while it exists the runner reports `recoveryRequired` and
refuses `vm.allocate`/`vm.start`. VMs that were running at backup time come
back `stopped`; a guest's own journal marks its unfinished commands
interrupted when it boots. Acknowledgement runs in the runner account, opens the
journal with the restored key, verifies the base image hash and removes the
quarantine. Overlays name their base image by a relative path, so a restored
state directory may live at another path.

Software-only uninstall preserves state:

```sh
sudo bash scripts/runner/uninstall.sh --keep-state
```

## Replacement and re-enrollment

There is no in-place key, peer, node, thread, environment or admission
rotation. If a key is lost without a matched backup, archive the old threads,
keep the old state for inspection and enroll a fresh runner with new
identities.

## Limits and diagnostics

At most `maxActiveVms` active VMs per runner. Per VM: `vcpus` up to `maxVcpus`, memory from 256 MiB
to `maxMemoryMiB`, a disk at least the base image's virtual size and at most
`maxDiskGiB`, a seed of at most 64 KiB. Control requests are bounded to 1 MiB
frames and 5 seconds; `vm.stop` and `vm.release` therefore complete
asynchronously (poll `vm.inspect`). Frame connections are limited to 32. These
are admission bounds, not host resource quotas.

| State/error | Action |
|---|---|
| `DRAINING` | wait, or resume/restart after maintenance |
| `CAPACITY_EXCEEDED` | `maxActiveVms` VMs are active (archive a thread, or restart the runner with a higher `--max-active-vms`), or the message names a state disk with less than 4 GiB free (discard retained disks or free space) |
| `CONFLICT` | the vmId exists for another thread or with another disk size, the thread already has another active VM, a start names a different mac, or the VM is in a state that cannot start |
| `INCOMPATIBLE_PROTOCOL` | upgrade the older cubed/cube-runner component |
| `UNSUPPORTED` | a protocol-2 method (`exec.*`, `fs.*`, `workspace.*`) reached a protocol-3 runner |
| `LEASE_STALE` | a newer thread lease owns the VM; never retry with the old epoch |
| `recoveryRequired` | review retained VMs, then acknowledge while stopped |
| `interrupted` on a VM | the runner died or the guest was killed; the next boot clears it, a release keeps the disk |
| `error` on a stopped VM | QEMU exited unexpectedly; see `vms/<n>/qemu.log` and `console.log` |
| `WRONG_NODE` | verify Iroh peers and the full immutable binding out of band |
| `faulted` / `IO_ERROR` | stop, preserve state, inspect disk/journal ownership |

## Production acceptance

`scripts/test-node-transport.sh` runs the runner acceptance with a real guest
when `/dev/kvm`, QEMU and `CUBE_TEST_VM_IMAGE` are present (and skips loudly
otherwise; `CUBE_TEST_VM=required` makes that a failure). Release sign-off also
needs the service profile over N0 relay: install, enrollment, a real thread,
drain and stop, upgrade with induced rollback, runner loss, backup/restore
quarantine and re-enrollment, on each platform separately.
