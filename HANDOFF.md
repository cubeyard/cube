# Handoff

Architecture replacement is implemented in this working tree. The ordinary
HTTP conversation path now uses an in-process pi-durable 1.0.1 Harness + SQLite,
with startup activation and snapshot SSE. Pi's tools reach the runner only
through the thread `Workspace` and its lease. The old execution stack has been removed.
Current runner execution is trusted, not sandboxed; native sandboxing remains
undecided. No migration of old data is required or implemented.

Verified locally on Linux:

- `pnpm typecheck`: zero TypeScript/Svelte errors or warnings; `pnpm lint` passed.
- `pnpm test`: all offline suites, including Pi over the Workspace with a fake
  runner (`durable-agent-test.ts`) and Pi's own threshold compactions and a
  reset through the thread history, across a reopen (`pi-compaction-test.ts`,
  faux model with a small context window); `pnpm build` passed.
- `scripts/test-node-transport.sh`: fmt, clippy, Rust tests, actual Iroh shell
  calls, four SIGKILL recovery boundaries, single writer exclusion, stable
  invocation identity and one effect, product startup activation, SSE snapshots,
  reconnect, concurrent followup dedup/conflict, stop and model-choice persistence,
  one codemode script whose nested write/edit/bash/read reach the runner under
  their nested keys, a claude · max thread through a fake `claude`, and the
  Workspace contract in loopback and direct mode. All of it runs on one Linux
  machine against a disposable local runner; a runner on a separate machine
  (Linux or macOS) has not been accepted on this branch.
- `bash scripts/check-claude-mod.sh` with Claude Code 2.1.288: strict
  validation, 8/8 mod tests against the engine (allow-listed tools, MCP and
  unknown tools refused, built-in subagents only) and tsc. No model call.
- Chromium: ordinary new-thread submission produced runner output 93; host
  stop/restart reconnected with one user message and one tool result. Desktop,
  390×844 layout and the no-available-runner dialog were inspected.
- Provider auth: real Pi credential store with a controlled provider; key,
  OAuth browser/device/callback, cancellation, safe errors, stale prompt rejection,
  live catalog updates, login/logout persistence and cleared pending login on restart.
  Chromium exercised key entry/error/success/disconnect, browser-code completion,
  device-code presentation and cancellation at desktop and 390px widths.

These tests use a controlled model and disposable state. Paid-model integration,
power-loss durability and separate-machine Linux/macOS lifecycle acceptance are
not established by them. Newer macOS runner support remains intact.

Operators prepare a repository template and enroll immutable runners. Each runner
leases one separate active-thread workspace at a time and is reusable after
archive; Git allocations fetch the checked primary branch into runner-owned
state, pin and journal its exact OID, and never use stale template HEAD as an
offline fallback. Dirty worktrees are retained. This is collision isolation, not a
security sandbox. Workspace transfer, authenticated Git mutation, portals and
thread-to-thread tools are not exposed. Pi's saved model choice now controls
reopening even when the registry's initial model or the selected model disappears
from the catalog; unavailable models are not silently replaced.
Stop aborts Pi's run and cancels a running runner command (process-group
SIGKILL through `exec.cancel`). A host shutdown does not cancel a direct `bash`
command; the next process reattaches to the same runner operation. Codemode's
nested commands are cancelled on shutdown, since codemode is never rerun.

State schema is 101. The supervisor refuses to update a schema 100 installation
in place, and cubed refuses to open a thread directory that still holds the old
Pi store (`session/`, `owner.sqlite`) instead of running its first message
again; existing installations need the fresh `CUBED_STATE` reset in
DEVELOPING.md. A second cubed on the same state refuses to start while the
first one's workspace socket answers. The file tools (Pi and the Claude Code mod
alike) read whole files up to 2 MiB; larger files are for bash.
Do not equate these constraints with a native sandbox implementation.

A thread can run on Claude Code instead ("claude · max" at creation): cubed
starts the unmodified `claude` binary with the user's own login and cube's mod
(`packages/claude-mod`), which sends Bash, Read, Write and Edit to the thread
Workspace keyed by `tool_use_id`. The child gets an allow-listed environment
(no `ANTHROPIC_*`, Bedrock/Vertex switch or cubed provider/Git/cloud
credentials), no user settings or MCP servers (`--setting-sources ""`,
`--strict-mcp-config`), and only the mod's allow-listed tools (`--tools` and the
mod's own `tool.call` allow-list; non-built-in and isolated subagents are
refused). A stop sends the stream-json interrupt and cubed cancels the turn's
open Bash commands on the runner at once: Claude Code answers an interrupt by
rejecting the tool use without aborting the mod's hook. cubed also cancels when a
stop has to kill the child, when it dies mid-turn and on close, and a child that
ignores SIGTERM gets SIGKILL. cubed hands Claude Code a private copy of the mod
under `CUBED_STATE/run/claude-mod`, because Claude Code writes type declarations
into a plugin folder it loads. cubed's own lease cannot be renewed or released
over the workspace routes. A turn cut off by a cubed restart is not continued.

Live run on 2026-10-03 (Linux, disposable state, a local cube-runner 0.3.0,
the real `claude` 2.1.288 with the maintainer's Max login): a claude · max
thread used Write, Read, Edit and Bash in the runner workspace, a
general-purpose subagent's Bash ran there too, AGENTS.md was read from the
runner, nothing was written into Claude Code's host directory, and Claude Code
reported `apiKeySource: "none"` (subscription login, no API key). A follow-up
after a model change resumed the session on the new model (sonnet, then opus).
Stop rejected a running `sleep 90` and cancelled it on the runner (its later
write never happened). The automated suites still use a fake `claude`; this
live run is a manual script, not part of `pnpm test`. Not verified live:
`--resume` after a cubed restart, the SIGTERM/SIGKILL fallback, isolated or
plugin subagents being refused, and runners on separate machines.

GUI provider settings use Pi's public Models login/logout/refresh APIs and the
existing host credential store. Browser/device login, key entry, cancellation,
status and disconnect are supported wherever Pi exposes that interaction, except
Anthropic's Claude Pro/Max OAuth, which is not offered to Pi.
Providers with ambient-only auth still require host configuration. A host restart
discards unfinished login interactions, not saved credentials. Live provider
OAuth acceptance remains distinct from controlled-provider integration tests.

Known gaps: pi-codemode 1.0.1 has no stack or CPU-slice limit, so a spinning
script holds a cubed CPU core until its wall deadline (15 minutes by default);
cube exposes no reset or manual compaction (Pi's reset is covered through its
API only), and an overflow compaction has no test; pi-durable's `onReport` is
not wired to any log; macOS runner file paths and the launchd stop timeout against
the 600-second command bound are untested; runner output is only available
after a command finishes. AGENTS.md still describes Pi as an AgentHarness and
needs the maintainer's update to pi-durable; docs/architecture-tour-notes.md is
marked historical.

The fresh-start workflow is in DEVELOPING.md. No push, deployment, release or
destruction of an existing installation was performed. Review the local diff
before shipping; this is implementation evidence, not production sign-off.
