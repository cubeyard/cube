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
  runner (`durable-agent-test.ts`); `pnpm build` passed.
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
refused). When a stop has to kill the child, when it dies mid-turn and on
close, cubed cancels the turn's open Bash commands on the runner itself, and a
child that ignores SIGTERM gets SIGKILL. cubed's own lease cannot be renewed or
released over the workspace routes. A turn cut off by a cubed restart is not
continued.

None of this has run against the real Claude Code with a real model or a Max
login. It is tested only with a fake `claude` that checks the flags, speaks
stream-json and runs the mod's tool functions, and with `claude plugin
validate`/`claude plugin test`, which call no model. Not verified in a real
session: that `$.http.fetch` with `socketPath` reaches cubed's socket; that
Claude Code accepts the mod's Bash/Read/Write/Edit result objects and does not
trip its own read-before-write or file-existence checks first; that `-p`
honours the stream-json `interrupt` and keeps one session across `--resume`
with a new `--model`; that `--setting-sources ""`, `--tools` and
`--strict-mcp-config` behave as documented in 2.1.288; that subagents' tool
calls pass through the mod's hooks; and that the Max subscription, not API
billing, is what a turn uses.

GUI provider settings use Pi's public Models login/logout/refresh APIs and the
existing host credential store. Browser/device login, key entry, cancellation,
status and disconnect are supported wherever Pi exposes that interaction, except
Anthropic's Claude Pro/Max OAuth, which is not offered to Pi.
Providers with ambient-only auth still require host configuration. A host restart
discards unfinished login interactions, not saved credentials. Live provider
OAuth acceptance remains distinct from controlled-provider integration tests.

Known gaps: pi-codemode 1.0.1 has no stack or CPU-slice limit, so a spinning
script holds a cubed CPU core until its wall deadline (15 minutes by default);
Pi's compaction/reset history path is untested; pi-durable's `onReport` is not
wired to any log; macOS runner file paths and the launchd stop timeout against
the 600-second command bound are untested; runner output is only available
after a command finishes. AGENTS.md still describes Pi as an AgentHarness and
needs the maintainer's update to pi-durable; docs/architecture-tour-notes.md is
marked historical.

The fresh-start workflow is in DEVELOPING.md. No push, deployment, release or
destruction of an existing installation was performed. Review the local diff
before shipping; this is implementation evidence, not production sign-off.
