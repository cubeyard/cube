# Usage and cost

cube reports what its agents consumed: tokens per thread, project and model,
OptChat's own, and an estimated cost. Every figure comes from a record an
agent already keeps; cube adds no meter of its own and never calls a provider's
billing API. The code is `packages/server/src/usage.ts` (what each figure
means, pure) and `usage-service.ts` (reading the stores).

## What the numbers are

- **Tokens** are what the provider reported to the agent: input, output,
  cache read, cache write and, where the record splits it out, reasoning (a
  part of output).
- **Estimated cost** is never a charge. Pi prices each response at its model
  catalog's rates (pi-ai's `calculateCost`) in the commit that records the
  response. Claude Code prices its own calls at its built-in list prices
  (`costBasis: "list"`) or managed prices.
- **Billed cost** is always null. No provider reports charges to cube.
  A claude · max thread runs on the user's subscription: its estimate is
  what the calls would cost at Claude Code's prices, not what was paid. A Pi
  provider reached through a subscription login is estimated at catalog
  prices too.
- **Unpriced tokens.** Tokens with no price behind them count as unpriced,
  never as $0. Two cases: a Pi model whose catalog has no rates (a custom or
  local model, a model without pricing), and a Claude Code model it reports
  with `costBasis: "unknown"`. A spend is "≈ $X est.", "≈ $X est. + N
  unpriced tokens" or "cost unknown (N unpriced tokens)".
- **Unknown usage** is not zero either. A subject's `coverage` is
  `complete` (every model call cube knows of has a record), `partial` (some
  have none: `unknownTurns`, or `incomplete` with the reason in `notes`) or
  `unavailable` (nothing could be read now). Totals count unavailable
  subjects and unknown turns separately and never fold them in as zero.

Each line keeps its provenance: `source` (`pi`, `claude-code`, `optchat`,
`optchat-compactor`), `provider`, `model`, the pricing `basis` and, for Pi
models, the catalog's current rates for reference (`pricing`: the estimate used
the rates at record time, which may differ).

## Sources

**Pi threads.** pi-durable keeps a ledger per conversation, the `pi.usage`
document, keyed `provider/model`. Pi adds a response's usage in the same
commit that appends the assistant entry, for every response: retried errors and
aborted partials included, compaction summaries too. So each response is
counted once, and a restart or a replayed task does not add it again.
`Harness.usage()` sums every conversation. cubed reads it from the open agent;
when the agent closes (archive, shutdown, a machine reboot) its last reading
is kept. An archived thread's store is read again from a read-only snapshot
(`readStorage` in durable-agent.ts, as the history tool reads it: the retained
original is never migrated or checkpointed; a store of another schema version
or over 64 MiB is refused and its last reading shown). A thread that is open but whose agent is not (its machine is
starting or failed) shows its last reading (`read: "snapshot"`) or, if it never
had one, `unavailable`: only the agent may open its store, whose lease is
its lock.

**Claude Code threads.** cubed keeps every stream-json message Claude Code
printed (`claude.sqlite`). The `result` that ends each turn carries
`modelUsage`: running totals per model for every model call of the process
(main loop, subagents, compaction), cumulative across the turns of one
process (Agent SDK types, `@anthropic-ai/claude-agent-sdk` 0.3.x, checked
on 2026-10-06). A turn's usage is the increase over the previous result of the
same process. Results are counted once by `uuid`. Subagent calls are inside
`modelUsage` already, so assistant messages, which also carry per-call usage
(not final while streaming), are never added to it.

