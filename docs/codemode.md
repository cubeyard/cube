# Codemode boundaries and error contract

Model Python runs only in Monty WASM, inside a fresh disposable Node worker.
The worker has an empty environment; the capability dispatcher and authenticated
operations stay in the parent. A worker is a fault-containment boundary, not a
replacement for the sandbox or an OS-process security boundary.

Use `@pydantic/monty/wasm`, never the native entry point. Our outer Node worker
provides independent termination; Monty's default in-process Node WASM backend
cannot preempt itself. No native addon, glibc requirement, Python installation
or subprocess pool is needed. Unused native optional packages are excluded by
`pnpm-workspace.yaml`. The WASM assets are included in the npm package.

The `code` tool now accepts a **Python function body**, with top-level `await`
and `return`. Old JavaScript snippets must be rewritten; transcript history is
not replayed. Capability names and response field names remain unchanged, but
options use Python keyword arguments and responses use dictionary indexing.
Monty implements a Python subset, not CPython or pip packages. Each call starts
fresh; no persistent REPL or snapshot replay is used.

## Execution limits

Defaults: 64 KiB UTF-8 source, 64 MiB Monty allocator memory, recursion depth 100,
2 seconds of cumulative interpreter execution, 15-minute wall deadline, 64
capability calls, 1,000 interpreter suspensions, 1 MiB serialized arguments,
4 MiB capability responses, and 256 KiB final JSON envelope (including captured
`print()` output). Trusted limit overrides must be known fields and positive,
bounded integers. Worker initialization has a separate 30-second watchdog.

Monty's execution budget pauses during host calls; it does not replenish on
resume. The parent independently enforces the wall deadline, including source
compilation and waiting on host calls. On every exit the parent terminates the
worker, never relying on possibly corrupted WASM finalizers. The allocator cap
is not a process RSS cap; V8 Worker resource limits do not cap WASM memory.
WASM print output is delivered at interpreter suspension/completion, not streamed
continuously while Python computes.

Host capabilities receive an AbortSignal. On failure/cancellation, codemode
aborts active host work and waits up to 10 seconds for it to settle. Sandbox
exec still signals and drains the process tree, not just the shell. If a host
operation ignores cancellation, the invocation fails with `ECODE_UNCERTAIN` and
`completionUnknown: true`; reuse of that dispatcher is blocked until its
outstanding calls settle. Aborting a mutating HTTP request likewise reports
uncertain completion: closing the local connection does not roll back remote
work. Reconcile before retrying; no automatic retry is performed.

Trace observers cannot fail execution or interrupt cleanup. Await every
capability: Python coroutines do not start until awaited. Use `asyncio.gather`
for independent calls. A successful return with outstanding raw host futures
is rejected and those calls are cancelled/drained. Caught guest errors do not
automatically fail the invocation. The authority's identity is stable across
per-invocation UI callbacks, so a new callback cannot bypass uncertain-work blocking.

## `cube.exec`

```python
try:
    return await cube.exec("printf hello; sleep 5", timeoutMs=100)
except RuntimeError as error:
    data = cube.error(error)
    return {key: data[key] for key in ["code", "output", "timeoutMs", "durationMs"]}
```

Monty exceptions carry a type and a string, not custom attributes or subclasses.
The bridge transports allowlisted error data in that string; `cube.error(error)`
decodes it into a dictionary. Uncaught bridge errors retain the same structured
tool details as before; host stacks are never included. For ordinary Python
exceptions the helper returns `{"message": str(error)}`.

- Success: `{ exitCode, output, durationMs }`. Nonzero exit codes are preserved.
- `timeoutMs` is an integer from 1 through 600000, default 120000. It starts
  before wake/setup, with millisecond rather than rounded-second resolution.
  It is a cancellation deadline, **not a guaranteed response latency**:
  process-tree termination and draining streams take additional time.
  `durationMs` reports the actual elapsed duration including that cleanup.
- `output` is combined stdout/stderr in arrival order, decoded as UTF-8.
  It is bounded to 1 MiB of raw bytes. Exactly the limit succeeds; exceeding
  it aborts the command and throws `EOUTPUTLIMIT`, not a generic `aborted`.
