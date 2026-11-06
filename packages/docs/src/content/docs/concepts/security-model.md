---
title: security model
description: What a thread's machine isolates, what it does not, and what you must protect yourself. Read it before you expose cube beyond your own browser.
---

cube runs agents with real tools against your repositories and your GitHub token. It isolates what those agents execute. It does not make your cube host safe to expose. This page says exactly where the line is.

## the thread machine is the sandbox

A thread's commands run as user `agent` in its own keel virtual machine under QEMU. Its file tools reach any file in that machine, and never a file on the host or in another thread's machine. Its files, processes and network are its own.

- **No real credentials.** The machine holds placeholders only. A request to github.com or api.github.com goes through cubed, whose gateway puts your token in on the way out.
- **Public HTTP and HTTPS only.** The machine's network is a LAN of its own inside the runner: DNS, and TCP to ports 80 and 443. An upstream is refused unless every address it resolves to is public. So the machine cannot reach cubed, the runner, your LAN or a cloud metadata service.
- **HTTPS is intercepted** with the runner's own CA, which the machine trusts. Clients that pin certificates fail.
- **The guest is treated as hostile.** The runner talks to it over one channel and ends the connection on any frame that breaks the channel's rules.

## what the sandbox does not cover

- **The runner host.** QEMU runs as the runner's account, hardened by `-sandbox on` on Linux and not at all on macOS. A QEMU escape has that account's authority. On a one-Mac setup that account is yours. Give a runner that matters a dedicated account or machine without SSH, cloud, browser, Git or provider credentials.
- **What the agent sends out.** The machine may reach any public HTTPS host. An agent can send what it can read, its workspace and the project's repositories, to a server of its choice.
- **What the agent does with your token.** Through the gateway, the agent acts with your GitHub account's authority on github.com, pushes included. Give projects only the repositories you mean it to touch, and use an account whose access you accept for agents.

## what runs on the cubed host

The agents themselves are not sandboxed. Pi, its code-mode worker and Claude Code run on the cubed host as the user who runs cubed, with that user's files and the model credentials. Only the tools they call run in the thread's machine.

Claude Code threads start with a fixed tool list, no user settings, hooks or MCP servers, and Bash, Read, Write and Edit sent to the machine. These guards depend on Claude Code honoring its flags, and Claude Code itself still runs as your user.

## what a thread can read

- **Your chat with cube.** Every new thread gets a view of the chat in its prompt and can read any message of it, including briefs and reports of other threads and projects. Secret-looking values are redacted: tokens, `key=value` pairs, passwords in URLs and private keys. A secret written in plain words is not. The thread's model provider receives what the thread reads.
- **Its project's threads.** A thread can read the stored conversation of any thread in its own project, archived ones included, with the same redaction. Threads of other projects are out of its reach.
- **Its project's artifacts.**

What a thread reads is context. It grants no permission.

## cubed has no login

cubed listens on `127.0.0.1:7777`. Anyone who reaches it is you, and can start threads, read every transcript and confirm merges. Keep it on loopback, behind an authenticated proxy, or on a private network such as Tailscale, as [reach cube from other devices](/cube/run/private-network/) describes. Never expose it to the public internet. The host allow-list, `CUBED_ALLOWED_HOSTS`, protects against DNS rebinding. It is not access control.

The portal for thread web servers follows the same rule: no login, plain HTTP, private or loopback addresses only.

## updates are signed

Every release's manifests are signed with one Ed25519 key, whose fingerprint is:

```text
SHA256:b8bf201636954ea8eca2150cf77fed21fac580dc2fb674f4f134495893abd451
```

The installer and the managed launcher verify them. The Homebrew formulas pin each file's sha256 from those manifests. A Homebrew user also trusts the tap's commits, because whoever can write the tap can publish a formula.

## unsandboxed host runners

`berth host` exists only to develop cube's runners. A thread started on it by name runs its commands directly on that host, as the user who started it, with that user's files, network, SSH keys and logins. Nothing isolates it. cube never places a thread there unless it was named, and never moves one there.

## report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/cubeyard/cube/security/advisories/new). Security fixes target the latest release and `main`. See [SECURITY.md](gh:SECURITY.md).