Every process after a thread's first is started with `--resume` (after a
model change, the idle timeout or a cubed restart) and may begin from the
totals the session's transcript saved, or from zero. cube decides from the
first result of such a process, whatever session id it reports: of the
candidates "every earlier turn's totals" and "the previous process's last
totals", it takes the largest that the result holds in every counter and whose
increase still covers the turn's own main-loop usage (`result.usage`);
otherwise the process started from zero. A wrong choice undercounts, never
overcounts. The choice is recorded in `notes`. A running total that goes down
is counted from zero after it. A turn that ended without a result (stopped and
killed, the child crashed, cubed stopped mid-turn) or with zeroed totals after
a failure has unknown usage and counts in `unknownTurns`; if the next resumed
process carried that turn's calls in its saved totals, they are counted with
the next turn and the unknown count overstates the gap.

**OptChat.** The chat's own model calls are in its Pi store's `pi.usage`
(source `optchat`). The compactor's calls run beside Pi, so OptChat counts
each reply, failed ones included, in its `cube.optchat.usage` document (source
`optchat-compactor`, with a call count), counting from the first open of a
cube that does this (`since`). A chat whose tree already held nodes the
compactor built then (not ones whose text fit as it was, judged by the
current node limit) has `incomplete`
set: those earlier calls are unknown.
The threads OptChat started are ordinary threads; a global report shows their
sum (`optchatThreads`) but adds it to the total only once, under the threads.

## Persistence

`CUBED_STATE/usage.sqlite` keeps the last reading of every thread and of
OptChat. It is a derived cache, not a journal: each row can be read again from
the thread's own store, which archive keeps. It serves what cannot be read now
and spares re-reading an unchanged archived store (keyed by the store's size
and modification time). Deleting it loses only the last readings of Pi
threads whose agents are not open at that moment. Bumping `LEDGER_VERSION`
makes old rows be read again. It is not part of the registry schema.

## Access

Read-only, behind the same access boundary as every other cubed route (cubed
has no application-level user authentication; keep it on loopback, a private
network or an authenticated proxy).

- `GET /api/usage` — every thread (archived included) and OptChat:
  `totals`, `projects`, `models`, `threads`, `optchat`, `optchatThreads`,
  `billed` and `notes`. `?project=<id>` limits it to one project's threads.
- `GET /api/threads/<id>/usage` — one thread, archived ones too.
- OptChat's `usage` tool: the same as text, for everything, a project (name
  or id) or a thread (id or its first characters).
- UI: the thread strip shows the thread's estimate (details in its title),
  the project page and the system page have a usage panel (by project, model
  and thread, OptChat's own).

## Not covered

- **Billed amounts** from any provider, and a reconciliation with invoices.
- **Responses lost to a crash.** Pi records a response when it ends; one cut
  off by a cubed crash mid-stream is not in the ledger, and a provider may
  still bill it (ARCHITECTURE.md, "Action, result, resume").
- **Mixed pricing in one Pi model line.** Pi's ledger sums per model: if the
  catalog priced some of a model's responses and not others, the line counts
  as priced and the unpriced responses add $0 to it.
- **Free models.** A catalog price of $0 (a local model) cannot be told from
  a missing price in Pi's ledger; its tokens count as unpriced. The usage
  panel shows when the catalog lists no price for a model now.
- **Claude Code's basis per turn.** `costBasis` is the basis of a model's
  latest request, so a turn mixing priced and unpriced requests of one model
  takes the basis of its last.
- **Model names** are the strings each agent reports: Claude Code's raw model
  ids (not its `canonicalModel`), so one model may show under two names.
- **Pi tool usage** (`pi.usage.tools`): no cube tool reports usage today; it
  is not shown.
- **Claude Code internals** outside its query pipeline (its permission
  classifier, token-count probes), which `modelUsage` excludes; older Claude
  Code versions without `modelUsage` (their turns count as unknown); a per-turn
  or per-subagent breakdown (only per-model totals are reported).
- **Pi threads whose agent never opened since this change** show
  `unavailable` until it opens or the thread is archived.
- **Time series.** Totals are lifetime totals per thread; there is no per-day
  view.
- **Savings.** cube measures no savings (prompt caching, cheaper models);
  cache-read tokens are reported, nothing is claimed about what they saved.
