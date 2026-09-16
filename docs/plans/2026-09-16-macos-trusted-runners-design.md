# macOS trusted runners design

## Supported profiles and trust boundary

Cube supports the existing Linux x86-64/systemd runner and adds native macOS
arm64/x86-64 runners. Both remain trusted, non-sandboxed execution: commands
run with all authority of one unprivileged account. The production macOS
profile is a system LaunchDaemon running as a dedicated, passwordless, hidden
`_cube-runner` account. That account must have no login keychain, provider,
GitHub, SSH, cloud, admin, sudo, or operator credentials. Installation of that
profile requires an explicitly approved root action.

A per-user LaunchAgent is also supported for development and disposable
acceptance. It is safe only when the login account itself is dedicated and
credential-free. Running it from an ordinary developer account is lower
assurance because the command inherits that account's filesystem authority;
Cube will say so rather than presenting it as the production boundary. The
rootless acceptance suite uses disposable paths and harmless commands, not the
operator's repositories or credentials.

The daemon keeps the existing immutable node/thread/environment binding,
single-owner SQLite journal, commit-before-spawn, consumed intents, and
startup conversion of unfinished records to `Interrupted`. Iroh peer/node
terminology and N0 relay behavior are unchanged.

## Workspace and process boundaries

Linux retains `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`. Darwin has no
equivalent. Its implementation opens the identity-checked workspace and walks
each relative cwd component with `openat(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`.
Absolute paths, parent components, symlink components, missing components, and
non-directories fail before journaling or spawn. The final cwd is an open file
descriptor and the child enters it with `fchdir`, so path replacement after
validation cannot redirect spawn. This deliberately rejects symlink cwd paths
instead of providing an insecure canonicalize-then-open fallback.

This is cwd confinement, not filesystem confinement. Once started, arbitrary
shell code can access anything the runner UID can access. A same-UID process
can also mutate the workspace concurrently. The dedicated account and strict
state placement are therefore load-bearing.

Commands get a new process group on both systems. Timeout, incident cancel,
and graceful stop signal the unreaped group and confirm leader reap. Ordinary
children and grandchildren cannot survive. A process that deliberately calls
`setsid`/changes process group can escape this mechanism; Linux systemd's
`KillMode=mixed` supplies a service-level backstop, while launchd provides no
cgroup-equivalent per-job containment. macOS therefore makes no claim that it
can kill malicious self-detaching same-UID descendants after they escape the
group, and hard daemon/machine loss remains `completionUnknown`.

## Lifecycle, artifacts, and recovery

One native package is built per OS/architecture and records target metadata in
its manifest/checksum. Shared scripts dispatch lifecycle operations to systemd
or launchd. macOS paths are mode-specific, plist files are generated with
absolute paths, `plutil -lint` validates them before bootstrap, and launchd
domain/label operations replace Linux signals through systemctl. Ready files
remain the bounded readiness authority.

Upgrade stages an immutable release, drains, stops, atomically switches the
current symlink, starts, and checks protocol/version readiness. Failure restores
the old link and plist and restarts the old release. Backup is offline and
identity-preserving. Portable archive creation/extraction avoids GNU-only tar
flags on Darwin, validates member paths before extraction, and always restores
into quarantine. Re-enrollment is replacement only: old evidence is retained,
new key/state/config are created separately, and no binding is rewritten.

## Alternatives considered

1. **Canonicalize cwd then spawn by path:** small, but symlink replacement
   reintroduces a check/use race. Rejected.
2. **Require a VM/container on macOS:** strongest isolation, but contradicts
   the requested native trusted-runner profile. It remains the recommendation
   for untrusted work, not this profile.
3. **Use a LaunchAgent as the sole production profile:** rootless, but commonly
   exposes a developer's credentials. Kept only as a clearly lower-assurance
   development profile; the dedicated-account LaunchDaemon is production.

## Verification boundary

macOS acceptance covers Rust unit/integration tests, adversarial cwd swaps and
symlinks, process-tree timeout/cancel/stop, key and journal modes, package/plist
hygiene, rootless LaunchAgent lifecycle, loopback/direct/public-relay transport,
real Node↔Rust routing, durable restart/no-replay, drain, upgrade rollback,
backup/restore quarantine, and replacement enrollment with disposable state.
CI runs Rust and portable lifecycle tests on Linux and macOS. A separate Linux
runner must still repeat production systemd/N0/T2T acceptance; a green Mac run
is not cross-platform sign-off.
