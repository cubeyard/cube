# macOS Trusted Runners Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicit, honestly bounded native macOS trusted-runner profile while preserving Linux x86-64/systemd behavior.

**Architecture:** Keep one Rust protocol/journal implementation, isolate cwd opening and process handling behind Unix platform functions, and dispatch operational scripts to systemd or launchd. Recommend a dedicated-account LaunchDaemon for production and retain a rootless LaunchAgent for disposable acceptance/development.

**Tech Stack:** Rust 1.91/Tokio/libc/rusqlite/Iroh, Bash, launchd property lists, Node 26/Effect 4 control plane, GitHub Actions.

---

### Task 1: Darwin workspace and execution boundary

**Files:**
- Modify: `packages/node-transport/src/runner.rs`
- Modify: `packages/node-transport/tests/runner_execution.rs`

1. Remove the Linux-only test/profile gate and create platform-specific cwd openers.
2. Add Darwin tests for normal nested cwd, parent/absolute rejection, symlink components, workspace replacement, and rename/symlink races.
3. Run the focused Rust test and confirm the new cases fail before implementation.
4. Implement Darwin component-wise `openat` with `O_NOFOLLOW`, preserving Linux `openat2`.
5. Run fmt, clippy, and runner tests on macOS.

### Task 2: Darwin process-tree cancellation

**Files:**
- Modify: `packages/node-transport/src/runner.rs`
- Modify: `packages/node-transport/tests/runner_execution.rs`
- Modify: `packages/node-transport/RUNNER.md`

1. Add tests where a shell forks grandchildren that would write after timeout and cancel.
2. Verify failure on any platform behavior that only kills the leader.
3. Keep the child in a new process group and centralize group termination/reap handling for Linux and Darwin.
4. Document the `setsid`/hard-crash limitation and absence of macOS cgroups.

### Task 3: launchd lifecycle and portable operations

**Files:**
- Modify: `scripts/runner/lib.sh`
- Modify: `scripts/runner/{install,initialize,status,drain,upgrade,backup,restore,acknowledge-recovery,uninstall,package}.sh`
- Create: `scripts/runner/com.cubeyard.cube-runner.plist.in`
- Modify: `scripts/runner-production-test.ts`

1. Add failing fixture tests for Darwin user/system layouts, generated plist fields, portable checksums/archives, drain/start/stop, and rollback.
2. Add OS/mode/path/checksum/archive/service adapters while retaining Linux defaults and legacy migration.
3. Generate and `plutil -lint` launchd plists; distinguish LaunchAgent and LaunchDaemon/account trust.
4. Exercise complete rootless lifecycle in disposable paths.

### Task 4: package and CI matrix

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/test-node-transport.sh`
- Modify: `scripts/runner/package.sh`

1. Matrix node transport across Ubuntu x86-64 and macOS arm64.
2. Include shell syntax, production script tests, plist validation, package target metadata, and archive hygiene on both.
3. Keep Linux systemd tests and release behavior unchanged.

### Task 5: docs and control-plane integration

**Files:**
- Modify: `docs/trusted-runner-operations.md`
- Modify: `packages/node-transport/{README.md,RUNNER.md}`
- Modify: `DEVELOPING.md`, `SECURITY.md`, `HANDOFF.md`
- Modify/test affected TypeScript runner code only where integration exposes a defect.

1. Publish the exact supported macOS matrix and trust language.
2. Document user/system install, lifecycle, relay metadata, backup/restore, replacement enrollment, resource-limit non-guarantees, and process escape limit.
3. Update Monty runner smoke syntax and ensure operations/T2T APIs remain covered.

### Task 6: end-to-end acceptance and report

1. Run typecheck, lint, build, offline suite, shell syntax, Rust fmt/clippy/tests, Node↔Rust loopback/direct, and public relay.
2. Run disposable rootless install/init/launchd/status/drain/cancel/restart/no-replay/upgrade rollback/backup/restore/replacement enrollment.
3. Run disposable cubed runner routing and T2T; verify logs/report contain no secrets, IDs, IPs, or private paths.
4. Commit locally; do not push or deploy.
5. Report the macOS result and exact Linux regression command to the owning Puck thread. Do not claim cross-platform sign-off until the separate Linux runner returns.
