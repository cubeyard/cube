# Trusted host production operations

This is the production boundary for the current **trusted host** model. It is
deliberately not a general node orchestrator. The only supported execution-node
platform is Linux x86_64 with systemd, one immutable thread/environment binding
per daemon, and Iroh's public N0 discovery/relay transport. Incus and VM
execution nodes are outside this boundary.

## Trust and security model

The host account is trusted and **not sandboxed**. Agent commands run as the
dedicated `cube-host` Unix user and can read, change, execute, or delete anything
that user can access. The account must own no provider, GitHub, SSH, cloud, or
control-plane credentials. Do not add it to privileged groups or grant sudo.
Systemd denies writes outside `/var/lib/cube-host`, but this is host hygiene, not
an adversarial filesystem boundary.

Iroh authenticates the pinned node and control peer and encrypts QUIC end to end.
N0 operators can observe endpoint IPs and traffic metadata. The host needs
outbound DNS, UDP/HTTPS connectivity required by N0/Iroh, plus whatever egress
agent jobs legitimately require. Cube does not enforce per-job egress on a
trusted host: enforce allowlists, proxies, audit, and deny rules at the OS/network
boundary. No inbound public listener is required in the supported relay profile.

## Build and clean install

Build the installer on Linux x86_64 with the pinned Rust toolchain:

```sh
bash .cube/setup
bash scripts/host/package.sh /absolute/private-output/cube-host.tar.gz
sha256sum -c /absolute/private-output/cube-host.tar.gz.sha256
```

Transfer the archive and checksum over an authenticated operator channel. On a
fresh host, extract and install as root:

```sh
tar -xzf cube-host.tar.gz
cd cube-host
sudo bash scripts/host/install.sh "$PWD/bin/cube-node-transport"
sudo bash scripts/host/initialize.sh CONTROL_PEER NODE_ID THREAD_ID ENVIRONMENT_ID
```

