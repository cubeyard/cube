---
title: update cube
description: Update cubed and the runner with Homebrew or from a signed release, and what an update does to running threads.
---

cube releases are signed. Each one updates cubed and the runner together. Threads, transcripts and model logins stay where they are.

## macOS

```sh
brew update
brew upgrade cubeyard/tap/cube cubeyard/tap/cube-berth
brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube
```

Run `brew update` first. Without it, Homebrew may not see a new release for up to a day, and `brew upgrade` says the old version is already installed.

Restart the services right after the upgrade. `brew upgrade` does not restart them, and it removes the old version's files from under the running processes. Under Homebrew the **system** page shows cubed as managed externally, and the browser never updates it.

## Linux

With `CUBED_GUI_UPDATES=1` in `~/.config/cubed/environment`, open **settings** › **system**:

1. Choose **check for updates**. cubed verifies the latest stable signed manifest and shows its version and commit.
2. Choose **install** and confirm.

The page reports each phase: verification, download, staging, drain, restart and probation. The browser may disconnect for a moment while cubed restarts and reconnects by itself. If the new release does not report healthy, cubed restores the previous one and shows the failure.

Without browser updates, run `install.sh` with the new release's four files, as in [install on Linux](/cube/start/install-linux/#install-cubed), then restart cubed.

The runner is not part of this update. Install the new berth and keel from the same release, then restart `berth vm` with the same `--dir` when no thread on it has a running turn. The runner keeps its key, so it needs no new enrollment.

## what an update does to threads

- Restarting the runner stops its machines. Their disks are kept, and cubed starts each machine again when its thread needs it.
- A machine that was suspended before the update starts from its disk instead of its saved memory, because the snapshot does not fit the new kernel. The thread shows `restarted after an update; running commands were interrupted`.
- A thread whose turn was running when cubed restarted reports that the turn failed. Tell it to go on.

## going back

On Linux, the installer keeps earlier releases under `~/.local/share/cubed/releases/`. To go back, stop cubed and point `current` at a reviewed earlier release; see [cubed updates](gh:docs/cubed-updates.md) for the rules. Do not delete state or runner directories to make an older release start.