- `ETIMEDOUT`, `ABORT_ERR`, and `EOUTPUTLIMIT` include the bounded partial
  output, `outputBytes`, `outputLimitBytes`, `truncated`, `timeoutMs`, and
  `durationMs`. Other exec failures use `EEXEC`. JSON escaping can require
  further truncation when transferring an error; metadata reflects this.
- The tool displays structured errors and retains error data in its details.
  Display truncation is separate from capture/bridge limits. Catch errors in
  code and select the fields you need to keep the final result small.
- For larger output, explicitly redirect to a **workspace** file and read
  selected portions. Codemode does not silently spool to the credentialed host.
- Unknown options (including `timeotMs`) and non-object options are rejected
  before any command is dispatched.

## Files

`Path(path).read_text()` and `Path(path).write_text(content)` use Monty's `os`
callback, which dispatches the existing `fs.readText`/`fs.writeText` capabilities
through `CubeFs`. No host directories are mounted. They preserve Unicode,
emoji, and NUL characters. Relative paths start at `/workspace`; paths and
symlinks still resolve in the sandbox namespace. `write_text` returns Unicode
code points written, not UTF-8 bytes or UTF-16 units.

Only default UTF-8 text operations are enabled. `open`, metadata, directories,
byte I/O, encoding options and ambient OS access fail closed. Text decoding
retains Cube's existing Buffer UTF-8 replacement behavior and line endings;
it is not CPython's strict decoding/universal-newline handling.

Missing-file errors are catchable as `FileNotFoundError`, permission errors as
`PermissionError`, other file errors as `OSError`. `cube.error(error)` carries
`code`, `operation`, and `path`. Missing-file/parent errors use
`ENOENT`. An Incus 404 can also mean the sandbox disappeared; the error message
states this rather than claiming that the file alone is definitely absent.
Other known errors such as `EACCES` are preserved.

`write_text` **does not create parent directories**. Create them explicitly:

```python
from pathlib import Path
await cube.exec("mkdir -p notes")
Path("notes/result.txt").write_text("hello")
return Path("notes/result.txt").read_text()
```

## Temporary portals

`cube.portals.expose(port=3000, name="preview", lifetime="thread")` exposes a temporary route to
a server that is **already listening on `0.0.0.0`**. `port` is an integer from
1 through 65535, `name` is nonblank and at most 80 characters, and `lifetime`
defaults to (and can only be) `"thread"`. Use `cube.portals.list()` to inspect
routes and `cube.portals.remove(port)` to remove one.

This API does not start, kill, or restart the server process and does not edit
service configuration. The thread must be ready when exposing a port. The
returned record includes `supervised: false`; exposure registers a route, not
a successful readiness check. Start the server separately, then share `url`.
Repeating exposure for the same port updates its name and keeps its URL.

Routes survive daemon restarts and expire when the thread is archived or
deleted, or on explicit removal; there is no separate clock-based timeout.
Removing or archiving revokes routing for new requests, not established streams
or the process. Deleting the thread destroys its environment and processes.
Sleeping stops an unsupervised process; restart it yourself after waking.
Portal requests do not wake the thread or restart that process. Keep declared
services for persistent development servers that need automatic supervision.
Temporary portals retain Cube's existing trusted loopback/Tailnet access model;
they do not add per-user authentication or public sharing.

```python
return await cube.portals.expose(port=3000, name="Testportal", lifetime="thread")
```

## Regression coverage

Run with the repository's supported Node version (26+):

```sh
node packages/pi-extension/test/code-mode-test.ts
node packages/pi-extension/test/code-boundaries-test.ts
node packages/pi-extension/test/code-io-test.ts
# These are also included in:
bash scripts/test-offline.sh
```

The boundary suite runs dangerous regressions in externally time-bounded child
processes. It covers default recursion, a larger unsafe recursion override,
suspension exhaustion, synchronous wall expiry, unresolved host calls,
noncooperative cancellation, throwing observers, validation, error transport,
denied OS access, Python dictionary conversion, print bounds and successful
calls after failures. I/O tests cover exact-limit/overflow,
100/1000 ms deadlines, partial output, local process-tree cancellation with no
later write, nonzero exit codes, and contextual file errors.

The jiti regression loads the actual extension through pi's loader and exercises
Monty, shell and file operations. These are regression tests, **not a full
security audit**. Real Incus latency, publication, PR mutations, maximum-load
testing and both-architecture VM acceptance are not covered by the offline tests.
