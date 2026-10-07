# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who self-host coding agents and use a browser to start work, leave,
and return to results. They understand command-line setup but should not need
to understand internal scheduling or storage to read a thread.

## Product Purpose

Give an agent a task and a machine of its own, then retain its actions and results
across browser disconnects and host restarts. Pi owns durable execution; cubed
owns the product. The user-facing unit is a thread.

## Operating Context

- Desktop is the primary workplace; phone remains readable and answerable.
- Threads outlive the tab. Reconnect restores the saved transcript and current
  partial response without appending duplicate turns.
- Each thread's tools run in its own virtual machine on a runner; that machine
  is the thread's sandbox, reaching only HTTP/HTTPS through cube's gateway.
  The runner host itself is not a sandbox. Operators prepare and enroll runners.
- The browser host has no built-in user authentication and must remain private.

## Capabilities and Constraints

Projects retain repository configuration and host-side access checks. A new
thread leases one available runner from the installation-wide pool and gets
its own virtual machine there, with `/workspace` pinned to the commits its
repositories' branches have when it starts; an idle archived thread returns
that lease. The thread supports streaming chat, model choice, bounded shell tools, stop, rename and archive.
Provider and GitHub credentials remain on the host: the machine sees only a
placeholder, and `gh` and `git push` work through the gateway. A machine the
agent touched is retained at archive.

OptChat and threads can write work artifacts: documents with revisions the
user reads, comments on (comments reach the author as a message, never
interrupting a working thread) and acts on through confirmed, typed actions
(a pull request merge). They are work surfaces, not tasks.

A project change never reuses another project's machine. Remote workspace
transfer, service portals, thread-to-thread tasks, machine snapshots and
per-thread network policy are not currently exposed. Do not show controls or
copy promising those capabilities. Older registries and execution stacks are
not migrated.

The project switchboard exposes installation-global operator truth for trusted
runners: current global allocation, latest authenticated contact, last successful
contact and active and retained machine counts when reachable. `unreachable` means
the latest check failed; `stale` requires seven continuous days of failed checks.
Retiring is permanent, explicitly confirmed, fail-closed against the global
allocation snapshot and active runner work, and removes capacity while retaining
audit and runner-side evidence.

## Design and voice

Preserve the instrument-panel visual world in DESIGN.md: calm lowercase labels,
compact physical controls, purposeful status lamps, readable transcripts and
accessible keyboard interactions. This is an operating tool, not a marketing
page. Show concrete errors and retry/reconnect behavior rather than hiding
failures behind a spinner. Keep navigation stable while work streams.
