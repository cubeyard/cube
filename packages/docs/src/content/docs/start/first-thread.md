---
title: your first thread
description: Install cube on a Mac, connect GitHub and a model, add a project, and get a thread's report back in the chat.
---

In this tutorial we install cube on an Apple Silicon Mac, connect GitHub and a model, add one repository as a project, and ask the chat for a small change. At the end you have a thread that worked in its own machine, its report in the chat, and an archived thread whose machine is gone.

You need an Apple Silicon Mac with [Homebrew](https://brew.sh), a GitHub account and a login or API key for a model provider. On Linux, follow [install on Linux](/cube/start/install-linux/) first, then continue from [open cube](#open-cube).

## install cube

1. Trust the tap and install the formula:

   ```sh
   brew trust cubeyard/tap
   brew install cubeyard/tap/cube
   ```

   Homebrew downloads QEMU and cube's release bundle first. After `==> Installing cubeyard/tap/cube` it prints nothing for a while (14 to 32 seconds on GitHub's macOS runners) while it unpacks and checks the bundle's files. That pause is normal.

2. Set up the runner that hosts thread machines on this Mac:

   ```sh
   cubed runners init-local
   ```

   The first run pulls cube's default image (official Debian trixie, pinned by digest) and prepares it. It ends by enrolling the runner. Running it again later changes nothing and says `already set up and enrolled`.

3. Start both services:

   ```sh
   brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube
   ```

## open cube

Open [http://127.0.0.1:7777](http://127.0.0.1:7777) in your browser. You see a two-step setup.

1. **connect github?** Choose the GitHub login. cube runs `gh auth login` on the host, and you approve **GitHub CLI** in the browser. The token stays on the host. A thread's machine sees only a placeholder. You can also choose **not now**: threads can still clone public repositories.
2. **make yourself at home.** Leave **chat memory** on **follow the chat's model** and choose **open the chat**.

You are now in the chat, cube's home page.

## connect a model

1. Open **settings**. The first page is **model providers**.
2. Find your provider and connect it with its browser or device login, or paste an API key. Credentials stay in `~/.pi/agent` on this Mac.
3. When the provider shows its models, go back to **chat**.

To use Claude Code with a Claude Pro or Max subscription instead, see [models](/cube/use/models/#claude-code-threads).

## add a project

A project is a set of repositories that its threads check out. We add one.

1. Open **projects** and choose **new project**.
2. Give it a **project name**, for example `hello`.
3. Under **repositories**, enter the GitHub URL of a repository you can push to, for example `https://github.com/you/hello`.
4. Choose **save**, then **check**. The repository row shows the branch and commit it resolved. The project is ready when the check passes.

## ask the chat for a change

1. Go back to **chat** and write what you want, naming the project:

   ```text
   In hello, add a short "Development" section to the README that says how to run the tests. Open a pull request.
   ```

2. Send it. The chat starts a thread and says so. A note for the thread appears beside your message. On a narrow window it appears under the message.

3. Open the thread from that note. Its first machine takes a minute or two. The thread shows `starting the thread's machine` while the runner boots the machine, checks out the repository and runs the repository's `.agents/setup`, if there is one. Later threads of the project start from what that first machine prepared, in seconds.

4. Watch the agent work. Its commands appear as folded lines you can open. While it works, the thread's message field waits, and **stop** ends the turn. You can keep talking to the chat meanwhile.

5. When the thread ends its turn, its report arrives in the chat as one folded line: the thread's name, `report`, how the turn ended and its first words. Open it to read the whole report. It names the pull request the thread opened.

The chat tells you what the thread did and what is left. If the thread stopped short, tell the chat what to do next, and it passes that to the same thread.

## archive the thread

An open thread holds one of the runner's machine slots. A Mac runner has two by default.

1. Ask the chat to archive the thread, or open the thread and choose **archive thread**, then press it again to confirm.
2. cube deletes the machine's disk, unless the machine holds work that would be lost, such as uncommitted changes or commits that were not pushed. Then cube keeps the disk and says why.

The thread's conversation and usage stay readable after the archive.

## what you did

You installed cube and its runner, connected GitHub and a model, added a project, and had a thread make a change in its own machine and report back. Next:

- [The chat](/cube/use/chat/) explains how to steer threads, read reports and keep work going.
- [Projects](/cube/use/projects/) covers repository setup scripts, machine size and hooks.
- [Security model](/cube/concepts/security-model/) says what the thread machine isolates and what it does not.
