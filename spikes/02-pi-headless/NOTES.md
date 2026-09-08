# Spike 2 — pi SDK headless: FINDINGS

**Date:** 2026-08-26
**pi:** 0.84.3 (updated from 0.80.2 mid-spike at user request)
**Models:** passed twice — deepseek/deepseek-v4-pro (env key, 12.7s) and
**openai-codex/gpt-5.6-luna** (codex-subscription OAuth, 19.4s; the
user-designated test model going forward).
**Orb:** `orb-spike01` from Spike 1, still running.

## Outcome: PASS

A single `session.prompt()` drove all 7 steps in **12.7s**: write a file
(host-side write tool) → cat it inside the orb (incus-routed bash) → `docker ps`
inside the orb → edit host-side → cat inside the orb shows the edit →
`echo > from-orb.txt` inside the orb → read tool (host-side) reads it back.
**Same workspace, both directions across the boundary, zero sync steps** — the
shift=true mount does all the work.

| Requirement | Result |
|---|---|
| `createAgentSession` headless (no TUI) | ✅ |
| bash routed into orb via `incus exec` | ✅ hostname=orb-spike01, uid=dev, inner docker reachable |
| read/write/edit on host workspace path | ✅ files appear in orb instantly |
| orb-written files visible to host tools | ✅ owned `diz:diz` on host (shift idmap) |
| Event stream rich enough for a web UI | ✅ see below |

## Event stream richness (500 events for the 7-step run, `events.jsonl`)

- **Tool argument deltas while streaming:** 184 `message_update` events with
  `toolcall_delta` (+ `toolcall_start`/`toolcall_end`). A UI can render tool
  calls as they are typed.
- **Live bash output:** `tool_execution_update` events carry an accumulating
  `partialResult.content` snapshot per output chunk.
- **Edit diffs:** the edit tool's result `details` contains a human-readable
  `diff`, a unified `patch`, and `firstChangedLine`. Nothing to compute
  ourselves.
- Clean lifecycle framing: `agent_start/turn_start/message_start…end/agent_end`
  (+ `agent_settled`, new in 0.84.x).

## How the wiring works (carry into cubed)

- `createAgentSession({ cwd: HOST_WS, tools: [...builtins, "bash"],
  customTools: [createBashToolDefinition(HOST_WS, { operations })] })`.
- **Gotcha:** the `tools` allowlist filters *custom* tools too — "bash" must be
  in the list; the custom definition then **shadows the built-in by name**
  (custom tools are registered after built-ins). Omit it and the model
  silently gets no bash at all (first run failed exactly this way).
- Bash op = `incus exec orb-spike01 --env TERM=dumb -- su - dev -c
  'cd <guestCwd> && <command>'`.
  - **Must be `su - dev`, not `incus exec --user 1000`**: only a login shell
    picks up dev's supplementary groups; without them the inner docker socket
    is `permission denied`.
  - cwd is mapped host→guest (`HOST_WS` ↔ `/workspace`); paths outside the
    workspace are rejected.
  - **No env passthrough** — host env/credentials must never leak into the
    sandbox. cubed will curate an explicit allowlist.

## pi 0.84.3 API notes (vs the 0.80.x docs)

- `AuthStorage` / `ModelRegistry` are gone from the public SDK surface.
  Replacement: `const modelRuntime = await ModelRuntime.create()`;
  `modelRuntime.getAvailable()` / `.getModel(provider, id)`;
  pass `{ modelRuntime }` to `createAgentSession`.
- Event union unchanged (`tool_execution_*`, `message_update` etc.) — the
  risk-register item "pi is v0.x, breaking changes" is real but the facade
  layer needed is thin.

## Auth/provider state on this host (feeds Spike 3)

- `~/.pi/agent/auth.json` now holds an **`openai-codex` OAuth credential**
  (user logged in with their Codex subscription during this spike). The OAuth
  path works headlessly: `ModelRuntime.create()` picked it up with no code
  changes and `gpt-5.6-luna` ran the full 7-step prompt cleanly. The event
  stream over the `openai-codex-responses` API is just as UI-rich (toolcall
  deltas, streamed bash output) and additionally emits
  `thinking_start`/`thinking_end`.
- **Luna (`openai-codex/gpt-5.6-luna`) is the test model going forward**
  (user's call) — it's first in the harness preference list.
- `OPENROUTER_API_KEY` is nearly out of credits (402 at 64k max_tokens) —
  first run died silently: `prompt()` resolved in 0.5s and the only trace was
  `stopReason:"error"` + `errorMessage` inside message events. **cubed must
  surface per-message `errorMessage`, or provider failures look like instant
  empty answers.**
- `DEEPSEEK_API_KEY` worked; deepseek-v4-pro drove all 7 tool calls correctly.
- Spike 3's token-refresh test can now run against the codex OAuth credential.

## Loose ends / caveats

- Abort/timeout kills the local `incus exec` client (SIGKILL); the remote
  process may be orphaned in the orb. For cubed, use the Incus REST websocket
  exec (control channel can signal the remote PID). Not exercised here.
- This shell predates `diz`'s incus-admin membership, so `run.sh` wraps the
  harness in `sg incus-admin`. Fresh logins won't need it. (Cosmetic side
  effect: host files created by the harness get group `incus-admin`.)
- `notes/` dir: the write tool auto-created intermediate dirs — no extra work
  needed for nested paths.

## Files

- `harness.ts` — the headless harness (this is proto-cubed-harness code).
- `run.sh` — runner (`sg incus-admin` + Node 25 native TS).
- `node_modules/@earendil-works/pi-coding-agent` — symlink to the global
  install (gitignored).
- `events.jsonl` — full event capture of the passing run (gitignored).

## Consequence

Harness pattern confirmed → proceed to **Spike 3 (pi auth/session refresh in a
long-lived daemon)**. On this host that spike must start with a real `pi`
login (auth.json is empty), then test token refresh + expiry surfacing.
