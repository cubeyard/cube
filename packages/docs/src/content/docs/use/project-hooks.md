---
title: project hooks
description: The pre-setup and pre-resume hooks a project keeps in cube, how to set them, and what they may and may not hold.
---

A project has two hooks of its own: shell scripts that cube keeps with the project and runs in each of its thread machines. They are not in any repository. Use them for setup that belongs to your installation, such as a package a private build needs, rather than to the repository.

## the two hooks

| hook | runs | then |
|---|---|---|
| **pre-setup** | once, when a new thread machine is prepared, after the repositories are checked out | the repository's `.agents/setup`, only if pre-setup succeeded |
| **pre-resume** | on every boot of a thread machine, before the agent opens | the repository's `.agents/resume`, only if pre-resume succeeded |

```text
new machine:  checkout ─▶ pre-setup ─▶ .agents/setup
every boot:   pre-resume ─▶ .agents/resume ─▶ the agent opens
```

There is nothing else to set: no timeout, working directory, order or trigger of your own.

- Each hook is one script of at most 16384 bytes. Without a `#!` line, bash runs it. An empty script means no hook.
- It runs as user `agent` in `/workspace`, inside the thread's machine, with the machine's network.
- Preparation has 30 minutes in total, checkout and both setup scripts included. The resume phase has 30 minutes.
- A failing hook stops its phase, so the repository's script does not run. It never fails the thread. The outcome is recorded.
- A thread takes the hooks saved when it starts. A change applies to new threads only. A changed pre-setup also means a new template, so the next thread prepares its machine from the start.

## set the hooks

- **On the project page**, under **machine hooks**. Save the project to keep them.
- **Ask the chat**, naming the project. The chat saves hooks only when you ask and name the project. A thread's report never counts as you asking.

A thread cannot change the hooks. Hooks run in every new machine of the project, and a thread's agent reads untrusted repository content.

## read what ran

In a thread's machine, the agent can run:

```sh
cube hooks
```

It shows the project's hooks and the repository's scripts in the order they run, each with its last outcome in that machine and the end of its log. A machine made from a template shows pre-setup and setup as `skipped`. Logs are in `~/.cache/cube/` in the machine.

While a machine starts, the thread's **machine startup** panel shows the running hook's log. A failed step keeps its whole error and the end of its log.

## do not put secrets in hooks

Every machine of the project can read the hooks, in `/etc/cube/hooks/`. The chat redacts secret-looking values when it shows them, and says when a script looks like it holds one. For GitHub, the machine already has a placeholder token that cube's gateway replaces.

## HTTPS trust

A thread machine's HTTPS goes through its runner, which signs it with the runner's own CA. cube makes the machine trust that CA on every boot, so you need no hook for curl, git, gh, apt, Python, Node, or Java from the distribution.

A tool with a certificate store of its own, such as a JDK unpacked from a tarball, does not trust the runner's CA. Import the runner's CA from `/etc/cube/ca.pem` into that store in pre-resume, reading it on every boot. Never turn certificate checks off. Clients that pin certificates fail against the runner.
