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
immutable installation. QEMU, `qemu-img` and the firmware are recorded as the
paths given (or found on `PATH`), made absolute but with symlinks kept, so a
package manager's launcher such as Homebrew's `/opt/homebrew/bin/qemu-system-aarch64`
stays valid across the package's upgrades; `run` checks that they still exist
and that QEMU still answers. The foreground process reports `network ready /
waiting for cubed`. First Ctrl-C refuses new VMs and powers the running guest
down (ACPI, up to 30 seconds); a second Ctrl-C makes QEMU quit at once and
marks the VM `interrupted`. Restart with the same home. A VM that was running
when the runner died is recorded `stopped` and `interrupted` at the next start;
cubed boots it again from the same disk.

## Local runner

A runner on the cubed host itself, reached over loopback, is set up and
enrolled by one cubed command (the `cube-runner` binary on `PATH`, or
`CUBE_RUNNER`):

```sh
cubed runners init-local --image /absolute/debian-13-genericcloud-<arch>.qcow2 \
  [--home ~/.cube] [--listen 127.0.0.1:7778] [--node-id node-local-<host>] \
  [--qemu PATH] [--firmware PATH] [--max-vcpus N] [--max-memory-mib N] [--max-disk-gib N] \
  [--state ~/.cube-host]
```

It creates a control key at `<home>/control.key`, runs `cube-runner init
--home <home>/runner` (its own key, the base image copied in, loopback at
`--listen`, the limits), writes the version-2 config `<home>/runner.json`
(mode 0600, binding `node-local-<host>` / the same thread id / environment 1),
then runs the runner once to make the authenticated hello and record the
admission in the registry, and stops it as its first Ctrl-C would. The runner is
then started by its service (`brew services start cube-runner` under Homebrew,
whose service assumes the default `--home ~/.cube`; the LaunchAgent or systemd
profile elsewhere) or by `cube-runner run --home <home>/runner`. Start the
service after `init-local`, not before: a service that already runs the home
takes its lock and port, and `init-local` then enrolls whichever runner
answers with the key. An existing `<home>/runner`, control key or config is refused:
a runner is never rebound. If the runner cannot start on this host (no
accelerator, QEMU missing), the command leaves the setup in place, prints why,
and exits 1 with the enrollment to run once it is up:

```sh
cubed runners enroll --config ~/.cube/runner.json [--state ~/.cube-host]
```

`runners enroll` is the same explicit admission as `scripts/enroll-runner.ts`
(which now delegates to it): a hello and a status exchange, a refusal of a
protocol-2 runner and of a control key another enrolled runner uses, then the
registry row. Both commands also work through the managed launcher
(`~/.local/bin/cubed`), which runs subcommands unsupervised.

The local runner runs as the user who starts it: on the one-machine setup the
runner account is the operator's own, and the trust statement above applies to
it (a QEMU escape has that user's authority; the runner reads every machine
disk it hosts). The same-host loopback setup on macOS is unverified on real
hardware this round; macOS runners have been verified in production as remote
(relay) runners.

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
is failed or releasing. A new thread goes to a runner that answered ready in
the last two minutes first, then to one cubed has not heard from lately, then
to one that failed lately; among those, to the lowest share of used slots,
runners with a failed machine last. The count and the new thread are one
`BEGIN IMMEDIATE` registry transaction.

Before cubed sends anything for a new thread's machine it asks a runner it has
no fresh answer from for its status. If the runner does not answer, is
draining, faulted or waiting for recovery, or refuses the machine (a lowered
bound, the disk floor, a VM cubed does not know), a thread whose agent and
workspace have not opened yet moves to another runner with a free slot and
starts there, without showing the first runner's error. Once an allocation may
have reached a runner (its answer lost, cubed restarted), the thread stays
with that runner until it answers: the machine it made is used, never a second
one elsewhere. A thread whose machine was allocated never moves. With no
runner to take it, the thread waits, holding its slot; it shows as starting,
and the API's `waiting` field and OptChat give the reason ("waiting for a
runner: …"); cubed's recovery loop tries again every 30
seconds and asks a runner that failed again after 5 seconds, doubling to at
most a minute. Archiving a thread that never got a machine needs no runner.
Runners before 0.7.0 report 1 and keep one thread at a time, exactly as
before.

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

## Observing runners

`GET /api/runners/observed` (the operator's API, behind the same network
access control as the rest of cubed) and OptChat's `runners` tool show each
runner as cubed last heard from it. Both are read-only and contact no runner.
The background probe (`node.status` every minute) keeps them current, and
`POST /api/runners/<id>/check` probes one runner now. Per runner:

- `contact`: `reachable`, `unreachable`, `stale` (unreachable for 7 days) or
  `unknown` (never probed), the last attempt, the last answer and the last error.
