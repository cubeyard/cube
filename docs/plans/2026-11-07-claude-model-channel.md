# Claude Code model traffic through cube-gateway

Status: implemented on branch `claude-model-channel` (this plan's PR).

## Goal

Every model request of a claude-code thread goes through `cube-gateway`.
The `claude` child never holds the real credential, only a per-thread
placeholder; the gateway substitutes the host's long-lived token from
`claude setup-token`, turns it back in the answer, and keeps an audit
record of each exchange per thread.

Out of scope this round: a jail for the child, labels, provenance,
masking, Pi threads, subagents, and any change to request bodies.

## Observed on Claude Code 2.1.319 (offline probe, fake upstream)

With `CLAUDE_CODE_OAUTH_TOKEN=cube_ph_claude_…` and
`ANTHROPIC_BASE_URL=http://127.0.0.1:PORT/t/<thread>`:

- the model request is `POST /t/<thread>/v1/messages?beta=true` with
  `Authorization: Bearer <placeholder>` and the `oauth-2025-04-20` beta:
  the subscription's auth mode, unchanged; the base path is kept;
- the bundle's other model routes are `/v1/messages/count_tokens` and
  services cube does not use (files, batches, skills, sessions, …);
- requests that ignore `ANTHROPIC_BASE_URL` go to `api.anthropic.com`
  directly with the placeholder (`/api/claude_cli/bootstrap`,
  `/api/eval/sdk-…`, `/api/event_logging/v2/batch`, `/mcp-registry/…`).
  They are not model traffic; with a placeholder Anthropic refuses them.

## Decisions

1. **Listener: loopback TCP**, `127.0.0.1`, a port the gateway picks on
   its first start and keeps across restarts (the supervisor passes it
   back), named in the ready line. `ANTHROPIC_BASE_URL` takes an HTTP URL;
   Claude Code's only socket transport, `ANTHROPIC_UNIX_SOCKET`, is
   undocumented and switches it into a host-managed-provider mode with
   other effects, which would change more than the transport. Any local
   process can connect, so the placeholder is the authorization: a request
   without the thread's own placeholder is refused. A later jail reaches
   it by sharing loopback or by a socket the same handler serves.
2. **Thread identity in the path**: base URL `…/t/<thread>`; the gateway
   strips the prefix and cubed's `POST /v1/decide` gets
   `channel: "model"` with that thread. cubed allows it only with that
   thread's live `claude` placeholder, to `api.anthropic.com` over HTTPS,
   and returns the token. The 5 s timeout and fail-closed answers stay.
3. **Secret**: `SecretSource` `claude`, host `api.anthropic.com`, model
   channel only (never in a guest's policy). Its value is
   `CLAUDE_CODE_OAUTH_TOKEN` in cubed's environment, the variable
   `claude setup-token` prints. The child no longer inherits it; without
   it a claude-code turn fails before Claude Code starts, naming the fix.
   No fallback to the config directory's login or to an API key.
4. **Routes**: a fixed list in the gateway, `POST /v1/messages` and
   `POST /v1/messages/count_tokens` (query kept). Every other route is
   refused (404, `x-cube-denied`) and recorded.
5. **Streaming**: the answer streams as it arrives. B6's rewriter now holds
   back only a tail that could still begin a substituted value, not a
   fixed window, so an SSE event is never held for the next one.
6. **Audit**: `CUBED_STATE/model-audit.sqlite`, written by the gateway
   only, append-only (triggers refuse UPDATE and DELETE): per exchange the
   thread, route, status, outcome, a header allow-list, and the request
   body and the response as sent to the child (after B6), stored by
   SHA-256. No `Authorization`, no token (requests are recorded before
   substitution, answers after reversal). Refusals are rows too.
   `web_search_tool_result` blocks of an answer are separate events.
   Nothing reads it back as input.
7. **Child environment**: inherited `ANTHROPIC_*` and
   `CLAUDE_CODE_OAUTH_TOKEN` are dropped; cubed sets
   `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`.

## Steps

1. Gateway: rewriter hold-back; model listener (`--model-listen`,
   `--model-audit`); route list; audit store; tests with the test-hooks
   fake upstream (substitution and reversal, missing/wrong placeholder,
   unknown route, SSE in arbitrary chunks, no token in logs, answers or
   the audit file).
2. cubed: `claude` secret and model decisions in `egress-policy.ts`;
   `ModelChannel` (placeholders per thread, base URL); supervisor passes
   the listener and keeps the port; `ClaudeAgent` takes the channel's
   environment; offline env test in `scripts/test-offline.sh`.
3. `scripts/check-claude-model-channel.ts`: a real `claude` through the
   real gateway; offline against a fake TLS upstream, or `--real` for the
   one subscription session (prints routes, statuses and hashes only).
4. Docs: SECURITY.md, ARCHITECTURE.md, gateway README, the docs site's
   Claude Code page.

## Verification

`cargo test -p cube-gateway`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build`, the offline check above, and one real session with the
host's token, or a blocker naming what it needs.

## Audit durability (implemented, round 3)

Before this round the row was written when an exchange ended, from an
in-memory queue, and a write error was only logged: a kill or crash lost
forwarded requests, and the channel failed open. Now:

1. **Start before upstream, fail closed.** After cubed allows a request the
   gateway reads its body whole, up to `MAX_BODY` (32 MiB, Anthropic's own
   request limit; larger is 413, refused and recorded, nothing sent), and
   commits an `exchange` row (thread, route, kept headers, request body by
   hash) with `synchronous=FULL`. It waits at most 2 s for that commit; no
   commit is 503 `x-cube-error`, and nothing goes upstream. A start that
   commits after its request gave up gets an `outcome` of `failed` ("not
   sent") from the writer itself.
2. **Outcome rows.** When the answer ends, breaks or is dropped, an
   `outcome` row (one per exchange) carries `forwarded`, `failed`, `cut` or
   `refused`, the status, the raw and reconstructed answer hashes; events
   as before. The answer still streams unbuffered; it is captured up to the
   same `MAX_BODY` (past it: `response_truncated`).
3. **Failed writes close the channel.** A write that fails stays queued in
   the writer and is retried before any later write; while one is queued
   every start fails, so no new request goes out unrecorded. A forwarded
   answer is never cut for an audit failure.
4. **One writer, then recovery.** The gateway takes an exclusive lock on
   `model-audit.sqlite.lock` before it opens the file and holds it for its
   life; a second gateway on the same audit refuses to start. Under that
   lock, every `exchange` without an `outcome` (the previous gateway was
   killed or crashed) gets `lost`.
5. **Orderly stop inside cubed's bound.** cubed sends SIGTERM and closes
   stdin, then SIGKILLs after 5 s. The gateway stops accepting, gives
   in-flight answers 3 s, drops the rest (recorded `cut`), and waits at most
   1 s for the writer to drain: 4 s in all. A kill past that leaves `lost`
   on the next start, never silence.
6. **Schema version.** `meta(schema=2)`; a file of another schema is refused
   at start rather than written wrongly. `reconstruct` ignores block indexes
   past 4096.

Tests (`cargo test -p cube-gateway`, offline): SIGKILL mid-stream then a
restart shows `lost`; a locked audit gives 503 with nothing upstream, and
the channel recovers when it frees; an outcome that cannot be written holds
later requests at 503 until it is; 413 over the cap; 16 concurrent
exchanges; a second gateway refused on the same audit; SIGTERM mid-stream
exits within the bound with `cut` recorded.