`initialize.sh` prints only the public node peer. Record it through the secure
operator channel, create the private cubed adapter config described in
[`HOST.md`](../packages/node-transport/HOST.md#operator-enrollment-and-thread-tools),
then run `scripts/enroll-host-node.ts` while cubed is stopped. Enrollment checks
the authenticated full binding and pins the config hash before creating the
thread. It never sends a command.

Layout and required ownership:

| Path | Owner/mode | Purpose |
|---|---|---|
| `/opt/cube-host/releases/<version>` | root, 0755 | immutable release binary |
| `/opt/cube-host/current` | root symlink | atomically selected release |
| `/etc/systemd/system/cube-host.service` | root, 0644 | service boundary |
| `/var/lib/cube-host/identity/node.key` | cube-host, 0600 | node identity secret |
| `/var/lib/cube-host/state/` | cube-host, 0700 | immutable binding and SQLite journal |
| `/var/lib/cube-host/workspace/` | cube-host, 0700 | trusted job workspace |
| `/run/cube-host/ready.json` | runtime only | bounded public readiness/version state |

The installer refuses non-Linux/non-x86_64 platforms, root daemon execution,
symlinked binaries/keys, incompatible protocol metadata, and replacement of an
existing identity or state directory.

## Health and lifecycle

```sh
sudo systemctl start cube-host
sudo bash scripts/host/status.sh
sudo bash scripts/host/drain.sh
sudo systemctl stop cube-host
sudo systemctl restart cube-host
journalctl -u cube-host --since today --no-pager
```

Readiness is `lifecycle=ready` only after the journal, key, immutable binding,
workspace identity, Iroh endpoint, relay and protocol metadata are available.
`node.status` exposes only node/binding IDs, software/protocol versions,
`ready|draining|faulted|recoveryRequired`, active-work state, and journal
capacity plus a bounded `ENVIRONMENT_MISSING`/`IO_ERROR` cause. It never exposes
keys, commands, output, paths, or environment data.

Drain is local operator authority (`SIGUSR1`, normally `systemctl reload`). It is
confirmed in `ready.json`; new operation IDs fail with `DRAINING`, while existing
IDs and read-only result inspection still work. The default systemd stop policy
waits for the one active job's bounded 60-second deadline and process-group reap.
For an incident requiring cancellation, install a root-owned systemd drop-in:

```ini
[Service]
Environment=CUBE_HOST_STOP_POLICY=cancel
```

Then `daemon-reload` and restart during a maintenance window. Cancel policy sends
SIGKILL to the active process group, waits for the leader to be reaped, and saves
`CANCELLED` with `completionUnknown=false`. A hard daemon/host kill is different:
startup records unfinished work as `Interrupted { completionUnknown: true }` and
never signals a restored PID or replays the command. Detached descendants are not
contained; policy must forbid daemonization, or the OS must add a stronger cgroup
boundary.

## Upgrade and rollback

Verify the new bundle first, then:

```sh
sudo bash scripts/host/upgrade.sh "$PWD/bin/cube-node-transport"
```

The script validates software/protocol metadata, stages a root-owned immutable
release, confirms drain, stops with the configured wait/cancel policy, atomically
switches `current`, and requires matching readiness. If start/readiness fails it
atomically restores the previous target and verifies that release. It never edits
the journal, workspace, key, or binding. If both starts fail, leave the service
stopped and inspect journald; do not initialize new state over the old directory.

Wire protocol 1 advertises both current and minimum compatible protocol versions
and required capabilities in the authenticated hello. Cubed rejects missing or
different compatibility fields as `INCOMPATIBLE_PROTOCOL` and tells the operator
to upgrade the older component. A software version difference alone is allowed
when the protocol range and capabilities match.

## Backup and restore

Create separate, matched snapshots. Both archives contain secrets and must be
encrypted and access-controlled after creation.

```sh
sudo bash scripts/host/backup.sh host /secure/host-$(date +%F).tar.gz
sudo env CUBE_CONTROL_DB=/home/cube/cube/cubed.db \
  CUBE_CONTROL_CONFIG=/home/cube/cube/host-nodes \
  bash scripts/host/backup.sh control /secure/control-$(date +%F).tar.gz
```

The scripts stop the relevant systemd service before copying and restart it only
if it was active. The host path drains first. Keep the pair, checksums, backup
time, Cube release, and host release together. Test restore on isolated machines.

Restore only onto a fresh root while services are stopped. Preserve the failed
installation separately; never merge directories. For host recovery, extract
the installer bundle for the backed-up release, restore first, then run
`install.sh` for that binary to recreate the systemd/release boundary; do not run
`initialize.sh` against restored state:

```sh
sudo bash scripts/host/restore.sh host /secure/host-DATE.tar.gz
sudo bash scripts/host/install.sh "$PWD/bin/cube-node-transport"
sudo env CUBE_CONTROL_DB=/home/cube/cube/cubed.db \
  CUBE_CONTROL_CONFIG=/home/cube/cube/host-nodes \
  bash scripts/host/restore.sh control /secure/control-DATE.tar.gz
```

Restore never starts a service. Host restore creates `restore-quarantine`, so the
daemon can serve health/result reads but rejects new work as `recoveryRequired`.
The immutable binding includes the workspace filesystem identity; a file-archive
restore therefore recovers evidence and workspace contents but does not authorize
that copied workspace as the old environment. Keep the restored binding for
inspection and use the replacement/re-enrollment flow below for new execution.
Only an identity-preserving storage recovery may resume the old binding.
Reconcile every operation known after the snapshot as unknown; never recreate an
intent, remove a `.sent` marker, resubmit an old operation ID, or repeat a side
effect merely because the restored journal says `Unknown`. Cubed startup fails
in-flight runs/tasks according to its existing no-replay rules. After explicit
review of an identity-preserving recovery, while the host service is stopped:

```sh
sudo bash scripts/host/acknowledge-recovery.sh --i-reviewed-unknown-operations
sudo systemctl start cube-host
```

If readiness becomes `faulted` after acknowledgement, the workspace identity did
not survive. Stop the daemon and replace/re-enroll; never edit the immutable
installation row or initialize over the restored journal.

## Identity loss and key rotation

There is no secretless takeover and no in-place mutation of node identity,
allowed control peer, thread, environment, or cubed's pinned admission. Losing
one side's key without a valid matched backup means that binding is retired.
Rotation uses replacement:

1. Drain and stop the old host. Back up both sides and inspect all active or
   uncertain operations.
2. Archive the old Cube thread; retain its admission, intents and journal for
   result inspection and deduplication.
3. Use a fresh host state root, node key, control key, node ID, thread ID and
   environment ID. Transfer workspace content only through an authenticated,
   operator-controlled copy while both daemons are stopped.
4. Initialize the new host with the new control peer, verify its public peer out
   of band, create a new 0600 cubed config/0700 intent directory, and run the
   operator enrollment command against the new identities.
5. Recreate only the required directed thread-task grants. Grants and old
   operations do not transfer authority. Run a harmless canary before work.
6. Retain or securely destroy old secrets/state only under the organization's
   retention policy. Never delete them to make an ambiguous command retryable.

This rotates either the control peer or host identity without weakening immutable
binding. It intentionally creates a new product thread. To reuse the same host,
stop the service, verify the old thread is archived and the private backup pair,
then atomically rename `/var/lib/cube-host` to a root-only dated retirement path
on the same filesystem. Run `install.sh` to recreate empty account directories,
then `initialize.sh` with the fresh binding. Never merge the old and new roots.
Keep the retirement path offline for the required result-inspection/retention
window; remove it only through the organization's approved data-destruction
procedure after all uncertain operation IDs have been resolved. Filesystem-level
quotas and secure media erasure remain OS/operator responsibilities.

## Capacity, retention, and troubleshooting

The host accepts one operation at a time, rejects rather than queues when busy,
caps commands at 8 KiB, cwd at 4 KiB, runtime at 60 seconds, output at 8 KiB,
connections at 16, and immutable operation identities at 10,000. Output beyond
the cap is counted/discarded. Plan replacement before 80% journal capacity;
records are never expired because deleting deduplication evidence could replay a
side effect. Workspace/state cleanup is operator-only after replacement and
retention expiry. Monitor disk usage for `/var/lib/cube-host`; Cube does not claim
a filesystem quota unless the operator configures one.

Logs are one bounded JSON object per lifecycle/error event in journald and omit
commands, output, keys, environment, and paths. Useful actions:

| State/error | Action |
|---|---|
| `DRAINING` | wait for maintenance or explicitly resume/restart after it ends |
| `CAPACITY_EXCEEDED` | wait for active work; if journal is near 10,000, replace the binding |
| `INCOMPATIBLE_PROTOCOL` | upgrade the older cubed/cube-host component |
| `recoveryRequired` | reconcile restore uncertainty, then acknowledge offline |
| `COMPLETION_UNKNOWN` / `Interrupted` | inspect the saved ID; never submit again |
| `WRONG_NODE` | verify pinned peers and full immutable binding out of band |
| `faulted` / `IO_ERROR` | drain/stop, preserve state, inspect disk/journal/workspace ownership |

## Production acceptance

Release sign-off requires a real separate Linux x86_64 host over N0/Iroh relay:
clean install and enrollment; normal host exec; directed T2T recipient execution;
drain rejection; wait and cancel stop policies; upgrade and induced rollback;
daemon and cubed restart/loss; paired backup/restore quarantine; and full
replace/re-enroll recovery. Record versions and operation IDs only in private
acceptance evidence. Offline/loopback smokes are regression evidence, not a
substitute for this external acceptance.
