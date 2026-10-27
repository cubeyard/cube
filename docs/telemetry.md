# Telemetry export

Per-call and per-turn records of what the agents' own stores already hold,
without any text of the thread, for offline cost and performance analysis.
It adds no capture: the records are derived from the same stores
[usage](usage.md) reads, and each thread's usage reading (`ledger`) is kept
beside its calls. The code is `packages/server/src/telemetry.ts` (pure) and
`telemetry-export.ts` (reads stores, writes files).

```sh
node packages/server/src/telemetry-export.ts <threads directory> <output directory>
```

Point it at a copy of `CUBED_STATE/threads`, or at cubed's own while cubed is
stopped: an open Pi store belongs to its agent. It never changes a store's
contents or schema, and reads stores of every age (one older than steering has
no `steer` table: its turns' `steers` are null). The threads directory must be
writable all the same: SQLite may leave `-shm` and `-wal` files beside a
`claude.sqlite` it opens read-only, and a Pi store is read from a private copy
(`readStorage`) in a `.read-*` directory it removes again.

The output directory must not exist: it is created 0700 and each file 0600,
none through an existing name or link. It holds `calls.jsonl`,
`turns.jsonl`, `events.jsonl`, `threads.jsonl`, `analysis.json` and a
`MANIFEST.json` with their SHA-256. A thread that cannot be read is listed in
the manifest with its error's code only (`ENOENT`, `ERR_SQLITE_ERROR`); its
message is printed to the terminal, never written.

## What each record holds

| Record | Pi | Claude Code |
| --- | --- | --- |
| call | one `pi.assistant` entry, failed attempts included: tokens (input, output, cache read/write, 1h write, reasoning), request start, duration, catalog estimate, stop reason, response id and model | one `message.id` over its frames: input and cache counts, the first frame's `timestamp`, subagent or main. Output is null: streamed frames do not carry the final count |
| turn | a `pi.user` entry and the responses after it: their sum, first start to last end | a submission: its `result`'s duration, API time, first-token time, rounds, stop and terminal reason, main-loop tokens with the 1h split, retries, steers |
| event | tool result (name, duration, failed), compaction (reason) | `api_retry`, `compact_boundary` (pre/post tokens, duration), `rate_limit_event` (status, window, utilization, overage), process start (version, model alias) |
| thread | the `pi.usage` ledger and its gap to the calls (compaction summaries have no entry) | `claudeLines`' reading and its gap to the calls (compaction and other internal calls, output) |

Only counters, ids, times, model names and fixed reasons are written. A
string is kept only if it is a short identifier (letters, digits, `_ - . : <
>`, not starting with `.`); a model name may also have one inner `/`
(`vendor/model`). Anything else, a path included, is null. Never text, tool
arguments, error messages, paths or titles.

## Reading it

- **null is unknown, never zero.** Sums are null once any part is. A Claude
  Code turn's `retries` is the `api_retry` lines seen, null when there are
  none: a version that never prints them looks the same. A Pi thread's
  requests out when cubed stopped are its `ledger.unknownTurns`, as in the
  usage report.
- **Money is an estimate.** `billedUsd` is always null. Pi prices each call;
  Claude Code prices only its running totals, so its per-call estimate is null
  and the thread's estimate is the ledger's.
- **Cache figures** say how much of a prompt the provider served from its
  cache or wrote to it, not that two requests sent the same bytes. A *cold
  write* is a call after a thread's first that read nothing and wrote some:
  a candidate for a cache break, not a proof. A compaction, an expired TTL, a
  model change or a subagent's first call write cold for good reasons.
- **Failed calls.** Claude Code's error frames carry no counters and stay
  out of the per-model groups (they count in `byAgent.calls`); a frame with
  counters followed by an error frame of the same id is one failed call with
  counters. A Pi catalog that prices a model at $0 cannot be told from no
  price: its calls are unpriced, as in the usage report.
- **Ids are stable** across re-reads: `pi:<thread>:<conversation>:<entry>`,
  `claude:<thread>:<message id>`, turns `claude:<thread>:<submission>`.
  Claude Code frames of one response and repeated `result` lines count once.

## Not covered

Claude Code's output and latency per call (cube does not keep its
`stream_event` lines nor a receive time per line), time to first token for
Pi, the cost of a Pi compaction summary as a call, tool times for Claude
Code, and OptChat's store. A Pi turn starts at each `pi.user` entry; whether
input that steers a running turn is written as one is not checked here, and if
not, its responses count in the turn before. Nothing here has been run on real
thread stores yet.
