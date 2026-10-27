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
stopped: an open Pi store belongs to its agent. It opens `claude.sqlite`
read-only and reads a Pi store from a private copy (`readStorage`). It writes
`calls.jsonl`, `turns.jsonl`, `events.jsonl`, `threads.jsonl`,
`analysis.json` and a `MANIFEST.json` with their SHA-256, mode 0600, and
prints the analysis.

## What each record holds

| Record | Pi | Claude Code |
| --- | --- | --- |
| call | one `pi.assistant` entry, failed attempts included: tokens (input, output, cache read/write, 1h write, reasoning), request start, duration, catalog estimate, stop reason, response id and model | one `message.id` over its frames: input and cache counts, the first frame's `timestamp`, subagent or main. Output is null: streamed frames do not carry the final count |
| turn | a `pi.user` entry and the responses after it: their sum, first start to last end | a submission: its `result`'s duration, API time, first-token time, rounds, stop and terminal reason, main-loop tokens with the 1h split, retries, steers |
| event | tool result (name, duration, failed), compaction (reason) | `api_retry`, `compact_boundary` (pre/post tokens, duration), `rate_limit_event` (status, window, utilization, overage), process start (version, model alias) |
| thread | the `pi.usage` ledger and its gap to the calls (compaction summaries have no entry) | `claudeLines`' reading and its gap to the calls (compaction and other internal calls, output) |

Only counters, ids, times, model names and fixed reasons are written; a
string that is not a short identifier is dropped. Never text, tool
arguments, error messages, paths or titles.

## Reading it

- **null is unknown, never zero.** Sums are null once any part is.
- **Money is an estimate.** `billedUsd` is always null. Pi prices each call;
  Claude Code prices only its running totals, so its per-call estimate is null
  and the thread's estimate is the ledger's.
- **Cache figures** say how much of a prompt the provider served from its
  cache or wrote to it, not that two requests sent the same bytes. A *cold
  write* is a call after a thread's first that read nothing and wrote some.
- **Ids are stable** across re-reads: `pi:<thread>:<conversation>:<entry>`,
  `claude:<thread>:<message id>`, turns `claude:<thread>:<submission>`.
  Claude Code frames of one response and repeated `result` lines count once.

## Not covered

Claude Code's output and latency per call (cube does not keep its
`stream_event` lines nor a receive time per line), time to first token for
Pi, the cost of a Pi compaction summary as a call, tool times for Claude
Code, and OptChat's store.
