---
title: threads
description: What a thread is, how to start one directly, what its agent can do, and what happens when you stop or archive it.
---

A thread is one agent with one task and a virtual machine of its own. Its conversation is kept on the cubed host and outlives the browser tab, cubed restarts and runner restarts.

## start a thread

Most threads start from [the chat](/cube/use/chat/). You can also start one directly:

1. Choose **new thread** on **threads** or a project page, or press `n`.
2. Write the first message, and pick the **project** and the **model** under it.
3. Press Enter to start. Shift+Enter adds a line.

A new thread gets its own machine on a runner with a free slot. When every slot is taken, the thread waits for one in order and says `waiting for a free slot`.

## what the thread machine has

- `/workspace` holds the project's primary repository, checked out at the commit its branch had when the thread started. Reference repositories are under `../repos/<name>`.
- The agent's commands run as user `agent`, with `sudo`, inside the machine.
- The network is HTTP and HTTPS to public hosts only. There is no SSH, and the machine cannot reach cubed, the runner, your LAN or a cloud metadata service.
- `GH_TOKEN` and git's credentials are placeholders. cube's gateway puts your GitHub token into requests to github.com and api.github.com, so `gh`, `git fetch` and `git push` work.

## what the agent can do

A thread's agent has these tools, all running in its machine:

- `read`, `write` and `edit` for files, and a bounded `bash` for commands.
- `codemode`: one model-written script that calls those tools.
- `cube service`: run a web server and get a URL for it. See [web servers in a thread](/cube/use/services/).
- `artifact_write`, `artifact_read` and `artifact_edit`: documents for you to read. See [artifacts](/cube/use/artifacts/).
- Read access to your chat with cube and to the stored conversations of other threads in the same project.

Claude Code threads use Claude Code's own Bash, Read, Write and Edit tools, which cube sends to the machine. See [models](/cube/use/models/).

## follow a thread

A thread shows each command as a folded line. A run of commands folds into one line that says what failed and what still runs. Open a line to see the command and its output.

While the machine starts, a **machine startup** panel lists each step with its time: the template, the boot, the checkout and the setup scripts, with the running script's log. See [projects](/cube/use/projects/#prepare-machines-with-setup-scripts).

## stop and resume

**stop** ends the running turn. The conversation stays, and the next message starts a new turn.

A machine that nothing has used for 5 minutes can be suspended to disk, when its runner has suspend on. It frees its slot and resumes where it was when the thread gets a message, runs a command or serves a page. See [a thread's life](/cube/concepts/thread-lifecycle/).

## archive a thread

Choose **archive thread**, then press it again to confirm. Archiving closes the agent, releases the machine and frees its slot. An archived thread cannot be reopened. Its conversation and usage stay readable.

cube deletes the machine's disk, unless it holds work that would be lost or could not be checked:

- uncommitted changes,
- commits that were not pushed,
- files outside a checkout, in a project without repositories.

Then the disk is retained, and the thread says why. You can discard a retained disk later from the UI.
