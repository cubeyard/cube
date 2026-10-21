# Runner operations

This is the operations boundary for Cube **runners**. A runner hosts a
thread's machine; it runs no command of its own for a thread. cubed speaks
runner protocol 4 (`cubeyard/runner/4`, [runner.proto](../packages/runner-protocol/proto/runner.proto))
to two kinds of runner, both [berth](../packages/berth/README.md):

| Runner | Machines | Placement |
|---|---|---|
| `berth vm` | keel machines under QEMU (KVM on Linux, HVF on macOS), one per open thread up to `--max-machines` | the global pool: a thread that names no runner goes to one |
| `berth host` | directories on that host, **unsandboxed**, for developing runners only | only threads started on it by name; never in the pool, never a fallback |

Runners that were enrolled with protocol 3 (`cube-runner`) are retired: see
[protocol-3 runners](#protocol-3-runners-retired). Each runner has its own
directory, key and enrollment; Iroh (N0 discovery and relay, or a direct
address) carries the connection, and Iroh authenticates the pinned peer ids
and encrypts QUIC end to end. N0 operators can observe endpoint IPs and
traffic metadata.

## Trust and security model

On a `berth vm` the guest is the thread's sandbox. A thread's commands run as
user `agent` inside its keel machine; they cannot see the runner account, its
key or its journal. The machine's only network is its own LAN inside berth
(cube-netstack): DNS, TCP to ports 80 and 443 only, HTTP and HTTPS
intercepted with the runner's own CA, and every request checked against the
egress policy cubed sends with each start (public addresses only). A request
a credential rule matches goes over a `credential` stream to cubed and on to
`cube-gateway`, the only process that holds the GitHub token; the guest and
the runner see only placeholders.

QEMU runs **as the runner account**, hardened only by `-sandbox on` on Linux
(no `-sandbox` on macOS). A guest escape through a QEMU bug has the runner
account's authority. Give that account no control-plane, provider, GitHub,
SSH, cloud or login credentials, no sudo and no privileged groups other than
`kvm`. Do not call the runner host as a whole a sandbox. The runner account
can read every machine disk it hosts, retained ones too.

A `berth host` runs a thread's commands as the user who started it, in a
subdirectory of its `--dir`, with that user's files and gh/git logins. It is
not a sandbox and gets none of cubed's secrets, proxy or egress policy.

## Local runner

A `berth vm` on the cubed host itself, reached over loopback, is set up and
enrolled by one cubed command, which can be run again at any time:

```sh
cubed runners init-local --image <registry/repository@sha256:…> \
  [--home ~/.cube] [--listen 127.0.0.1:7779] [--node-id node-berth-<host>] [--max-machines 2] \
  [--berth PATH] [--keel DIR] [--qemu PATH] [--qemu-img PATH] [--mkfs-erofs PATH] [--state ~/.cube-host]
```

The programs and keel come from the options, else from `CUBE_BERTH`,
`CUBE_BERTH_KEEL`, `CUBE_BERTH_QEMU`, `CUBE_BERTH_QEMU_IMG` and
`CUBE_BERTH_MKFS_EROFS` (Homebrew's `cubed` launcher sets them to the
`cube-berth`, `qemu` and `erofs-utils` formulas' files), else from `PATH`;
keel has no default. Everything goes under `<home>`:

| File | What |
|---|---|
| `berth/` | berth's `--dir`: its key, journal, machine disks, layer cache |
| `berth.control.key` | cubed's control key for it (`berth keygen`, 0600) |
| `berth.env` | `CUBE_BERTH_IMAGE`, `CUBE_BERTH_MAX_MACHINES` and `CUBE_BERTH_LISTEN`, what the service starts it with (0600) |
| `berth.json` | the version-2 protocol-4 config cubed reads (0600; binding `node-berth-<host>`, the same id, environment 1) |

It creates only what is missing, in this order: a check that the listen
address's UDP port can be bound (before anything is written; it cannot rule
out the port being taken later), the control key, berth's own first run
(which binds the directory to that key and the node id in
`berth/.berth/vm.json`, pulls the image before it listens and prints its
peer), then, once berth listens, `berth.env` and `berth.json`,
and it enrolls the runner with an authenticated hello
while that berth runs, then stops it with SIGTERM. What is already there must
agree (image, slots, node id, address, control key, berth's binding); a
disagreement is refused and nothing changes. Nothing is ever overwritten,
deleted or rebound. So:

- **Run again with everything in place and enrolled in this state:** it says
  `already set up and enrolled`, starts nothing and changes nothing. This is
  what happens after `brew uninstall` and `brew install`, which keep `~/.cube`
  and `~/.cube-host`.
- **After a failed run** (no accelerator, an image pull that failed, a
  digest that does not exist, a port taken while berth pulled): run it again; it continues with the key and
  berth's binding it made. Until berth has listened once nothing of cubed's
  records the image, the slots or the listen address, so that run may give a
  corrected `--image`, `--max-machines` or `--listen` (berth's `vm.json`
  keeps the address it tried, but berth takes another `--listen` on any
  start, and the service passes `berth.env`'s); the node id is berth's
  binding and stays.
  The service does not start berth before `berth.json` is there. If a berth
  already holds the directory without one, `init-local` says to stop it
  first.
- **With a moved or new `--state`:** it enrolls the same runner there (the
  same key and peer).
- **A retired runner** is not admitted again.
- **`--image` is needed only the first time.** The image is the operator's
  choice; cube publishes no default image yet.

The runner is then started by its service (`brew services restart
cubeyard/tap/cube-berth` under Homebrew, whose service assumes the default
`--home ~/.cube`). If the service already holds the directory, `init-local`
enrolls whichever berth answers with the key. If berth cannot start here, the
command keeps what it made, prints why and exits 1. A protocol-3 local
runner's `runner/`, `runner.json` and `control.key` under the same home are
never read or touched (see [protocol-3 runners](#protocol-3-runners-retired)).

`runners enroll` is the same explicit admission as `scripts/enroll-runner.ts`
(which delegates to it): a config with `"protocol": 4` (any other is refused:
protocol-3 runners are no longer admitted), a refusal of a control key
another enrolled runner uses, an authenticated hello, then the registry
row. Both commands also work through the managed launcher
(`~/.local/bin/cubed`), which runs subcommands unsupervised.

```sh
cubed runners enroll --config ~/.cube/berth.json [--state ~/.cube-host]
```

The local runner runs as the user who starts it: on the one-machine setup the
runner account is the operator's own, and the trust statement above applies to
it (a QEMU escape has that user's authority, and macOS QEMU has no
`-sandbox`; the runner reads every machine disk it hosts).

## Thread machines per runner

A `berth vm` hosts up to `--max-machines` machines at once (default 8; the
local runner's default is 2) and reports the bound in its hello
(`limits.max_machines`). cubed records it at enrollment, at every runner
check and at every machine start, and counts its open threads against it: a
thread holds a slot on its runner from creation until its archive finishes,
also while its machine is failed or releasing; a suspended machine holds
none. A new thread goes to a pool runner that answered ready in the last two
minutes first, then to one cubed has not heard from lately, then to one that
failed lately; among those, to the lowest share of used slots, runners with
a failed machine last. The count and the new thread are one `BEGIN
IMMEDIATE` registry transaction.

A thread never moves to another runner. Its runner down, it waits, holding
its slot; it shows as starting, and the API's `waiting` field and OptChat
give the reason ("waiting for runner …"); cubed's recovery loop tries again
every 30 seconds. Archiving a thread that never got a machine needs no
runner.

## berth vm (runner protocol 4)

`berth vm` is the protocol-4 VM runner: keel machines under QEMU
([berth](../packages/berth/README.md)). It has its own directory and key.

- **Install from a release.** Verify the downloaded release from a checkout
  of its tag, never with a script from inside the bundle:
  `node scripts/berth/verify-release.ts <release directory>`. Then run the
  bundle's `share/berth/install-berth.sh`, every path absolute. Before it
  writes anything it runs that berth as far as its banner in a throwaway
  directory under `/tmp`: QEMU must meet keel's floor, the accelerator must
  be KVM (Linux) or HVF (macOS), and berth must report the keel files'
  hashes. It never overwrites a file, never starts, loads or enables a unit,
  and never enrolls. The flags and the next commands are in berth's
  [Install from a release](../packages/berth/README.md#install-from-a-release).
- **Enroll** it from the cubed host with a version-2 config that says
  `"protocol": 4`: `cubed runners enroll --config <runner.json>`, as above.
- **It is in the pool.** A thread that names no runner may be placed on an
  enrolled `berth vm` (never on a `berth host`). A thread on a `berth vm`
  stays there and waits while the runner is down (above).
- **Upgrade.** Install the new release with the same `--dir`: the same peer
  and key, so no new enrollment. Point the start script at the new
  `libexec/berth-<version>/berth` (or install with a new `--unit-name`), and
  restart the unit when none of its threads has a running turn. The runner
  quits its machines' QEMUs when it stops and never starts a machine by
  itself; cubed starts a thread's machine again when the thread next needs
  it, on the same writable disk.
- **Roll back** the same way: point the start script back at the previous
  `libexec/berth-<version>/berth`, which the installer never removes or
  replaces, and restart. A berth from before suspend cannot read a machine
  record that holds a snapshot or a dropped-snapshot note, and then does not
  start at all: roll back only with no machine suspended (stop or archive
  those threads first). A cubed from before suspend counts suspended
  threads as holding slots and starts them again through its recovery loop.
- **Suspend** (phase 7) is off unless `berth vm` starts with
  `--suspend-disk-margin-gib <GiB>`, which has no default: it is the free
  disk a runner keeps besides a machine's memory file (at least 1 GiB; the
  file can be a little larger than the machine's memory). Only then does
  the runner say `machine.suspend`, and cubed suspends a thread's machine
  after 5 minutes in which nothing ran: no turn of its agent or its
  background agents, no guest call, no command started and not yet seen to
  end, no portal connection, and no service registered with `cube service`
  (until it is decided whether such a machine may sleep). After cubed itself
  restarts, a machine it finds running waits 32 minutes first: commands from
  before may still run. One machine per runner is suspended at a time. A
  suspended machine holds no slot. Anything
  the thread needs wakes it (a message, a command, the portal); with the
  runner full the thread waits, saying so (`waiting for a free slot`). The
  runner keeps a machine running when its disk is short or the save fails.
  After an upgrade a snapshot no longer fits, and the machine starts from
  its disk with the notice `restarted after an update; running commands
  were interrupted`; the next resume clears it. A suspend holds the
  runner's other machine operations for up to 85 s (it waits at most 5 s for
  them, saves for at most 60 s and undoes or quits for at most 15 s, then
  kills QEMU: the machine is stopped, its disk kept); a thread that starts
  meanwhile says only that it starts. A thread waiting for a free slot gets
  none ahead of a new thread, and archiving a suspended thread on a full
  runner waits for a slot (up to 30 minutes).
- **Retire** it as any runner: archive its threads, then `POST
  /api/runners/<id>/retire` with `confirm` set to its node id and a
  `reason` (at most 500 characters). cubed refuses while it has an open thread on the
  runner or the runner reports an active machine; an unreachable runner must
  be stale (unreachable for 7 days) first. Then stop and remove its unit
  yourself.
- **Limits.** berth keeps each machine's sockets at `<dir>/<16-hex machine
  id>/qmp.sock` and refuses a `--dir` for which that path exceeds 100 bytes
  (macOS allows 104); the installer checks it on the resolved path. The
  Linux release binary is built on GitHub's `ubuntu-latest` (Ubuntu 24.04
  today), so it needs glibc 2.39 or newer.

## Observing runners

`GET /api/runners/observed` (the operator's API, behind the same network
access control as the rest of cubed) and OptChat's `runners` tool show each
runner as cubed last heard from it. Both are read-only and contact no runner.
The background probe (a hello every minute) keeps them current, and
`POST /api/runners/<id>/check` probes one runner now. A protocol-3 runner is
never probed. Per runner:

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
- `protocol`: 4 (`berth`), or 3 for a retired `cube-runner`, as enrolled;
  with `kind` and `byName`, whether the runner is in the pool (a `berth vm`)
  or takes only threads started on it by name (`berth host`). A protocol-3
  runner takes none.

Beside the runners, `capacity` sums the slots of the runners that take
threads: `p4.vm` (the pool) and `p4.host`; `p3` only counts the protocol-3
runners still enrolled and their threads that are not archived. Each group lists in `stale`
the runners counted with their last, stale report, and in `unreported` those
that never answered, whose bound is from enrollment or assumed. A slot is an
open thread in cubed, not a machine the runner hosts (`report.activeVms`). The
project page shows these per runner and above the runner list.

The version shown is the one the runner itself reported; nothing is inferred
from a published release. The runner protocol does not report whether a
runner host is itself a virtual machine, or the runner's own update state,
so they are always unknown.

## Diagnosing a machine that does not start

When a thread stays "starting" or its agent never opens, collect its
diagnostics bundle before changing anything. On the cubed host (or through the
authenticated proxy that fronts cubed), with the thread's id from its URL:

```sh
curl -fsS "http://127.0.0.1:7777/api/threads/<thread-id>/diagnostics" -o cube-diagnostics-<thread-id>.json
```

Attach that file when you share the problem. It is read only: it starts,
stops, attaches and moves nothing, and works for archived threads too. A
thread on a protocol-3 runner gets cubed's own record only (`machine:
unsupported`, with the reason). OptChat
gives the same evidence as text for a thread it started (its `diagnose` tool:
ask it to diagnose the thread).

What the bundle holds, each part either observed (with its time) or marked
`none`, `unavailable` or `unsupported` with the reason:

- `thread`, `activation`: cubed's record (workspace state and error, runner,
  machine id, placement, preparation, startup phases, hooks) and whether a
  start is under way, waits for a runner or failed.
- `runnerObservation`: cubed's last status report of the runner, with
  its age; `fresh: false` means it is old, not the runner's current state.
- `machine.events`: cubed's machine events for the thread (start sent and
  answered, each different "guest not ready" answer, waits, failures), kept in `CUBED_STATE/threads/<id>/machine-events.jsonl`
  from this version on; `null` means none were recorded, not that nothing
  happened.
- `machine.runner`: berth vm's `machine_diagnose` (the machine's record,
  QEMU's version, machine type, pid, argv and `qemu.log` tail, QMP's
  `query-status`, the console's tail, the runner's event lines, the agent's
  last `GuestInfo`, the newest start's egress policy, lease and refusals,
  the runner's disk, cache and templates, Iroh's paths to cubed; see
  [berth](../packages/berth/README.md)). A `berth host` has none.
- `machine.guest`: what the runner last reported of the machine's guest
  (ready or not and why, the keel agent's version, build, kernel, boot and
  hooks).

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
bundle never includes another thread's machine: the runner refuses another owner's
machine (`NOT_FOUND`), and OptChat diagnoses only threads it started.

## Protocol-3 runners (retired)

`cube-runner` (runner protocol 3: Debian VMs, cloud-init seeds, SSH through
cube-gateway's LAN) is no longer part of cube. Its code, packaging and
updater were removed after v0.3.32; the last tree with them, including
`scripts/runner/` (status, drain, backup, restore, uninstall), is the
`v0.3.32` tag. An installed cube-runner keeps the copies of those scripts
its package installed.

What cubed does with a runner enrolled with protocol 3 (its registry row
has no `"protocol": 4`):

| | |
|---|---|
| Row and last report | kept and listed (`protocol: 3`, "no longer supported"); never probed, checked or contacted |
| Placement | never: not in the pool, and a thread started on it by name is refused |
| Its threads | history stays readable; a machine start is refused with the reason; an archive contacts nothing and records the disk as kept when the machine had been allocated |
| Retained disks | stay on that runner's host; cubed cannot discard them (`POST …/discard` is refused) |
| Retirement | `POST /api/runners/<id>/retire` once its threads are archived, without a check (it cannot be contacted) |

Nothing in cubed's state is deleted or migrated.

What is left is the operator's, on each protocol-3 host, and changes nothing
in cubed:

1. Stop and disable the runner and its hourly updater, if not done yet: on
   Linux `systemctl disable --now cube-runner.service
   cube-runner-update.timer`; on macOS `launchctl bootout` the
   `com.cubeyard.cube-runner` and `com.cubeyard.cube-runner-update` jobs,
   or `brew services stop cubeyard/tap/cube-runner`. Releases after v0.3.32
   publish no `cube-runner-<platform>.json`, so an updater left on fails
   with a 404 every hour and changes nothing.
2. Decide each retained disk (`<state>/vms/<n>/disk.qcow2`; `qemu-img info`
   reads one without changing it). They belong to archived threads; keep
   them as evidence until their work is known to be pushed or no longer
   needed, then delete them by hand.
3. Retire the registration in cubed (above), then remove the package
   (`uninstall.sh --keep-state` from the installed copy, or `brew uninstall
   cubeyard/tap/cube-runner`; the tap keeps that formula so this works).
   Keep the state directory until you have decided about its disks.

## Production acceptance

`scripts/test-node-transport.sh` runs the runner tests: always the real
`berth host` with cubed and the real cube-gateway; with KVM or HVF and the
`CUBE_TEST_BERTH_*` paths also `berth vm` with keel machines, cubed on it,
suspend, and `init-local` (skipped loudly otherwise;
`CUBE_TEST_BERTH_VM=required` makes that a failure; DEVELOPING.md). A
release also needs the native gates on a Linux/KVM and a macOS/HVF host.
