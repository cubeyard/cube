# Project hooks

A project in cube's **projects** has two external hooks, shell scripts cube
runs in each of the project's thread machines. They are kept in cubed's
registry with the project, not in any repository. This page is the whole
supported interface for reading and changing them; there is no other.

| who | reads | changes |
| --- | --- | --- |
| the user, on the project page | the scripts | both scripts (`PUT /api/projects/<id>`, with the repositories; the page sends only the hooks edited on it, so one OptChat saved meanwhile stays) |
| OptChat | `project_hooks(project)`: the scripts, their latest outcomes, what is supported | `project_hooks_write(project, preSetup?, preResume?)` |
| a thread's agent (Pi or Claude Code) | `cube hooks` in its machine: the hooks that machine runs, their last outcomes and logs | nothing |

## What is supported

Two hooks, nothing more. There is no per-hook timeout, working directory,
order, trigger or environment of one's own to set; a request naming one is
refused.

| hook | field | when it runs | then |
| --- | --- | --- | --- |
| pre-setup | `preSetup` | once, when a new thread machine is prepared, after the project's repositories are checked out | the repository's `.agents/setup`, only if pre-setup succeeded |
| pre-resume | `preResume` | on every boot of a thread machine, before the agent opens | the repository's `.agents/resume`, only if pre-resume succeeded |

```text
new machine:  checkout ─▶ pre-setup ─▶ .agents/setup          (skipped on a template machine)
every boot:   pre-resume ─▶ .agents/resume ─▶ the agent opens
```

- Each is one script of at most 16384 bytes, without NUL; `""` (or only
  whitespace) means none. Without a `#!` line bash runs it.
- It runs as the guest user `agent` in `/workspace`, with the environment
  of agent commands, inside the thread's VM (the sandbox: what it may reach
  is what the machine may reach, HTTP and HTTPS through the gateway). Output
  goes to `~/.cache/cube/<hook>.log` in that machine.
- Both the external hook and the repository's run; neither replaces the
  other. The order is fixed.
- Time: the whole preparation (checkout, pre-setup and `.agents/setup`) has
  30 minutes, the whole resume phase 30 minutes.
- A failing hook stops its phase (the repository's hook does not run) and
  never fails the thread. Its outcome is recorded.
- A thread takes the hooks saved when it starts and keeps them; a change
  applies to new threads only. A changed pre-setup also means a new
  template: the next thread prepares its machine from the start
  (ARCHITECTURE.md, "Machine templates and hooks"). On a template machine
  pre-setup and setup are `skipped` (the template ran them), unless the
  pinned `.agents/setup` differs from the template's.
- Hooks are not secret storage. Every machine of the project can read them
  (`/etc/cube/hooks/`). Use the gateway's placeholders for credentials, never
  a secret in a hook.

## OptChat: `project_hooks` and `project_hooks_write`

Both name the project explicitly, by id or by name (any case); a name two
projects share is refused with their ids. OptChat changes hooks only when
the user asked for it and named the project, and does it itself: a thread
cannot. A thread's report is not the user asking: `project_hooks_write`
refuses in a run that has no message of the user (one started by a
report alone, whatever the report says) and OptChat asks the user instead.
A message of the user counts once it is placed in the run, steered in
between tool calls included.

`project_hooks(project)` is read only:

~~~text
project demo (id 3f0c…); hooks last changed 2026-10-08T12:00:00.000Z
preSetup: 26 bytes, sha256 5be1…; in a machine sha256 9c4d…
```sh
sudo apt-get install -y jq
```
preResume: none

latest outcomes in this project's newest threads (…):
[1a2b3c4d] fix the parser: the saved hooks; pre-setup ok 4.2 s, setup ok 61.0 s, pre-resume absent, resume absent; last 2026-10-08T12:03:00.000Z
[5e6f7a8b] add tests (archived): earlier hooks; pre-setup failed (exit 100) 3.1 s, setup notrun, …

Supported hooks (the only two; nothing else is settable): …
~~~

- The scripts are the stored text, with secret-looking values shown as
  `[redacted]`: well-known token formats, bearer tokens, private keys, the
  values of variables whose name holds SECRET, TOKEN, PASSWORD, PASS, KEY,
  CREDENTIAL or AUTH, and passwords in URLs. The size and sha256 are of the
  stored text, so a save can be verified exactly; "in a machine" is the
  sha256 of the file a machine gets (a `#!/bin/bash` line added when there
  is no `#!`, a final newline), the one `cube hooks` shows.
- "last changed" is when the scripts last changed (on the project page or
  by OptChat); a project without hooks says "never set", and one whose
  hooks have not changed since this was recorded says so.
- Outcomes are what cubed records for each thread: status (`ok`, `failed`
  with its exit code, `skipped`, `notrun`, `absent`), duration and time,
  for the 8 newest threads of the project (archived ones included), and
  whether each ran the hooks saved now or earlier ones. The logs are not on
  the cubed host; they stay in each machine (below).

`project_hooks_write(project, preSetup?, preResume?)` saves and reads back:

- A field not given stays as it is; `""` removes that hook; at least one is
  needed. Unknown fields (a timeout, a working directory) are refused by the
  tool's schema; an over-long script or one with NUL is refused. A refusal
  saves nothing.
- Only the hooks change: not the repositories, the project's revision or
  its check. A project check that runs at the same time keeps them.
- The answer is read back from cubed's registry: `saved preSetup` (or
  `nothing changed` when the scripts were already these), a note when
  pre-setup changed (a new template) or a script looks like it holds a
  secret, then the same text as `project_hooks`. Saving the same scripts
  again changes nothing, so a replayed call is harmless.

`projects` also lists which hooks each project has set.

## Threads: `cube hooks`

```
cube hooks [-n LINES] [--json]
```

In a thread's machine, `cube hooks` shows the four hooks in the order they
run, read only, from files in that machine: the project's pre-setup and
pre-resume (`/etc/cube/hooks/`, written when the machine was made, so the
ones this machine runs), the repository's `.agents/setup` and
`.agents/resume`, each with its size and sha256 (for the project's hooks,
the "in a machine" sha256 of `project_hooks`), its last outcome in this
machine (status, exit code, duration, when) and the last LINES lines of its
log (default 20, at most 200). The outcome is in
`~/.cache/cube/<hook>.status`, written by the preparation and resume scripts
beside the log. A machine made from a template shows pre-setup and setup as
`skipped`, with no log (a template's logs are removed when it is sealed).

A thread cannot read the project's current hooks if they changed after its
machine was made, and cannot change them: hooks run in every new machine of
the project, so a thread (whose agent reads untrusted repository content)
changing them would reach beyond its own machine. Its agent says so and
points the user to the project page or OptChat.

## Limitations

- Two hooks only, with fixed order, triggers, user and directory. A
  repository's own `.agents/setup` and `.agents/resume` are its way to add
  steps of its own.
- No execution history beyond the latest outcome of each hook per thread
  (cubed's record) and the newest log per hook in each machine. Logs are not
  copied to the cubed host and are gone with a machine's disk.
- Changing hooks is not versioned: `project_hooks` shows only the current
  scripts and whether a thread ran them or earlier ones.
