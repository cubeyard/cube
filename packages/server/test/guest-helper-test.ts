/** The guest helper's own unit tests (Python, test launcher injected), plus
 * the seed it ships in. The workspace contract over the helper runs in
 * workspace-test.ts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const result = spawnSync("python3", ["-W", "error", path.join(import.meta.dirname, "guest_helper_test.py")], { encoding: "utf8" });
process.stderr.write(result.stderr);
assert.equal(result.status, 0, "guest helper unit tests failed");
const syntax = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path.join(import.meta.dirname, "../guest/cube-guest.py")], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);
console.log("ok: guest helper journal, epochs, launcher, finish and recover mapping, paths, capacity");
