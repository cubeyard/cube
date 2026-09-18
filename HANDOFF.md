# Handoff

Architecture replacement is implemented in this working tree. The ordinary
HTTP conversation path now uses in-process Pi AgentHarness + SQLite, with
startup activation and snapshot SSE. The old execution stack has been removed.
Current runner execution is trusted, not sandboxed; native sandboxing remains
undecided. No migration of old data is required or implemented.

Verified locally on Linux:

- `pnpm typecheck`: zero TypeScript/Svelte errors or warnings; `pnpm lint` passed.
- `pnpm test`: all 12 offline suites; `pnpm build` passed.
- `scripts/test-node-transport.sh`: fmt, clippy, Rust tests, actual Iroh shell
  calls, four SIGKILL recovery boundaries, single writer exclusion, stable
  invocation identity and one effect, product startup activation, SSE snapshots,
  reconnect, concurrent followup dedup/conflict, stop and model-choice persistence.
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
Stop aborts Pi's run and polling; an already accepted remote shell command may
continue until its runner deadline. Remote cancellation is not wired to Pi abort.
Do not equate these constraints with a native sandbox implementation.

GUI provider settings use Pi's public Models login/logout/refresh APIs and the
existing host credential store. Browser/device login, key entry, cancellation,
status and disconnect are supported wherever Pi exposes that interaction.
Providers with ambient-only auth still require host configuration. A host restart
discards unfinished login interactions, not saved credentials. Live provider
OAuth acceptance remains distinct from controlled-provider integration tests.

The fresh-start workflow is in DEVELOPING.md. No push, deployment, release or
destruction of an existing installation was performed. Review the local diff
before shipping; this is implementation evidence, not production sign-off.
