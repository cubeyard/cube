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

## Audit durability (proposed, not implemented)

Today the audit row is written when an exchange ends, by a writer thread
fed from memory, with `synchronous=NORMAL`, and a write error is only
logged. So it fails open:

| event | today |
| --- | --- |
| gateway SIGKILL, crash, power loss mid-stream | the forwarded request has no row at all |
| SIGTERM or stdin EOF | tasks aborted and the process exits; queued rows lost |
| a write fails (disk full, I/O error) | logged; requests go on forwarding unrecorded |
| the writer thread dies | logged per exchange; requests go on |

Proposed, narrow, append-only throughout:

1. **Start before upstream.** After cubed allows a request, the gateway reads
   its body (bounded, 32 MiB, else 413), writes a `start` row with the
   thread, route, kept headers and request body hash in its own committed
   transaction (`synchronous=FULL`), and waits for that commit (2 s) before
   sending anything upstream. No commit means 503 `x-cube-error: model
   audit unavailable`, and nothing is sent. Answers still stream unbuffered;
   only the request is read whole first (Claude Code sends whole JSON
   bodies).
2. **End row.** When the answer ends, breaks or is dropped, an `end` row
   names its start and carries the outcome, status, raw and reconstructed
   answer hashes and events. Refusals stay single rows.
3. **Recovery.** On start the gateway appends `end(outcome='lost', reason='the
   gateway stopped before the answer ended')` for every start without an
   end, so a crash shows as a lost exchange, never as silence.
4. **Failing writes close the channel.** A failed `end` write latches the
   channel: later requests get 503 until a write succeeds again. A forwarded
   answer is never cut for an audit failure, but no new one starts unrecorded.
5. **Orderly stop.** On SIGTERM or EOF: stop accepting, give in-flight answers
   a bound (10 s) to end, record the rest as `cut`, then close and join the
   writer before exiting.

Cost: one fsync'd write and the request body read before each upstream
request (local, about milliseconds), and a `start`/`end` pair per exchange
instead of one row. Tests: SIGKILL mid-stream then restart shows `lost`; a
read-only or full audit file refuses with 503 and sends nothing upstream;
SIGTERM mid-stream records `cut`.
