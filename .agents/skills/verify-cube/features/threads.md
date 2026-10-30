# Threads

A thread is a task with its own machine. The user starts one from a project with a first message; the machine starts with the project's checkout in `/workspace`, the agent runs tools there, later messages continue in the same machine, and archive releases it, keeping the disk when it holds uncommitted or unpushed work.

## Sub-features

- `thread-start` starts a thread from the project page's `new thread` dialog.
- `thread-tool` runs a tool call in the thread's `/workspace` and shows its output.
- `thread-continue` continues in the same machine with a second message.
- `thread-archive` archives from the thread bar's details, with confirmation.

## How to get to it (user POV)

- A project page (`#/projects/<id>`), then `new thread`.
- Press `n` outside a text field, or `new thread` in the index.
- The thread opens at `#/t/<id>`.

## Driving it with verify-cube

Preconditions:

- `doctor` is all `ok:`; the seeded project `demo` is ready.

- **Open the dialog.** On `#/projects/<demo>` choose `new thread`. `dialog.new-thread-dialog` opens. Fill `first message` with `tool {"name":"bash","args":{"command":"cat README.md && git log --format=%s -1 && printf verify-cube > proof.txt"}}`. Captured as `01-new-thread`.
- **Start.** Choose `start thread`. The URL becomes `#/t/<id>`; the transcript shows the bash call and `result: # demo`, `seeded by verify-cube`, `seed`. Captured as `02-first-turn`.
- **Continue.** Send `tool {"name":"bash","args":{"command":"cat proof.txt"}}`. The reply is `result: verify-cube`. Captured as `03-second-turn`.
- **Side effect.** `RUN/scratch/machines/<id>/workspace/proof.txt` holds `verify-cube`; `history.json` is `/api/threads/<id>/history`.
- **Archive.** Choose `details` (`.strip-details-key`), `archive thread`, then `confirm: archive this thread`. The page leaves `#/t/<id>`. Captured as `04-archived`.
- **Proof.** `threads-after-archive.json` (`/api/threads`) no longer has the thread, and its disk is still there because `proof.txt` is uncommitted.

Run: `.agents/skills/verify-cube/verify-cube run thread`.

## Gotchas

- The archive control sits behind the thread bar's `details` key.
- A thread at work refuses archive; wait for `.composer[aria-busy=false]` first.
- Tool calls run in a local guest as your user, not in a VM: this proves cubed, Pi and the guest helper, not machine isolation.
