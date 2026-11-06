---
title: a thread's life
description: How a thread's machine starts, waits for a slot, sleeps, wakes and is released, and what each state word in the UI means.
---

A thread outlives its machine's moments. The conversation is kept on the cubed host from the first message to long after the archive. The machine under it starts, may sleep and wake many times, and is released at the end. This page follows one thread through that life.

## starting

A new thread is accepted at once. cubed checks the project and the runner and stores the thread with its place in the queue. Then, in the background:

1. The **model** step checks that the model exists and its provider has a working login.
2. The **commits** step fetches the latest commits of the project's repositories and resolves the skills.
3. The runner creates the machine, from the project's template when there is one, and boots it.
4. A new machine without a template is prepared: checkout, the project's pre-setup hook, the repository's `.agents/setup`.
5. Every boot runs the pre-resume hook and `.agents/resume`. Then the agent opens.

The thread shows `starting the thread's machine` through all of it, and the **machine startup** panel lists each step with its time. A step that fails is tried again, with pauses that grow from 30 seconds to 30 minutes, and the chat hears of a failure that lasts.

## waiting

A thread waits rather than fail when the cause is temporary, and it says why:

| the thread says | meaning |
|---|---|
| `waiting for a free slot` | every slot on its runner is taken; it starts in its turn |
| waiting for disk space | its runner keeps 2 GiB free and has less; it tries again every 30 seconds |
| waiting for runner … | its runner does not answer; it keeps its slot and its place |

A thread never moves to another runner. A thread whose machine was never ready and whose runner stays down gives up after about 90 minutes, saying so. A new message tries again.

## sleeping and waking

When its runner has suspend on, a machine that nothing has used for 5 minutes is saved to the runner's disk and frees its slot. "Used" covers a lot: a turn of the agent or its background agents, a running command, a portal connection, a registered web service. The thread shows `suspended`.

Anything the thread needs wakes it: a message, a command of its agent, a request through the portal. The thread shows `waking…`, and the machine resumes where it was, with its processes and their memory. On a full runner, the wake waits for a slot.

After cubed itself restarts, machines it finds running are not suspended for 32 minutes, because commands from before the restart may still run.

## restarts

- **cubed restarts.** Each thread reopens from its store. A turn that was running reports that it failed, and a message continues it.
- **The runner restarts.** Its machines stop and keep their disks. cubed starts each again when its thread needs it.
- **cube is updated.** A machine suspended by the old version starts from its disk instead of its saved memory, and the thread says `restarted after an update; running commands were interrupted`.

## archiving

Archiving is the end. cubed closes the agent, checks the machine's disk and releases the machine, which frees its slot.

The release check keeps the disk when it holds work that would be lost: uncommitted changes, commits not pushed, files outside a checkout in a project without repositories, or a disk that could not be checked. Otherwise the disk is deleted. Either way the conversation, its usage and what was pushed stay.

An archived thread cannot be reopened. Nothing starts, wakes or calls its machine again. A retained disk can be discarded later.

## read more

The full state machines, with every event and who may cause it, are in [thread-lifecycle.md](gh:docs/thread-lifecycle.md) for maintainers.
