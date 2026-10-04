/** cubed's egress policy and its decision socket, as the gateway calls it. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EgressPolicy, githubSecret, newPlaceholder, serveEgress, type EgressRequest } from "../src/egress-policy.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-egress-"));
const lines: string[] = [];
const log = { debug: (msg: string, fields?: object) => lines.push(`debug ${msg} ${JSON.stringify(fields)}`),
  info: (msg: string, fields?: object) => lines.push(`info ${msg} ${JSON.stringify(fields)}`),
  warn: () => {}, error: () => {}, child() { return this; } };
const mine = newPlaceholder("github");
const theirs = newPlaceholder("github");
assert.match(mine, /^cube_ph_github_[A-Za-z0-9]{22}$/);
assert.notEqual(mine, theirs);
let tokenCalls = 0;
const github = githubSecret(async () => { tokenCalls++; return "ghs_real-host-token\n"; }, { env: {} });
const policy = new EgressPolicy({
  vms: { vm: vmId => vmId === "aaaaaaaaaaaaaaaa" ? { threadId: "t1", placeholders: { github: mine } }
    : vmId === "bbbbbbbbbbbbbbbb" ? { threadId: "t2", placeholders: { github: theirs } } : null },
  secrets: [github], log,
});
const ask = (patch: Partial<EgressRequest>): EgressRequest => ({ vmId: "aaaaaaaaaaaaaaaa", threadId: "t1", scheme: "https", method: "GET",
  host: "api.github.com", port: 443, path: "/user", placeholders: [], ...patch });
try {
  // Public hosts are allowed; nothing is substituted without a placeholder.
  assert.deepEqual(await policy.decide(ask({ host: "example.com", path: "/" })), { allow: true });
  assert.deepEqual(await policy.decide(ask({ scheme: "http", port: 80, host: "deb.debian.org", path: "/debian/dists/trixie/InRelease" })), { allow: true });
  // The VM's own GitHub placeholder on GitHub's hosts over HTTPS: substituted.
  assert.deepEqual(await policy.decide(ask({ placeholders: [mine] })), { allow: true, substitute: { [mine]: "ghs_real-host-token" } });
  assert.deepEqual(await policy.decide(ask({ host: "github.com", method: "POST", path: "/org/repo.git/git-receive-pack", placeholders: [mine, mine] })),
    { allow: true, substitute: { [mine]: "ghs_real-host-token" } });
  assert.equal(tokenCalls, 1, "the host token is cached");
  // Everything else with a placeholder is denied, with a reason.
  const denied = async (patch: Partial<EgressRequest>, reason: RegExp) => {
    const decision = await policy.decide(ask(patch));
    assert.equal(decision.allow, false, JSON.stringify(patch));
    assert.match((decision as { reason: string }).reason, reason);
  };
  await denied({ placeholders: [theirs] }, /does not belong to this thread/);
  await denied({ placeholders: ["cube_ph_github_tooShort"] }, /does not belong/);
  await denied({ scheme: "http", port: 80, placeholders: [mine] }, /only sent over https/);
  await denied({ host: "evil.example", placeholders: [mine] }, /not allowed for evil\.example/);
  await denied({ host: "api.github.com.evil.example", placeholders: [mine] }, /not allowed/);
  await denied({ placeholders: [newPlaceholder("aws")] }, /does not belong/);
  await denied({ method: "CONNECT" }, /CONNECT/);
  await denied({ threadId: "t2" }, /unknown thread machine/);
  await denied({ vmId: "cccccccccccccccc" }, /unknown thread machine/);
  assert.deepEqual(await policy.decide(ask({ host: "API.GitHub.com.", placeholders: [mine] })), { allow: true, substitute: { [mine]: "ghs_real-host-token" } },
    "host names compare case-insensitively without the root dot");
  assert.ok(lines.some(line => line.startsWith("info denied") && line.includes("does not belong")), "denies are logged at info");
  assert.ok(!lines.some(line => line.includes("ghs_real-host-token")), "the secret value is never logged");
  // Not connected: no substitution; GitHub answers 401 itself.
  const offline = new EgressPolicy({ vms: { vm: () => ({ threadId: "t1", placeholders: { github: mine } }) },
    secrets: [githubSecret(async () => null, { env: {} })], log });
  assert.deepEqual(await offline.decide(ask({ placeholders: [mine] })), { allow: true });
  // cubed's configuration may name the token instead of gh.
  assert.equal(await githubSecret(async () => "from-gh", { env: { CUBED_GITHUB_TOKEN: "from-config" } }).value(), "from-config");

  // The socket the gateway calls: 0600, POST /v1/decide only.
  const socket = path.join(root, "egress.sock");
  const served = await serveEgress(socket, policy);
  try {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const post = (url: string, body: string) => new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const request = http.request({ socketPath: socket, method: "POST", path: url, headers: { "content-type": "application/json" } }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) }));
      });
      request.on("error", reject);
      request.end(body);
    });
    assert.deepEqual(await post("/v1/decide", JSON.stringify(ask({ placeholders: [mine] }))),
      { status: 200, json: { allow: true, substitute: { [mine]: "ghs_real-host-token" } } });
    assert.deepEqual(await post("/v1/decide", JSON.stringify(ask({ placeholders: [theirs] }))),
      { status: 200, json: { allow: false, reason: "a secret placeholder does not belong to this thread" } });
    assert.equal((await post("/v1/decide", "{not json")).status, 400);
    assert.equal((await post("/v1/decide", JSON.stringify({ ...ask({}), scheme: "ftp" }))).status, 400);
    assert.equal((await post("/v1/other", "{}")).status, 404);
  } finally { await served.close(); }
  assert.ok(!fs.existsSync(socket));
  console.log("ok: egress policy: public hosts allowed, own github placeholder substituted only over https to github hosts, other placeholders/hosts/http/CONNECT denied with reasons, decision socket");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