- `report`: the last successful status report, kept when later probes fail.
  `fresh` is true only if the latest probe returned it and it is younger than
  three probe intervals; otherwise it is the last known state, not the current
  one. The report holds the runner's own `softwareVersion` and
  `protocolVersion`, its `lifecycle` (`ready`, `draining`, `faulted`,
  `recoveryRequired`) and `draining`, the machines it hosts now (`activeVms`,
  `runningVms`), its effective bound `maxActiveVms`, and its retained disks.
  It also holds `platform` (`linux-x86_64`, `macos-aarch64`) with `os`, `arch`
  and the `accelerator` the runner checks before it serves (KVM or HVF), its
  `capabilities`, and the largest machine it accepts (`vmLimits`).
- `slots`: cubed's admission count. `reserved` counts the open threads, each
  of which holds a slot until it is archived. `total` is the runner's last
  advertised bound (`totalSource: reported`), or 1 when it never advertised one
  (`assumed`). `free` is 0 while the runner is retiring.
- `unknown`: what this runner's data does not say, for example a stale report.

The version shown is the one the runner itself reported. Nothing is inferred
from a published release: a runner with an active VM postpones its update. A
full runner does not show a lower bound either: two threads on a runner with
`maxActiveVms` 2 is a full runner, not a missing feature.

The platform, capabilities and limits come from the `node.hello` that starts
every status exchange. Every protocol 3 runner sends them, so they appear after
the first probe by a cubed with this change, without a runner update. A report
recorded by an older cubed lists them as unknown until the next probe.
Protocol 3 does not report the following, so they are always unknown:

- whether `--max-active-vms` is `auto` or an explicit number (only the
  effective bound);
- the self-updater's state (its last run, what it found, a pending upgrade);
- nested virtualization: whether the runner host is itself a VM, and whether
  thread machines get KVM or HVF.

Adding any of these to `node.status` would break cubed releases that refuse
unknown status fields, so they stay out of the protocol until cubed accepts
optional fields first.

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
| `/var/lib/cube-runner/state/vms/<n>/` | cube-runner, 0700 | `disk.qcow2`, `seed.img`, `console.log`, `qemu.log`, `launch.json` and `events.log` (0.8.3+), QMP and frame sockets |
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
Each start moves the previous console to `console.prev.log`. Before GRUB, the
edk2 build Homebrew QEMU ships prints `ArmTrngLib could not be correctly
initialized`, `Image at ... start failed` and `Tpm2...` lines on a healthy boot;
they are noise. Until the NIC was given an empty `romfile=`, macOS runners also
printed `Image type X64 can't be loaded on AARCH64 UEFI system`: that was QEMU's
x86 option ROM for the NIC, not the base image or the disk.

## Machine templates

cube-runner 0.8.0 keeps machine templates under `state/templates/<id>/disk.qcow2`
(read-only, mode 0400): the prepared disk of a project's build machine, which
new thread machines of that project use as the backing of their own overlay.
cubed builds one per project and runner when a project has none (see
ARCHITECTURE.md), keeps the newest and asks the runner to remove expired and
superseded ones; the runner deletes a template's directory only when no VM
that is not released depends on it, so a retained VM keeps its template until
it is discarded. A template is about the size of what the project's setup
installs (for cube: toolchains and dependencies, 1-3 GB). The free-disk floor
for new VMs (`CUBE_RUNNER_MIN_FREE_DISK_GIB`) also guards templates, because
building one first allocates a VM. Backups include `templates/`. Rolling back to
0.7.0 is possible: it ignores the template records, and machines already on a
template keep booting, but it never deletes a template; remove
`state/templates/<id>` by hand only when `sqlite3 journal.db "SELECT vm_id FROM vm
WHERE template='<id>' AND state<>'released'"` prints nothing. Rolling cubed back
below the templates release while machines on templates exist is not
supported: an older cubed refuses the `template` field in their records;
archive (and discard) those threads first, or roll back cubed and runner
together with `CUBED_TEMPLATES=off` set beforehand long enough for them to be
gone.

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

On macOS an upgrade never boots the update job out from inside its own run:
launchd kills every process of a job it boots out. A loaded job whose plist
did not change is left alone; a changed plist is reloaded only from outside
the job. Bundles up to cube-runner 0.8.1 rebooted it from inside and could
leave it unloaded (`launchctl print gui/$(id -u)/com.cubeyard.cube-runner-update`
reports no such service). Load it again, without sudo, with `launchctl
bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cubeyard.cube-runner-update.plist`.

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

## Diagnosing a machine that does not start

When a thread stays "starting" or its agent never opens, collect its
diagnostics bundle before changing anything. On the cubed host (or through the
authenticated proxy that fronts cubed), with the thread's id from its URL:

```sh
curl -fsS "http://127.0.0.1:7777/api/threads/<thread-id>/diagnostics" -o cube-diagnostics-<thread-id>.json
```

