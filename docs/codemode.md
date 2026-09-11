# Codemode boundaries and error contract

Model JavaScript runs only in QuickJS, inside a fresh disposable Node worker.
The worker has an empty environment; the capability dispatcher and authenticated
operations stay in the parent. A worker is a fault-containment boundary, not a
replacement for the sandbox or an OS-process security boundary.

## Execution limits

Defaults: 64 KiB UTF-8 source, 64 MiB QuickJS memory, 128 KiB QuickJS stack,
2-second guest CPU slices, 15-minute wall deadline, 64 capability calls,
10,000 promise jobs, 1 MiB serialized arguments, 4 MiB capability responses,
and 256 KiB final JSON envelope. Trusted limit overrides must be positive,
bounded integers. Worker initialization has a separate 30-second watchdog.

The interrupt handler checks a monotonic wall deadline as well as the CPU
slice. The parent independently enforces the wall deadline. Promise-job batches
yield, without replenishing the current CPU budget. On every exit, the parent
terminates the worker: it never relies on more guest jobs or possibly corrupted
WASM finalizers to clean up a failed runtime.

Host capabilities receive an AbortSignal. On failure/cancellation, codemode
aborts active host work and waits up to 10 seconds for it to settle. Sandbox
exec still signals and drains the process tree, not just the shell. If a host
operation ignores cancellation, the invocation fails with `ECODE_UNCERTAIN` and
`completionUnknown: true`; reuse of that dispatcher is blocked until its
outstanding calls settle. Aborting a mutating HTTP request likewise reports
uncertain completion: closing the local connection does not roll back remote
work. Reconcile before retrying; no automatic retry is performed.

Trace observers cannot fail execution or interrupt cleanup. Await every
capability. Unawaited calls remain attached until they settle, but an unawaited
rejection is reported in traces and does not necessarily reject a successful
program return. Caught guest errors do not automatically fail the invocation.

## `cube.exec`

```js
try {
  return await cube.exec("printf hello; sleep 5", { timeoutMs: 100 });
} catch (error) {
  return {
    code: error.code,
    message: error.message,
    timeoutMs: error.timeoutMs,
    durationMs: error.durationMs,
    output: error.output,
    truncated: error.truncated,
  };
}
```

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

`cube.fs.readText(path)` and `cube.fs.writeText(path, content)` preserve Unicode,
emoji, and NUL characters. Paths are still resolved in the sandbox namespace.
File errors carry `code`, `operation`, and `path`. Missing-file/parent errors use
`ENOENT`. An Incus 404 can also mean the sandbox disappeared; the error message
states this rather than claiming that the file alone is definitely absent.
Other known errors such as `EACCES` are preserved.

`writeText` **does not create parent directories**. Create them explicitly:

```js
await cube.exec("mkdir -p notes");
await cube.fs.writeText("notes/result.txt", "hello");
```

## Temporary portals

`cube.portals.expose({ port, name, lifetime? })` exposes a temporary route to
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

```js
return await cube.portals.expose({ port: 3000, name: "Testportal", lifetime: "thread" });
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
processes. It covers default-stack recursion, a larger unsafe stack override,
default promise-job exhaustion, synchronous wall expiry, unresolved promises,
noncooperative cancellation, throwing observers, validation, error transport,
and successful calls after failures. I/O tests cover exact-limit/overflow,
100/1000 ms deadlines, partial output, local process-tree cancellation with no
later write, nonzero exit codes, and contextual file errors.

The original tests missed the default-stack crash because they overrode the
stack limit to 128 KiB. Testing also exposed an unhandled rejection and stuck
cleanup after job exhaustion. These are regression tests, **not a full security
audit**. Real Incus latency, publication, PR mutations, and maximum-load testing
are not covered by the offline tests.
