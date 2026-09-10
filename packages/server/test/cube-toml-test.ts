/**
 * Offline unit test for the minimal .cube/cube.toml wake-hooks reader.
 *
 *   node packages/server/test/cube-toml-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseWakeHooks, readWakeHooks } from "../src/cube-toml.ts";

// --- happy path: comments, trailing comma, multiline
assert.deepEqual(
  parseWakeHooks(`
# cube config
[env]           # unrelated section
foo = "bar"

[wake]
hooks = [
  "docker compose up -d",   # restart services
  "npm run seed",
]
`),
  ["docker compose up -d", "npm run seed"],
);
console.log("1 ok: multiline array with comments + trailing comma");

// --- single line, escapes, and a ] inside a string
assert.deepEqual(
  parseWakeHooks(`[wake]\nhooks = ["grep \\"[x]\\" f", "a\\\\b", "line\\nbreak"]`),
  ['grep "[x]" f', "a\\b", "line\nbreak"],
);
console.log("2 ok: escapes and brackets inside strings");

// --- absent file / section / key => no hooks
assert.deepEqual(parseWakeHooks(""), []);
assert.deepEqual(parseWakeHooks("[env]\nfoo = \"bar\""), []);
assert.deepEqual(parseWakeHooks("[wake]\nother = 1"), []);
assert.deepEqual(readWakeHooks(path.join(os.tmpdir(), "cube-no-such-workspace")), []);
console.log("3 ok: missing file/section/key -> []");

// --- hooks key in ANOTHER section is not picked up
assert.deepEqual(parseWakeHooks(`[other]\nhooks = ["nope"]\n[wake]\n`), []);
assert.deepEqual(parseWakeHooks(`[other]\nhooks = ["nope"]`), []);
console.log("4 ok: hooks outside [wake] ignored");

// --- malformed input throws (caller reports it as a failed hook)
assert.throws(() => parseWakeHooks(`[wake]\nhooks = ["a", bare]`), /double-quoted/);
assert.throws(() => parseWakeHooks(`[wake]\nhooks = ["a"`), /unterminated/);
assert.throws(() => parseWakeHooks(`[wake]\nhooks = ["a" "b"]`), /comma-separated/);
assert.throws(() => parseWakeHooks(`[wake]\nhooks = [,"a"]`), /comma-separated/);
assert.throws(() => parseWakeHooks(`[wake]\nhooks = "echo hi"`), /must be an array/);
assert.throws(() => parseWakeHooks(`[wake]\nhooks = ["bad \\q escape"]`), /unsupported escape/);
console.log("5 ok: malformed arrays throw (never silently wrong hooks)");

// --- readWakeHooks reads <environment directory>/cube.toml
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-toml-test-"));
fs.mkdirSync(path.join(tmp, ".cube"));
fs.writeFileSync(path.join(tmp, ".cube", "cube.toml"), `[wake]\nhooks = ["echo hi"]\n`);
assert.deepEqual(readWakeHooks(path.join(tmp, ".cube")), ["echo hi"]);
assert.deepEqual(readWakeHooks(tmp), [], "the workspace root itself holds no cube.toml");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("6 ok: readWakeHooks reads the environment directory's file");

console.log("cube-toml-test: all ok");

// ================================================================ services

import { parseCubeToml, parseServices } from "../src/cube-toml.ts";

// --- full declaration: fixed + auto port, env, health, cwd
{
  const config = parseCubeToml(`
[wake]
hooks = ["docker compose up -d"]

[services.web]
command = "pnpm dev --host 0.0.0.0 --port $PORT"  # main app
cwd = "app"
port = 3000
health = "/healthz"

[services.web.env]
API_MODE = "development"
EMPTY = ""

[services.oauth]
command = "npx mock-oauth"
`);
  assert.deepEqual(config.wakeHooks, ["docker compose up -d"]);
  assert.equal(config.services.length, 2);
  const [web, oauth] = config.services;
  assert.deepEqual(web, {
    name: "web",
    command: "pnpm dev --host 0.0.0.0 --port $PORT",
    cwd: "app",
    port: 3000,
    health: "/healthz",
    env: { API_MODE: "development", EMPTY: "" },
  });
  assert.deepEqual(oauth, {
    name: "oauth", command: "npx mock-oauth", cwd: ".", port: null, health: null, env: {},
  });
  console.log("7 ok: services parsed (fixed + defaults + env)");
}

// --- env section before/after main section still lands on the same spec
assert.deepEqual(
  parseServices(`[services.a.env]\nX = "1"\n[services.a]\ncommand = "run"`)[0],
  { name: "a", command: "run", cwd: ".", port: null, health: null, env: { X: "1" } },
);
console.log("8 ok: env section order-independent");

// --- malformed declarations throw with the offending key in the message
assert.throws(() => parseServices(`[services.a]\nport = 3000`), /missing command/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\nport = 0`), /port must be an integer in 1-65535/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\nport = "3000"`), /port must be an integer/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\nhealth = "healthz"`), /must be a path/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\ncwd = "/etc"`), /must be relative/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\ncwd = "../out"`), /must be relative/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x"\nrestart = "always"`), /unknown key/);
assert.throws(() => parseServices(`[services.a]\ncommand = bare`), /double-quoted string or integer/);
assert.throws(() => parseServices(`[services.a]\ncommand = "unterminated`), /unterminated or trailing-junk/);
assert.throws(() => parseServices(`[services.a]\ncommand = "x" junk`), /unterminated or trailing-junk/);
assert.throws(() => parseServices(`[services.Bad]\ncommand = "x"`), /invalid service name/);
assert.throws(() => parseServices(`[services.a--b]\ncommand = "x"`), /invalid service name/);
assert.throws(() => parseServices(`[services.a.env]\nX = 1`), /must be a string/);
assert.throws(() => parseServices(`[services]\nfoo = "x"`), /unsupported section/);
assert.throws(() => parseServices(`[services.a.env.deep]\nX = "1"`), /unsupported section/);
assert.throws(
  () => parseServices('[services.web]\ncommand = "x"\n[services.web.env]\nMY-VAR = "1"'),
  /not a valid environment variable name/,
);
console.log("9 ok: malformed service declarations throw");

// --- non-service sections are untouched; no services -> []
assert.deepEqual(parseServices(`[env]\nfoo = "bar"\n[wake]\nhooks = []`), []);
console.log("10 ok: unrelated sections ignored");

console.log("cube-toml-test (services): all ok");

// ================================================================= network

import { parseNetworkAllow } from "../src/cube-toml.ts";

// --- absent file/section/key -> []; entries are case-folded, trailing dot dropped
assert.deepEqual(parseNetworkAllow(""), []);
assert.deepEqual(parseNetworkAllow("[network]\nother = 1"), []);
assert.deepEqual(
  parseNetworkAllow(`
[network]
allow = [
  "Repo.Maven.Apache.org.",   # case and trailing dot are not policy
  "*.gradle.org",             # wildcard suffix, as the proxy matcher reads it
]
`),
  ["repo.maven.apache.org", "*.gradle.org"],
);
assert.deepEqual(parseCubeToml(`[network]\nallow = ["services.gradle.org"]`).networkAllow, ["services.gradle.org"]);
assert.deepEqual(parseCubeToml(`[wake]\nhooks = []`).networkAllow, []);
console.log("11 ok: network.allow parsed, normalised, absent -> []");

// --- anything that is not a hostname is a loud error, never a silently
// narrower or wider policy
assert.throws(() => parseNetworkAllow(`[network]\nallow = "github.com"`), /network\.allow must be an array/);
assert.throws(() => parseNetworkAllow(`[network]\nallow = ["a.com" "b.com"]`), /network\.allow must be a comma-separated array/);
assert.throws(() => parseNetworkAllow(`[network]\nallow = ["a.com"`), /unterminated network\.allow array/);
for (const bad of ["https://github.com", "github.com:443", "github.com/org", "10.0.0.1", "::1", "localhost", "*", "*.com", "a b.com", "-a.com", ""]) {
  assert.throws(() => parseNetworkAllow(`[network]\nallow = [${JSON.stringify(bad)}]`), /must be a hostname/, bad);
}
assert.throws(() => parseNetworkAllow(`[network]\nallow = [${Array.from({ length: 201 }, (_, i) => `"h${i}.example.com"`).join(",")}]`), /more than 200 hosts/);
console.log("12 ok: malformed network.allow entries throw with the offending entry");

console.log("cube-toml-test (network): all ok");
