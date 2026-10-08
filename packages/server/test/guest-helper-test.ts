/** The guest helper's own unit tests (Python, test launcher injected), plus
 * the seed it ships in. The workspace contract over the helper runs in
 * workspace-test.ts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const result = spawnSync("python3", ["-W", "error", path.join(import.meta.dirname, "guest_helper_test.py")], { encoding: "utf8" });
process.stderr.write(result.stderr);
assert.equal(result.status, 0, "guest helper unit tests failed");
// Reaching files outside the workspace as the agent's account needs root, as
// in the guest: CUBE_TEST_GUEST_ROOT=1 (CI) runs that test with sudo -n.
let asRoot = "";
const rootTest = process.env.CUBE_TEST_GUEST_ROOT;
const sudo = process.platform === "linux" && process.getuid?.() !== 0 && spawnSync("sudo", ["-n", "true"]).status === 0;
assert.ok(rootTest !== "required" || sudo, "CUBE_TEST_GUEST_ROOT=required needs Linux and passwordless sudo");
if (rootTest && rootTest !== "0" && sudo) {
  const root = spawnSync("sudo", ["-n", "python3", "-W", "error", path.join(import.meta.dirname, "guest_helper_test.py"),
    "GuestHelperTest.test_outside_the_workspace_files_are_reached_as_the_agent"], { encoding: "utf8" });
  process.stderr.write(root.stderr);
  assert.equal(root.status, 0, "the guest helper's root test failed");
  assert.doesNotMatch(root.stderr, /skipped/, "the root test ran");
  asRoot = ", agent permissions as root";
}
const syntax = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path.join(import.meta.dirname, "../guest/cube-guest.py")], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);
console.log(`ok: guest helper journal, epochs, launcher, finish and recover mapping, paths, capacity${asRoot}`);
