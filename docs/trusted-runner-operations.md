# Trusted runner production operations

This is the production boundary for Cube **trusted runners**. One installation
has one immutable thread/environment binding and uses Iroh's public N0
discovery/relay transport. A trusted runner executes under its account without
sandboxing and is not a general scheduler.

| Platform | Lifecycle | Support profile |
|---|---|---|
| Linux x86-64 | systemd system service, dedicated `cube-runner` account | production |
| macOS arm64/x86-64 | system LaunchDaemon, pre-created dedicated `_cube-runner` account | production |
| macOS arm64/x86-64 | per-user LaunchAgent | development/disposable; production only when the login account itself is dedicated and credential-free |

Packages are native to their manifest's OS and architecture; they are not
cross-platform binaries. Linux and macOS each require release acceptance.

## Trust and security model

The runner is trusted and **not sandboxed**. Agent commands run as the dedicated
runner account and can read, change, execute, or delete anything that user can
access. Give that account no control-plane, provider, GitHub, SSH, cloud or login
credentials, sudo, or privileged groups. Service-manager restrictions are host
hygiene, not an adversarial same-UID filesystem boundary.

Linux validates cwd with `openat2` using `RESOLVE_BENEATH`,
`RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_MAGICLINKS`. macOS instead walks every
relative path component from
the identity-checked workspace descriptor with
`openat(O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`; absolute paths, `..`, symlinked
components and replaced workspaces fail closed. This prevents cwd traversal and
canonicalize/open races. It does **not** confine arbitrary command filesystem
access: a command retains all authority of the runner UID.

Each job starts a new Unix process group. Timeout, explicit cancel and orderly
daemon stop signal and reap that group, including ordinary descendants. macOS
has no cgroup equivalent: a hostile command can deliberately escape with a new
session/process group, and an uncatchable daemon or machine crash cannot reap
descendants. Do not describe this as a complete hostile process-tree boundary.

Iroh authenticates the pinned peer IDs and encrypts QUIC end to end. `peerId` is
transport identity; persisted `nodeId` is Cube's logical execution-node identity.
N0 operators can observe endpoint IPs and traffic metadata. Cube does not enforce
runner egress; enforce it at the OS/network boundary. Relay mode requires no
inbound public listener.

## Build, fresh install, and enrollment

Linux production:

```sh
bash scripts/setup-dev.sh
bash scripts/runner/package.sh /absolute/private-output/cube-runner.tar.gz
cd /absolute/private-output
sha256sum -c cube-runner.tar.gz.sha256 # use: shasum -a 256 -c ... on macOS
tar -xzf cube-runner.tar.gz
cd cube-runner
sudo bash scripts/runner/install.sh "$PWD/bin/cube-runner"
sudo bash scripts/runner/initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID
```

macOS production uses the same package and scripts, but first provision a
hidden, passwordless, non-admin `_cube-runner` account and dedicated group with
no login credentials or inherited keychain data. Account creation is deliberately
outside the bundle and must follow local fleet policy. Then run as root with
`CUBE_RUNNER_MODE=system`; the installer creates
`/Library/LaunchDaemons/com.cubeyard.cube-runner.plist`, validates it with
`plutil`, and launchd drops execution to `_cube-runner`. Never pass credentials
from the interactive operator account to that account.

For a disposable rootless macOS test, omit `sudo` and set
`CUBE_RUNNER_MODE=user`; this installs a LaunchAgent under the current login
session. It deliberately has that user's full same-UID authority and is not the
preferred production profile.

Transfer the archive and checksum over an authenticated operator channel.
`initialize.sh` prints only the public Iroh peer ID. Create the private adapter
config from [RUNNER.md](../packages/node-transport/RUNNER.md), then:

```sh
node scripts/enroll-runner.ts \
  --state /absolute/host-state \
  --project EXISTING_PROJECT_ID \
  --config /absolute/private-runner.json \
  --trusted-runner
```

Enrollment authenticates the full binding and pins the config hash. It never
executes work. Existing IDs cannot be adopted or rebound. Prepare the workspace
before enrollment: host repository checks do not transfer files to a runner.
The next new thread for this project consumes this runner's binding. No restart
is needed after enrollment. The host state is the fresh `CUBED_STATE` layout;
old registries and sessions are not migrated.

