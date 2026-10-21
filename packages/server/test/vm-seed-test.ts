/** What cubed hands a thread's machine at boot: a keel machine's boot
 * documents (what they must hold, and what they never may) and the guest
 * helper a `berth host` machine runs (berth includes the same file). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { newPlaceholder } from "../src/egress-policy.ts";
import { bootDocuments, GUEST_CLI_SHIM, GUEST_HELPER_PATH, MAX_BOOT_BYTES, shippedHelper } from "../src/vm-seed.ts";

{
  const file = path.resolve(import.meta.dirname, "../guest/cube-guest.py");
  const shipped = shippedHelper();
  assert.ok(shipped.source.equals(fs.readFileSync(file)), "the shipped helper is the repository's");
  assert.equal(shipped.sha256, createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  const berth = fs.readFileSync(path.resolve(import.meta.dirname, "../../berth/src/host.rs"), "utf8");
  assert.match(berth, /include_str!\("\.\.\/\.\.\/server\/guest\/cube-guest\.py"\)/, "berth host runs the same helper");
  assert.equal(GUEST_CLI_SHIM, `#!/bin/sh\nexec ${GUEST_HELPER_PATH} cli "$@"\n`);
  assert.ok(shipped.source.toString().includes('CLI_SHIM = "#!/bin/sh\\nexec %s cli \\"$@\\"\\n" % HELPER\n'), "the helper writes the same shim");
  console.log("ok: the shipped guest helper is the repository's file, the one berth host includes, with the same cube shim");
}

// A keel machine's boot documents (C-4), with berth's names and bound.
{
  const vmId = "0123456789abcdef";
  const github = newPlaceholder("github");
  const other = newPlaceholder("npm");
  const hooks = { preSetup: "echo pre-setup\n", preResume: "#!/bin/sh\necho pre-resume" };
  const documents = bootDocuments({ vmId, placeholders: { github, npm: other }, hooks });
  const text = (name: string) => Buffer.from(documents[name]!).toString("utf8");
  assert.deepEqual(Object.keys(documents).sort(), ["env", "hooks/pre-resume", "hooks/pre-setup", "hostname"]);
  assert.equal(text("hostname"), "cube-01234567\n", "cube-<first 8 of the machine id>");
  assert.equal(text("env"), `GH_TOKEN=${github}\nCUBE_SECRET_NPM=${other}\n`, "only the placeholders: keel adds the CA and git lines");
  assert.equal(text("hooks/pre-setup"), "#!/bin/bash\necho pre-setup\n", "a hook as a script, with bash when it names none");
  assert.equal(text("hooks/pre-resume"), "#!/bin/sh\necho pre-resume\n");
  assert.deepEqual(Object.keys(bootDocuments({ vmId, placeholders: {}, hooks: { preSetup: " \n", preResume: "" } })).sort(), ["env", "hostname"], "a blank hook is no document");
  assert.equal(Buffer.from(bootDocuments({ vmId, placeholders: {} }).env!).byteLength, 0);
  // berth vm's and keel's names and berth's bound, from their sources.
  const berth = fs.readFileSync(path.resolve(import.meta.dirname, "../../berth/src/vm/mod.rs"), "utf8");
  const keel = fs.readFileSync(path.resolve(import.meta.dirname, "../../keel/agent/src/setup.rs"), "utf8");
  const names = (source: string, constant: string) => JSON.parse(new RegExp(`const ${constant}: \\[&str; \\d+\\] = (\\[[^\\]]*\\]);`).exec(source)![1]!) as string[];
  assert.deepEqual(names(berth, "BOOT_DOCUMENTS").sort(), Object.keys(documents).sort());
  assert.deepEqual(names(keel, "DOCUMENTS").sort(), Object.keys(documents).sort());
  assert.equal(MAX_BOOT_BYTES, Number(/const MAX_BOOT_BYTES: usize = (\d+) \* 1024;/.exec(berth)![1]) * 1024);
  // Within the runner's bound, or refused before anything is sent.
  const big = { preSetup: "x".repeat(MAX_BOOT_BYTES), preResume: "" };
  assert.throws(() => bootDocuments({ vmId, placeholders: {}, hooks: big }), /the boot documents are \d+ bytes; the runner accepts at most 262144/);
  assert.throws(() => bootDocuments({ vmId, placeholders: {}, hooks }, 64), /at most 64/);
  assert.throws(() => bootDocuments({ vmId: "nope", placeholders: {} }), /invalid vm id/);
  assert.throws(() => bootDocuments({ vmId, placeholders: { github: "ghp_the-real-host-token-never-in-a-boot" } }), /invalid placeholder/);
  console.log("ok: boot documents: host name, placeholders as env lines, hooks as scripts; berth's and keel's names, berth's bound");
}
