/**
 * The product surface never shows cube vocabulary or a raw internal error:
 * known failures become one calm sentence with a next step; unknown ones
 * are scrubbed, shortened and still end with the way out.
 *
 *   node packages/server/test/user-facing-test.ts
 */
import assert from "node:assert";

import { describeThreadError, sanitizeMessage } from "../src/user-facing.ts";

assert.equal(sanitizeMessage("cube t-1a2b3c4d is busy"), "thread is busy");
assert.equal(sanitizeMessage("Error: cube cube-t-1a2b3c4d: eth0 never came up"), "Error: thread: eth0 never came up");
assert.equal(sanitizeMessage("journalctl -u cube-svc-web says hi"), "journalctl -u cube-svc-web says hi");
assert.equal(sanitizeMessage("Incus instance not found"), "environment not found");
assert.equal(sanitizeMessage("incus: container t-1a2b3c4d stopped"), "environment t-1a2b3c4d stopped");
console.log("1 ok: cube names, the word cube, instance, container and incus are scrubbed; unit names survive");

assert.equal(describeThreadError(null), null);
assert.equal(describeThreadError("  "), null);
assert.match(describeThreadError(".cube/setup failed (exit 1): npm ERR! 404")!, /^the environment's \.cube\/setup script failed \(exit 1\) — .*start a new thread/);
assert.match(describeThreadError("wake hook failed (exit 2): docker compose up — no such file")!, /wake hook.*next time the thread wakes/);
assert.match(describeThreadError("provisioning was interrupted by a cubed restart — .cube/setup may not have completed")!, /cube restarted while this thread was being set up/);
assert.match(describeThreadError("wake failed: Error: cube cube-t-ab12cd34: eth0 never came up at 10.90.14.2")!, /did not come up in time/);
assert.match(describeThreadError("no free cube subnets (10.90.10-249.0/24 all allocated)")!, /no room for another thread/);
assert.match(describeThreadError("destroy failed (retry DELETE): Error: incus: Instance is running")!, /could not be removed/);
console.log("2 ok: known failures become one sentence with the next action");

const unknown = describeThreadError(`Error: cube t-ab12cd34: ${"x".repeat(400)}`)!;
assert.ok(!/cube/.test(unknown), "no cube vocabulary");
assert.ok(unknown.length < 260, `bounded: ${unknown.length}`);
assert.match(unknown, /…/);
assert.match(unknown, /delete this thread and start a new one$/);
console.log("3 ok: unknown failures are scrubbed, shortened and end with the way out");

console.log("ALL PASS: user-facing");