Fresh Linux layout:

| Path | Owner/mode | Purpose |
|---|---|---|
| `/opt/cube-runner/releases/<version>` | root, 0755 | immutable daemon release |
| `/opt/cube-runner/current` | root symlink | atomically selected release |
| `/etc/systemd/system/cube-runner.service` | root, 0644 | service boundary |
| `/var/lib/cube-runner/identity/node.key` | cube-runner, 0600 | Iroh identity secret |
| `/var/lib/cube-runner/state/` | cube-runner, 0700 | immutable binding and SQLite journal |
| `/var/lib/cube-runner/workspace/` | cube-runner, 0700 | trusted job workspace |
| `/run/cube-runner/ready.json` | runtime only | bounded readiness/version state |

Fresh macOS system layout uses `/Library/Application Support/CubeRunner` for
root-owned immutable releases and `_cube-runner`-owned `data`, `logs`, and
runtime state. The plist is root-owned at
`/Library/LaunchDaemons/com.cubeyard.cube-runner.plist`. The user profile uses
`~/Library/Application Support/CubeRunner` and
`~/Library/LaunchAgents/com.cubeyard.cube-runner.plist`.

## Status, drain, and stop

```sh
sudo systemctl start cube-runner
sudo bash scripts/runner/status.sh
sudo bash scripts/runner/drain.sh
sudo systemctl restart cube-runner
journalctl -u cube-runner --since today --no-pager
```

On macOS use the lifecycle scripts for status and drain. `initialize.sh` and
`upgrade.sh` bootstrap the launchd job; `launchctl print
system/com.cubeyard.cube-runner` inspects the production daemon (use
`gui/$UID/...` for a rootless LaunchAgent). Structured events have bounded,
redacted fields; launchd stdout/stderr files live under the software root's
`logs/` directory and require the operator's normal log retention/rotation.

Drain is local operator authority. New operation IDs fail with `DRAINING`;
existing IDs remain inspectable. The default stop policy waits for the one
active job's bounded deadline and process-group reap. For incident cancellation,
install a root-owned Linux drop-in with
`Environment=CUBE_RUNNER_STOP_POLICY=cancel`, or regenerate the macOS plist with
`CUBE_RUNNER_STOP_POLICY=cancel` during install/upgrade.
Cancellation persists `CANCELLED`; hard process/machine loss instead persists
unfinished work as `Interrupted { completionUnknown: true }` on startup. Neither
case replays a command.

## Upgrade from cube-host 0.1.1

Do not copy, rename, chown, reinitialize, or regenerate legacy state. From the
new bundle run:

```sh
sudo bash scripts/runner/upgrade.sh "$PWD/bin/cube-runner"
```

This legacy migration applies only to Linux. The phase-1 migration:

1. detects `/opt/cube-host/current` and the existing `cube-host.service`;
2. drains and stops that service;
3. installs `cube-runner` under `/opt/cube-runner` and starts
   `cube-runner.service`;
4. deliberately keeps `/var/lib/cube-host`, its numeric owner, key, workspace,
   immutable installation row, and journal in place;
5. records `/etc/cube-runner/legacy-layout` and disables, but does not delete,
   the old unit.

This avoids an identity/journal reset and keeps rollback possible:

```sh
sudo bash scripts/runner/rollback-legacy.sh
```

Rollback stops the runner service and starts the untouched `cube-host.service`
against the same state. It does not convert new protocol or journal formats;
protocol v1 and journal schema v1 therefore remain frozen throughout this phase.
Remove the legacy layout only in a later explicit migration after `cube-host`
rollback support leaves the supported release window.

Native runner upgrades on both platforms use the same `upgrade.sh`: stage an
immutable native release, confirm drain, switch `current`, require matching
readiness, and restore the previous target and service definition on failure.
Never initialize over a failed state directory.

## Backup, restore, no-replay, and clean uninstall

```sh
sudo bash scripts/runner/backup.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/restore.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/acknowledge-recovery.sh --i-reviewed-unknown-operations
sudo systemctl start cube-runner
```

