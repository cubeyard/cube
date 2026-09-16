# Trusted runner production operations

This is the production boundary for Cube **trusted runners**: Linux x86-64 with
systemd, one immutable thread/environment binding per runner installation, and
Iroh's public N0 discovery/relay transport. A trusted runner is not an Incus or
VM execution node and is not a general scheduler.

## Trust and security model

The runner is trusted and **not sandboxed**. Agent commands run as the dedicated
`cube-runner` Unix user and can read, change, execute, or delete anything that
user can access. Give that account no control-plane, provider, GitHub, SSH,
cloud credentials, sudo, or privileged groups. Systemd write restrictions are
host hygiene, not an adversarial same-UID filesystem boundary.

Iroh authenticates the pinned peer IDs and encrypts QUIC end to end. `peerId` is
transport identity; persisted `nodeId` is Cube's logical execution-node identity.
N0 operators can observe endpoint IPs and traffic metadata. Cube does not enforce
runner egress; enforce it at the OS/network boundary. Relay mode requires no
inbound public listener.

## Build, fresh install, and enrollment

```sh
bash .cube/setup
bash scripts/runner/package.sh /absolute/private-output/cube-runner.tar.gz
sha256sum -c /absolute/private-output/cube-runner.tar.gz.sha256
tar -xzf cube-runner.tar.gz
cd cube-runner
sudo bash scripts/runner/install.sh "$PWD/bin/cube-runner"
sudo bash scripts/runner/initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID
```

Transfer the archive and checksum over an authenticated operator channel.
`initialize.sh` prints only the public Iroh peer ID. Create the private adapter
config from [RUNNER.md](../packages/node-transport/RUNNER.md), stop cubed, then:

```sh
node scripts/enroll-runner.ts \
  --database /absolute/cubed.db \
  --project EXISTING_PROJECT_ID \
  --config /absolute/private-runner.json \
  --cubes-root /absolute/cubes \
  --trusted-runner --server-stopped
```

Enrollment authenticates the full binding and pins the config hash. It never
executes work. Existing IDs cannot be adopted or rebound.

Fresh layout:

| Path | Owner/mode | Purpose |
|---|---|---|
| `/opt/cube-runner/releases/<version>` | root, 0755 | immutable daemon release |
| `/opt/cube-runner/current` | root symlink | atomically selected release |
| `/etc/systemd/system/cube-runner.service` | root, 0644 | service boundary |
| `/var/lib/cube-runner/identity/node.key` | cube-runner, 0600 | Iroh identity secret |
| `/var/lib/cube-runner/state/` | cube-runner, 0700 | immutable binding and SQLite journal |
| `/var/lib/cube-runner/workspace/` | cube-runner, 0700 | trusted job workspace |
| `/run/cube-runner/ready.json` | runtime only | bounded readiness/version state |

## Status, drain, and stop

```sh
sudo systemctl start cube-runner
sudo bash scripts/runner/status.sh
sudo bash scripts/runner/drain.sh
sudo systemctl restart cube-runner
journalctl -u cube-runner --since today --no-pager
```

Drain is local operator authority. New operation IDs fail with `DRAINING`;
existing IDs remain inspectable. The default stop policy waits for the one
active job's bounded deadline and process-group reap. For incident cancellation,
install a root-owned drop-in with `Environment=CUBE_RUNNER_STOP_POLICY=cancel`.
Cancellation persists `CANCELLED`; hard process/machine loss instead persists
unfinished work as `Interrupted { completionUnknown: true }` on startup. Neither
case replays a command.

## Upgrade from cube-host 0.1.1

Do not copy, rename, chown, reinitialize, or regenerate legacy state. From the
new bundle run:

```sh
sudo bash scripts/runner/upgrade.sh "$PWD/bin/cube-runner"
```

The phase-1 migration:

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

Native runner upgrades use the same `upgrade.sh`: stage immutable release,
confirm drain, switch `current`, require matching readiness, and restore the
previous target on failure. Never initialize over a failed state directory.

## Backup, restore, no-replay, and clean uninstall

```sh
sudo bash scripts/runner/backup.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/restore.sh /secure/runner-DATE.tar.gz
sudo bash scripts/runner/acknowledge-recovery.sh --i-reviewed-unknown-operations
sudo systemctl start cube-runner
```

Backup auto-detects native or phase-1 legacy state and stores that path exactly.
Restore accepts either layout, never starts a service, and creates
`restore-quarantine`. Reconcile every operation accepted after the snapshot as
unknown. Never recreate an intent, remove a `.sent` marker, resubmit an old ID,
or repeat a side effect because restored state says `Unknown`. Only acknowledge
an identity-preserving recovery after that review.

Software-only uninstall is intentionally explicit and non-destructive:

```sh
sudo bash scripts/runner/uninstall.sh --keep-state
```

It removes the runner unit and `/opt/cube-runner`, but preserves durable state
and any legacy rollback unit. State destruction is outside this script and must
follow the operator's approved retention procedure.

## Replacement and re-enrollment

There is no in-place key, peer, node, thread, environment, or admission rotation.
If either side's key is lost without a matched backup, archive the old thread,
retain its journal/intents for result inspection, and enroll a fresh runner with
new identities. Copy workspace content only through an authenticated offline
operator process. Recreate only required task grants and run a harmless canary.
Never delete old evidence to make an ambiguous command retryable.

## Capacity and diagnostics

One operation runs at a time. Commands are capped at 8 KiB, cwd at 4 KiB,
runtime at 60 seconds, output at 8 KiB, connections at 16, and immutable journal
records at 10,000. Records do not expire because they are no-replay evidence.
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

Protocol v1 still accepts the wire profile `host`; new daemons advertise both
`runner` and `host`. Cubed accepts `/host-exec`, `CUBE_BACKEND=host`,
`CUBE_HOST_WORKSPACE`, `--trusted-host`, `host-init`, and `host-serve` as
deprecated aliases. SQLite tables `execution_node` and `host_node_admission`
remain unchanged for rollback. The packaged `cube-node-transport` name is a
symlink to `cube-runner`. Keep these aliases through the first stable release
after every supported installation has upgraded; remove them only with a
protocol/storage migration and a release-note removal date.

## Production acceptance

Release sign-off requires a separate Linux x86-64/systemd machine over N0 relay:
fresh install/enrollment, runner exec, directed T2T recipient execution, drain,
both stop policies, upgrade/induced rollback, daemon/control loss, matched
backup/restore quarantine, and replacement/re-enrollment. The 0.1.1 host baseline
was completed before this rename. Local migration and loopback/public-relay
smokes are regression evidence, not a new external sign-off.