Attach that file when you share the problem. It is read only: it starts,
stops, attaches and moves nothing (not even the gateway: a gateway that is
not running is reported as such), and works for archived threads too. It
takes about 20 s at most: up to 8 s for the runner (its requests queue
behind the runner's other calls) beside up to 3 s for the gateway, then up
to 8 s for one guest hello. Requests for the same thread at the same time
share one diagnosis. OptChat
gives the same evidence as text for a thread it started (its `diagnose` tool:
ask it to diagnose the thread).

What the bundle holds, each part either observed (with its time) or marked
`none`, `unavailable` or `unsupported` with the reason:

- `thread`, `activation`: cubed's record (workspace state and error, runner,
  machine id, placement, preparation, startup phases, hooks) and whether a
  start is under way, waits for a runner or failed.
- `runnerObservation`: cubed's last `node.status` report of the runner, with
  its age; `fresh: false` means it is old, not the runner's current state.
- `machine.events`: cubed's machine events for the thread (start sent and
  answered, gateway attached, each different "guest not ready" answer, moves,
  waits, failures), kept in `CUBED_STATE/threads/<id>/machine-events.jsonl`
  from this version on; `null` means none were recorded, not that nothing
  happened.
- `machine.runner`: the runner's `vm.diagnose` (cube-runner 0.8.3+): its VM
  record, the QEMU command line it recorded at launch (`launch.source:
  recorded`; `reconstructed` when an older runner started the machine), disk
  overlay, backing file and template, the QEMU process (pid, alive, CPU ms,
  resident memory), QMP's `query-status` and `query-cpus-fast` (a running
machine only, and only while the runner itself is not using QMP, which
serves one client at a time; otherwise `asked: false` says why), the frame
  pump (gateway connected, frames from and to the guest; zero frames from the
  guest means its kernel never brought the NIC up), the first 8 KiB and last
  56 KiB of the console, the tail of the previous boot's console and of
  `qemu.log`, and the runner's event log for the VM (`vms/<n>/events.log`:
  allocated, qemu started, running, gateway connected/refused/disconnected,
  first frame from the guest, start while live, start refused while
  draining, power-down, quit, kill, exit, runner restarts). A runner before
  0.8.3 answers `method: vm.inspect` only: its record and the last 16 KiB of
  the console.
- `machine.gateway`, `machine.guest`: the gateway's link, lease, guest IP and
  byte counts (when a gateway runs), and one bounded guest hello over SSH
  (only when the gateway has the machine attached).

Every string is escaped (control characters as `\x1b`, invisible or
reordering characters as `\u{202e}`, invalid UTF-8 as `\xff`; backslashes are
kept, so escapes are not reversible) and secret-looking values (private keys,
GitHub and Anthropic tokens, bearer tokens, `password=`/`token:` values) are
`[redacted]`. A private key is redacted whole when an excerpt starts or ends
inside it, and so are bare key-like base64 lines (60+ characters of mixed
case and digits) whose BEGIN and END lines were both cut off. The file is
safe to print in a terminal. Redaction is by pattern: read the bundle before
sharing it outside the operators. A guest is root in its own machine and can
print anything to its console, encoded so no pattern matches. A thread's
bundle never includes another thread's machine: the runner refuses a VM of
another thread (`CONFLICT`), and OptChat diagnoses only threads it started.

A runner before 0.8.3 that cubed cannot reach leaves only the runner host's
own files. On a macOS runner with the user profile, read them without
printing raw bytes (`cat -v` shows control characters as `^[`):

```sh
S="$HOME/Library/Application Support/CubeRunner/data/state"
sqlite3 -readonly "$S/journal.db" "SELECT slot,state,interrupted,error,started_at,template FROM vm WHERE vm_id='<vm-id>'" | cat -v
n=<slot>; ls -la "$S/vms/$n"
tail -c 65536 "$S/vms/$n/console.log" | cat -v
tail -c 16384 "$S/vms/$n/qemu.log" | cat -v
pgrep -f "guest=<vm-id>"    # QEMU's pid, if it runs
ps -o pid,etime,time,rss,stat -p <pid>
```

`time` is QEMU's CPU time: two readings a minute apart tell a spinning guest
from an idle one. None of these change the VM, its disk or the journal.

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
| `error` on a stopped VM | QEMU exited unexpectedly; see the thread's diagnostics bundle (above), or `vms/<n>/qemu.log` and `console.log` |
| `WRONG_NODE` | verify Iroh peers and the full immutable binding out of band |
| `faulted` / `IO_ERROR` | stop, preserve state, inspect disk/journal ownership |

## Production acceptance

`scripts/test-node-transport.sh` runs the runner acceptance with a real guest
when `/dev/kvm`, QEMU and `CUBE_TEST_VM_IMAGE` are present (and skips loudly
otherwise; `CUBE_TEST_VM=required` makes that a failure). Release sign-off also
needs the service profile over N0 relay: install, enrollment, a real thread,
drain and stop, upgrade with induced rollback, runner loss, backup/restore
quarantine and re-enrollment, on each platform separately.
