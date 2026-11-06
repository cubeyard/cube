---
title: troubleshooting
description: What to do when an install step fails, a thread stays starting, a runner is unreachable or a port is taken.
---

Start with the symptom. Each entry says what it means and what to do.

## install and update

### `brew upgrade` says the old version is already installed

Homebrew's copy of the tap is older than the release. Run `brew update`, then upgrade again.

### `init-local` says "not enrolled"

berth could not start on this machine. The message carries berth's error: no Hypervisor.framework or KVM, a QEMU below keel's floor, or an image pull that failed. Fix that and run `cubed runners init-local` again. It continues with what it already made.

### `init-local` says "another berth vm runs in"

Something holds `~/.cube/berth` before `init-local` finished, such as a second `init-local` or a `berth vm` started by hand. Stop it, then run `init-local` again.

### `init-local` refuses with "init-local changes nothing that is there"

An option disagrees with what `~/.cube` already records: another image, `--listen`, `--node-id` or `--max-machines`. Leave the option out to keep the recorded value.

### `cube-berth.log` says "not set up yet"

The runner service started before `init-local`. Run `cubed runners init-local`, then `brew services restart cubeyard/tap/cube-berth`.

### port 7777 or 7779 is taken

Set `CUBED_PORT` in `~/.config/cubed/environment` for cubed. For a new runner, pass `init-local --listen 127.0.0.1:<port>`. `init-local` checks the runner's UDP port before it writes anything. Once berth has listened, its address is fixed.

## threads

### a thread stays "starting"

The first machine of a project takes a minute or two. Its **machine startup** panel shows each step and the running script's log. If it stays longer, collect the thread's diagnostics bundle before you change anything:

```sh
curl -fsS "http://127.0.0.1:7777/api/threads/<thread-id>/diagnostics" -o cube-diagnostics-<thread-id>.json
```

The thread id is in the thread's URL. The bundle is read only. It starts, stops and moves nothing, and works for archived threads too. Or ask the chat to diagnose the thread. It gives the same evidence as text for a thread it started.

The bundle redacts secret-looking values by pattern. Read it before you share it outside your own machines.

### a thread says `waiting for a free slot`

Every slot on the runners is taken. Archive threads you are done with, or [add a runner](/cube/run/runners/#add-a-runner-on-another-machine). Waiting threads start in the order they asked.

### a thread waits for disk space

The runner's disk has less than 2 GiB free besides what template builds may still write. Free space on the runner, for example by archiving threads. The thread tries again every 30 seconds.

### a setup step ran out of memory

The step fails with `the machine ran out of memory`, and the thread suggests a larger size. Raise the project's **machine size**. New threads get the new size.

### a thread shows `restarted after an update; running commands were interrupted`

The runner was updated while the machine was suspended. The machine started from its disk instead of its saved memory. Commands that were running are gone. Tell the thread to go on.

### "gateway unavailable"

cubed did not find or could not start `cube-gateway`, which it needs for GitHub access from threads. The release bundle has it next to cubed. Check `cubed.log`.

## runners

### a runner is `unreachable`

Its latest check failed. Run `cubed runners status` on the cubed host. Check that the runner's service runs and that its log says `waiting for cubed` or shows connections. Threads on it wait and keep their slots. They never move to another runner.

## where the logs are

| what | macOS (Homebrew) | Linux |
|---|---|---|
| cubed | `/opt/homebrew/var/log/cubed.log` | the terminal, or `journalctl --user -u cubed` for the user service |
| the runner | `/opt/homebrew/var/log/cube-berth.log` | the terminal, or the runner unit's journal |
| one machine | `~/.cube/berth/<machine id>/events.log` | `<berth dir>/<machine id>/events.log` |
| a setup script | `~/.cache/cube/<hook>.log` inside the thread's machine | the same |

To report a bug, open an issue on [GitHub](https://github.com/cubeyard/cube/issues) with the version from **settings** › **system** and, for a thread, its diagnostics bundle. Report security problems privately, as [SECURITY.md](gh:SECURITY.md) says.
