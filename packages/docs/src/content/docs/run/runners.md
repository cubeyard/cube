---
title: runners
description: The machines that host thread machines. Size a runner, add one on another machine, watch it, give it disk room and retire it.
---

A runner hosts thread machines. cubed tells it to create, start, suspend and delete them; the runner runs no command of its own for a thread. A runner is `berth vm`: one QEMU machine per open thread, with KVM on Linux or Hypervisor.framework on an Apple Silicon Mac.

## the pool

Every enrolled `berth vm` is in the pool. A new thread that names no runner goes to a pool runner with a free slot. It prefers a runner that answered in the last two minutes, then the one with the lowest share of used slots.

- A thread holds a slot on its runner from creation until its archive finishes. A suspended machine holds none.
- A thread never moves to another runner. While its runner is down, the thread waits and says so.
- With every slot taken, new threads wait in order and start when a slot frees.

`berth host` is a second kind of runner, for developing cube's runners only. It runs a thread's commands on that host, as the user who started it, with no sandbox. It is never in the pool. A thread goes there only when it is started on that runner by name.

## machines per runner

A runner hosts up to `--max-machines` machines at once: 2 for the runner `init-local` sets up, 8 for `berth vm` otherwise. Each machine gets the project's size, else cubed's default of 2 processors and 4096 MiB. Plan the runner's memory for its slots: two default machines need 8 GiB for themselves.

For the local runner, choose the number at the first `cubed runners init-local --max-machines N`. Later runs refuse another value rather than change it.

## watch runners

- **On the project page**, each runner is listed with its contact, version, slots and free disk space.
- **In the chat**, ask about the runners. The chat reports them as cubed last heard from them.
- **On the cubed host**, `cubed runners status` shows whether each runner answers.

A runner is `unreachable` when its latest check failed, and `stale` after seven days of failed checks. A report that is not fresh is the last known state, not the current one.

## disk room

A runner refuses a new machine while its disk has less than 2 GiB free, besides what template builds may still write, or fewer than 10,000 free inodes. Nothing is made, and the thread waits for disk space on that runner and tries again every 30 seconds. A new thread goes to another runner with room when one exists.

berth never deletes anything to make room. Free space by archiving threads you are done with, which deletes their machines' disks unless they hold unsaved work.

## suspend

Suspend is off unless `berth vm` starts with `--suspend-disk-margin-gib <GiB>`. The Homebrew runner service passes 2.

With suspend on, cubed saves a machine to the runner's disk after 5 minutes in which nothing ran: no turn of its agent, no command, no portal connection and no registered web service. The machine frees its slot. Anything the thread needs wakes it. When a thread waits for a slot, the runner's idlest machine is suspended at once instead.

A save needs the machine's whole memory plus the margin free on disk. Otherwise the machine keeps running. Every suspended machine keeps its memory file until it resumes or is archived.

## add a runner on another machine

A second runner adds slots, or puts thread machines on a machine apart from cubed. It needs a Linux x86-64 machine with KVM, or an Apple Silicon Mac, and a release's berth and keel.

1. **Verify the release** from a checkout of its tag, never with a script from inside the bundle:

   ```sh
   node scripts/berth/verify-release.ts <release directory>
   ```

2. **Make a control key** for cubed on the cubed host. Use a new key for each runner. The command prints the public half, which the runner takes as `--allow-peer`:

   ```sh
   berth keygen --key ~/.cube/runner-2.control.key
   ```

3. **Install berth** on the runner machine with the bundle's installer, every path absolute. It checks QEMU, the accelerator and keel before it writes anything, and it never starts or enrolls the runner:

   ```sh
   berth-<release>-<platform>/share/berth/install-berth.sh \
     --prefix ~/berth --dir ~/berth/state --keel ~/berth/keel/<arch> \
     --qemu /abs/qemu-system-<arch> --qemu-img /abs/qemu-img --mkfs-erofs /abs/mkfs.erofs \
     --network direct --listen <runner address>:7798 \
     --node-id node-<name> --allow-peer <public key from step 2> --max-machines 4 \
     --unit-dir ~/berth/units --unit-name berth-vm --kind systemd   # or launchd
   ```

4. **Start it** with the unit the installer wrote. Its log prints the runner's own peer and `waiting for cubed`.

5. **Enroll it** from the cubed host with a config file, mode 0600, at an absolute path:

   ```json
   {
     "version": 2,
     "protocol": 4,
     "binding": { "nodeId": "node-<name>", "threadId": "node-<name>", "environmentId": 1 },
     "controlKey": "/abs/path/.cube/runner-2.control.key",
     "serverPeer": "<the runner's peer, from its log>",
     "network": "direct",
     "address": "<runner address>:7798"
   }
   ```

   ```sh
   cubed runners enroll --config /abs/path/runner-2.json
   ```

   cubed says hello to the runner before it admits it. The runner joins the pool.

The connection uses Iroh: QUIC with pinned peer keys, end to end encrypted. `--network relay` reaches a runner without a direct address through Iroh's relays; then the config has `"network": "relay"` and no `address`. Relay operators can see endpoint addresses and traffic metadata. The installer's other options are in berth's [install from a release](gh:packages/berth/README.md#install-from-a-release).

:::caution
The runner account runs QEMU, and a guest escape through a QEMU bug has that account's authority. Give a runner that matters a dedicated account with no SSH, cloud, Git or provider credentials. See the [security model](/cube/concepts/security-model/).
:::

## upgrade a runner

Install the new release with the same `--dir`. The runner keeps its key and peer, so it needs no new enrollment. Point the start script at the new `libexec/berth-<version>/berth`, or install with a new `--unit-name`, and restart when no thread on it has a running turn. Machines stop with the runner, keep their disks, and start again when their threads need them.

## retire a runner

Retiring is permanent. cubed refuses while the runner has an open thread or reports an active machine.

1. Archive the runner's threads.
2. On a project page, choose **retire** beside the runner. Type its node id and a reason, then choose **retire binding**.
3. Stop and remove its unit yourself.

Retiring removes the runner's capacity. It deletes nothing: thread records, the runner's journal and retained machine disks stay. An unreachable runner must be stale, unreachable for seven days, before it can be retired.
