/**
 * Offline unit test for the logger: line shape and quoting, child fields,
 * error/stack handling, CUBED_LOG_LEVEL filtering, and the stdout default.
 *
 *   node packages/server/test/log-test.ts
 */
import assert from "node:assert";

import { createLogger } from "../src/log.ts";

const lines: string[] = [];
const sink = (line: string) => void lines.push(line);
const take = () => lines.splice(0).join("");

delete process.env.CUBED_LOG_LEVEL;
const log = createLogger("api", sink);

log.info("listening", { port: 7777, portals: "*.cube.internal" });
assert.equal(take(), "info api listening port=7777 portals=*.cube.internal\n");
console.log("1 ok: level component msg key=value");

log.warn("web UI not built", {
  hint: "run `pnpm build` (serving API only)",
  empty: "",
  eq: "a=b",
  nl: "two\nlines",
  none: null,
  gone: undefined,
  on: true,
  obj: { a: 1 },
});
assert.equal(
  take(),
  'warn api web UI not built hint="run `pnpm build` (serving API only)" empty="" eq="a=b" nl="two\\nlines" none=null on=true obj="{\\"a\\":1}"\n',
);
console.log("2 ok: quoting keeps one event on one line; undefined is skipped");

const thread = log.child({ thread: "t-abc12345" });
thread.warn("pi exited", { code: 1 });
assert.equal(take(), "warn api pi exited thread=t-abc12345 code=1\n");
thread.child({ cube: "t-abc12345" }).info("x", { thread: "override" });
assert.equal(take(), "info api x thread=override cube=t-abc12345\n");
console.log("3 ok: child fields lead the line and can be overridden");

const boom = new Error("boom here");
log.warn("failed", { error: boom });
assert.equal(take(), 'warn api failed error="boom here"\n');
log.error("api error", { status: 500, error: boom });
const errorLine = take();
assert.ok(errorLine.startsWith('error api api error status=500 error="boom here" stack="Error: boom here\\n    at '), errorLine);
assert.equal(errorLine.indexOf("\n"), errorLine.length - 1, "the stack stays on the one line");
log.warn("plain", { error: "string reason" });
assert.equal(take(), 'warn api plain error="string reason"\n');
console.log("4 ok: error= carries the message; the stack rides along at error level only");

process.env.CUBED_LOG_LEVEL = "warn";
log.debug("hidden");
log.info("hidden");
log.warn("shown");
assert.equal(take(), "warn api shown\n");
process.env.CUBED_LOG_LEVEL = "debug";
log.debug("dbg", { error: boom });
assert.match(take(), /^debug api dbg error="boom here" stack="Error: boom here/);
log.info("info at debug", { error: boom });
assert.match(take(), /^info api info at debug error="boom here" stack="Error: boom here/);
process.env.CUBED_LOG_LEVEL = "bogus";
log.debug("hidden");
log.info("shown");
assert.equal(take(), "info api shown\n");
delete process.env.CUBED_LOG_LEVEL;
console.log("5 ok: CUBED_LOG_LEVEL filters (debug adds stacks everywhere; unknown means info)");

const written: string[] = [];
const original = process.stdout.write;
process.stdout.write = ((chunk: string | Uint8Array) => {
  written.push(String(chunk));
  return true;
}) as typeof process.stdout.write;
try {
  createLogger("boot").info("listening");
} finally {
  process.stdout.write = original;
}
assert.deepEqual(written, ["info boot listening\n"]);
console.log("6 ok: the default sink is stdout (journald's)");

console.log("ALL PASS: log");