On macOS run the same scripts with the installation's `CUBE_RUNNER_MODE`; start
is intentionally withheld after restore until quarantine has been reviewed and
acknowledged. Archives contain the Iroh private key and durable journal; keep
the archive and adjacent checksum private and together. A macOS `data/` archive
cannot be restored as a Linux state layout, or vice versa.

Backup auto-detects native or phase-1 legacy state and stores that path exactly.
Restore accepts either layout, never starts a service, and creates
`restore-quarantine`. Reconcile every operation accepted after the snapshot as
unknown. Never recreate an intent, remove a `.sent` marker, resubmit an old ID,
or repeat a side effect because restored state says `Unknown`. Only acknowledge
an identity-preserving recovery after that review. On a replacement host,
install the runner software before acknowledgment; restore contains durable
state, not release binaries or service definitions.

Acknowledgment runs in the runner account and requires exclusive ownership of
the journal, the restored private key, a private quarantine marker, and the
same canonical workspace path. Archive extraction cannot preserve a directory
inode, so acknowledgment transactionally refreshes only the workspace device
and inode and reinstates the journal's immutable-installation trigger before it
removes quarantine. It cannot change the node/thread/environment binding,
runner or control peer, or workspace path. Outside this explicit offline
recovery boundary, replacing the workspace directory remains fail-closed.

Software-only uninstall is intentionally explicit and non-destructive:

```sh
sudo bash scripts/runner/uninstall.sh --keep-state
```

It removes the service definition and release software, but preserves durable
state and any Linux legacy rollback unit. State destruction is outside this
script and must follow the operator's approved retention procedure.

## Replacement and re-enrollment

There is no in-place key, peer, node, thread, environment, or admission rotation.
If either side's key is lost without a matched backup, archive the old thread,
retain its journal/intents for result inspection, and enroll a fresh runner with
new identities. Copy workspace content only through an authenticated offline
operator process. Run a harmless canary before accepting new work.
Never delete old evidence to make an ambiguous command retryable.

## Capacity and diagnostics

One operation runs at a time. Commands are capped at 8 KiB, cwd at 4 KiB,
runtime at 60 seconds, output at 8 KiB, connections at 16, and immutable journal
records at 10,000. Records do not expire because they are no-replay evidence.
These protocol limits are not CPU, memory, process-count, network, or disk
quotas. Apply host-level controls where required; macOS has no cgroup-equivalent
per-job resource boundary in this profile.
Logs use bounded runner events (`runner_starting`, `runner_ready`,
`runner_draining`, `runner_resume_refused`) and omit commands, output, keys,
addresses, IDs, and paths.

| State/error | Action |
|---|---|
| `DRAINING` | wait or explicitly resume/restart after maintenance |
| `CAPACITY_EXCEEDED` | wait for active work; replace before journal exhaustion |
| `INCOMPATIBLE_PROTOCOL` | upgrade the older cubed/cube-runner component |
| `recoveryRequired` | reconcile uncertainty, then acknowledge while stopped |
| `COMPLETION_UNKNOWN` / `Interrupted` | inspect the saved ID; never resubmit |
| `WRONG_NODE` | verify Iroh peers and the full immutable binding out of band |
| `faulted` / `IO_ERROR` | stop, preserve state, inspect disk/journal ownership |

## Compatibility window

Protocol v1 still accepts the wire profile `host`; native daemons advertise both
`runner` and `host`. Native runner CLI aliases and Linux package rollback remain
supported. The packaged `cube-node-transport` name is a symlink to `cube-runner`.
These are runner transport/package compatibility, not a second product backend.
Cubed has no backend selector, legacy execution routes or admission tables.
Its fresh registry and Pi sessions are not compatible with old host databases.

## Production acceptance

Release sign-off requires separate Linux x86-64/systemd and macOS production
profiles over N0 relay: fresh install/enrollment, product prompts and runner exec,
drain, cancellation/stop, upgrade/induced rollback,
daemon/control loss, matched backup/restore quarantine, and
replacement/re-enrollment. Rootless macOS LaunchAgent acceptance proves the
portable scripts and daemon but does not prove the dedicated-account
LaunchDaemon boundary. The 0.1.1 Linux host baseline was completed before this
rename. Loopback/public-relay smokes and one platform's acceptance are regression
evidence, not cross-platform sign-off.
