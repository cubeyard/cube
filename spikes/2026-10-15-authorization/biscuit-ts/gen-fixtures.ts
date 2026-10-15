// Generates packages/runner-protocol/fixtures/authz/datalog/*.json.
// Spike 4b (2026-10-15). Every key in these fixtures is TEST-ONLY: it is
// sha256 of a fixed label, printed in the fixture, and must never be used
// for anything but these tests.
//
// Run: node spikes/2026-10-15-authorization/biscuit-ts/gen-fixtures.ts
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../../packages/runner-protocol/fixtures/authz/datalog");

const testKey = (label: string) => createHash("sha256").update(`cube-authz-TEST-ONLY:${label}`).digest("hex");

export const testOnlyKeys = {
  root: testKey("root"),
  approval: testKey("approval"),
  other: testKey("other-not-trusted"),
};
// Public keys are derived by the runners; the generator only needs the
// approval public key to write it into the authority block. It is computed by
// biscuit-wasm so that the fixture text is self-contained.
const { PrivateKey, KeyPair } = await import(
  process.env.BISCUIT_WASM ?? "/tmp/authz/node-biscuit/node_modules/@biscuit-auth/biscuit-wasm/module/biscuit.js"
);
const pub = (hex: string) =>
  KeyPair.fromPrivateKey(PrivateKey.fromString(`ed25519-private/${hex}`)).getPublicKey().toString();
const approvalPub = pub(testOnlyKeys.approval); // "ed25519/<hex>"

const RUNNER = createHash("sha256").update("cube-authz-TEST-ONLY:runner-node-id").digest("hex");
const OTHER_RUNNER = createHash("sha256").update("cube-authz-TEST-ONLY:other-runner").digest("hex");
const NOW = "2026-10-15T18:00:00Z";
const EXPIRY = "2026-10-15T20:00:00Z";
const ZERO = "0000000000000000000000000000000000000000";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD = "1111111111111111111111111111111111111111";
const H = "github.com";
const REPO = "cubeyard/cube";

// ~30 grant facts: the realistic profile of one thread.
const httpHosts = [
  "registry.npmjs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
  "security.debian.org",
  "proxy.golang.org",
  "sum.golang.org",
  "dl-cdn.alpinelinux.org",
  "nodejs.org",
  "registry.yarnpkg.com",
  "api.github.com",
];

export function authority(opts: { extraGrants?: string[] } = {}): string {
  return [
    `on_behalf_of("user:test");`,
    `project("cube");`,
    `thread("t1");`,
    `runner("${RUNNER}");`,
    `machine("vm1");`,
    ...httpHosts.map((h) => `http("${h}", "GET");`),
    `git("${H}", "${REPO}", "fetch");`,
    `git("${H}", "cubeyard/keel", "fetch");`,
    `git_push_prefix("${H}", "${REPO}", "refs/heads/cube/t1/");`,
    `git_push_approval("${H}", "${REPO}", "refs/heads/main");`,
    `github_api("${REPO}", "pulls.create");`,
    `github_api("${REPO}", "pulls.get");`,
    `github_api("${REPO}", "issues.comment");`,
    ...(opts.extraGrants ?? []),
    `check if time($t), $t <= ${EXPIRY};`,
    `check if peer($p), runner($p);`,
    `check if vm($v), machine($v);`,
    // Pushes outside a prefix grant need an approval signed by the approval
    // key. Only these two alternatives trust that key; the allow policies do
    // not, so an approval can lift this check but never add a grant.
    `check if req_http($h, $m)`,
    `  or req_git_fetch($h, $r)`,
    `  or req_github_api($r, $op)`,
    `  or req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p)`,
    `  or req_git_push($h, $r, $ref, $o, $n), git_delete_prefix($h, $r, $p), $ref.starts_with($p)`,
    `  or req_git_push($h, $r, $ref, $o, $n), approved($h, $r, $ref, $n) trusting ${approvalPub}`,
    `  or req_git_push($h, $r, $ref, $o, $n), approved_ref($h, $r, $ref, $exp), time($t), $t <= $exp trusting ${approvalPub};`,
  ].join("\n");
}

// The authorizer: cubed-defined, identical in the gate and the proxy.
// Default scope (authority + authorizer): never trusts appended blocks.
export const AUTHORIZER = [
  `allow if req_http($h, $m), http($h, $m);`,
  `allow if req_git_fetch($h, $r), git($h, $r, "fetch");`,
  `allow if req_github_api($r, $op), github_api($r, $op);`,
  `allow if req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p), $n != "${ZERO}";`,
  `allow if req_git_push($h, $r, $ref, $o, $n), git_push_approval($h, $r, $ref), $n != "${ZERO}";`,
  `allow if req_git_push($h, $r, $ref, $o, $n), $n == "${ZERO}", git_delete_prefix($h, $r, $p), $ref.starts_with($p);`,
].join("\n");

const TASK_A = [
  `check if req_git_push($h, $r, $ref, $o, $n), $ref.starts_with("refs/heads/cube/t1/task-a/")`,
  `  or req_git_fetch($h, $r)`,
  `  or req_http($h, "GET");`,
].join("\n");

const ambient = (action: string, o: { peer?: string; vm?: string; time?: string } = {}) =>
  [`peer("${o.peer ?? RUNNER}");`, `vm("${o.vm ?? "vm1"}");`, `time(${o.time ?? NOW});`, action].join("\n");
const push = (ref: string, n = SHA_A, o = OLD, repo = REPO) => `req_git_push("${H}", "${repo}", "${ref}", "${o}", "${n}");`;
// Plain HTTP is authorized on (host, method) only (plan: spike 4a, verdict cache); the path is not a fact.
const http = (host: string, method: string, _path = "/") => `req_http("${host}", "${method}");`;

type Block = { type: "attenuation"; code: string } | { type: "third_party"; signer: "approval" | "other"; code: string };
type Fixture = {
  description: string;
  expect: "allow" | "deny";
  token?: { root?: "root" | "other"; authority?: string; blocks?: Block[] };
  actions: string[];
  revoked_blocks?: number[];
};

const approval = (code: string, signer: "approval" | "other" = "approval"): Block => ({ type: "third_party", signer, code });
const attenuation = (code: string): Block => ({ type: "attenuation", code });
const approvedMain = (sha = SHA_A) => approval(`approved("${H}", "${REPO}", "refs/heads/main", "${sha}");`);

const fixtures: Record<string, Fixture> = {
  "push-prefix-allowed": { description: "push to refs/heads/cube/t1/* is granted by the profile", expect: "allow", actions: [push("refs/heads/cube/t1/feature")] },
  "push-main-no-approval-denied": { description: "main needs an approval; none present", expect: "deny", actions: [push("refs/heads/main")] },
  "push-main-approved-sha-allowed": { description: "approval for (main, sha A); push main to sha A", expect: "allow", token: { blocks: [approvedMain()] }, actions: [push("refs/heads/main", SHA_A)] },
  "push-main-approved-other-sha-denied": { description: "approval for sha A used to push sha B", expect: "deny", token: { blocks: [approvedMain(SHA_A)] }, actions: [push("refs/heads/main", SHA_B)] },
  "push-main-approval-wrong-key-denied": { description: "approval block signed by a key the authority does not trust", expect: "deny", token: { blocks: [approval(`approved("${H}", "${REPO}", "refs/heads/main", "${SHA_A}");`, "other")] }, actions: [push("refs/heads/main", SHA_A)] },
  "approval-outside-profile-ref-denied": { description: "valid approval for refs/heads/prod, which the profile neither grants nor gates", expect: "deny", token: { blocks: [approval(`approved("${H}", "${REPO}", "refs/heads/prod", "${SHA_A}");`)] }, actions: [push("refs/heads/prod", SHA_A)] },
  "approval-outside-profile-repo-denied": { description: "valid approval for main of another repo", expect: "deny", token: { blocks: [approval(`approved("${H}", "cubeyard/other", "refs/heads/main", "${SHA_A}");`)] }, actions: [push("refs/heads/main", SHA_A, OLD, "cubeyard/other")] },
  "approval-key-cannot-widen-profile-denied": { description: "approval block also carries grant facts (git_push_approval/git_push_prefix for prod); policies do not trust the approval key, so it cannot add grants", expect: "deny", token: { blocks: [approval(`git_push_approval("${H}", "${REPO}", "refs/heads/prod");\ngit_push_prefix("${H}", "${REPO}", "refs/heads/prod");\napproved("${H}", "${REPO}", "refs/heads/prod", "${SHA_A}");`)] }, actions: [push("refs/heads/prod", SHA_A)] },
  "approval-for-thread-allowed": { description: "allow-for-thread approval approved_ref(main, expiry) not yet expired", expect: "allow", token: { blocks: [approval(`approved_ref("${H}", "${REPO}", "refs/heads/main", 2026-10-15T19:00:00Z);`)] }, actions: [push("refs/heads/main", SHA_B)] },
  "approval-for-thread-expired-denied": { description: "allow-for-thread approval whose expiry has passed", expect: "deny", token: { blocks: [approval(`approved_ref("${H}", "${REPO}", "refs/heads/main", 2026-10-15T17:00:00Z);`)] }, actions: [push("refs/heads/main", SHA_B)] },
  "approval-of-deletion-denied": { description: "approval for main with the zero oid does not turn into a deletion grant", expect: "deny", token: { blocks: [approvedMain(ZERO)] }, actions: [push("refs/heads/main", ZERO)] },
  "wrong-peer-denied": { description: "token replayed on another runner (peer != runner)", expect: "deny", actions: [] },
  "wrong-vm-denied": { description: "token used from another machine", expect: "deny", actions: [] },
  "token-expired-denied": { description: "time after the authority's expiry", expect: "deny", actions: [] },
  "attenuation-allows-task-ref": { description: "task attenuation still allows its own prefix", expect: "allow", token: { blocks: [attenuation(TASK_A)] }, actions: [push("refs/heads/cube/t1/task-a/x")] },
  "attenuation-narrows-denied": { description: "same push as push-prefix-allowed, denied once a task attenuation is appended", expect: "deny", token: { blocks: [attenuation(TASK_A)] }, actions: [push("refs/heads/cube/t1/feature")] },
  "attenuation-narrows-github-api-denied": { description: "task attenuation removes github_api even though the profile grants pulls.create", expect: "deny", token: { blocks: [attenuation(TASK_A)] }, actions: [`req_github_api("${REPO}", "pulls.create");`] },
  "attenuation-narrows-even-with-approval-denied": { description: "attenuation (task-a only) + valid approval for main: the attenuation's check still fails", expect: "deny", token: { blocks: [attenuation(TASK_A), approvedMain()] }, actions: [push("refs/heads/main", SHA_A)] },
  "attenuation-cannot-widen-push-denied": { description: "attenuation block adds git_push_prefix(refs/heads/); policies ignore it", expect: "deny", token: { blocks: [attenuation(`git_push_prefix("${H}", "${REPO}", "refs/heads/");\ngit_push_approval("${H}", "${REPO}", "refs/heads/feature");`)] }, actions: [push("refs/heads/feature")] },
  "attenuation-cannot-widen-http-denied": { description: "attenuation block adds http(evil.example, POST)", expect: "deny", token: { blocks: [attenuation(`http("evil.example", "POST");\nhttp("registry.npmjs.org", "POST");`)] }, actions: [http("registry.npmjs.org", "POST", "/-/v1/login")] },
  "attenuation-cannot-forge-approval-denied": { description: "attenuation block (not third-party signed) carries approved(main, sha A)", expect: "deny", token: { blocks: [attenuation(`approved("${H}", "${REPO}", "refs/heads/main", "${SHA_A}");`)] }, actions: [push("refs/heads/main", SHA_A)] },
  "revoked-authority-denied": { description: "authority block's revocation id is in the revoked set", expect: "deny", revoked_blocks: [0], actions: [push("refs/heads/cube/t1/feature")] },
  "revoked-attenuation-denied": { description: "attenuation block's revocation id is revoked", expect: "deny", token: { blocks: [attenuation(TASK_A)] }, revoked_blocks: [1], actions: [push("refs/heads/cube/t1/task-a/x")] },
  "unknown-action-denied": { description: "an action kind no policy knows", expect: "deny", actions: [`req_ssh("github.com", "22");`] },
  "http-get-allowed": { description: "GET to a granted host", expect: "allow", actions: [http("registry.npmjs.org", "GET", "/left-pad")] },
  "http-post-denied": { description: "POST to a host granted only for GET", expect: "deny", actions: [http("registry.npmjs.org", "POST", "/-/v1/login")] },
  "http-ungranted-host-denied": { description: "GET to a host not in the profile", expect: "deny", actions: [http("evil.example", "GET")] },
  "git-fetch-allowed": { description: "fetch of a granted repo", expect: "allow", actions: [`req_git_fetch("${H}", "cubeyard/keel");`] },
  "git-fetch-ungranted-denied": { description: "fetch of a repo not in the profile", expect: "deny", actions: [`req_git_fetch("${H}", "cubeyard/secret");`] },
  "github-api-granted-allowed": { description: "pulls.create is granted", expect: "allow", actions: [`req_github_api("${REPO}", "pulls.create");`] },
  "github-api-not-granted-denied": { description: "pulls.merge is not granted", expect: "deny", actions: [`req_github_api("${REPO}", "pulls.merge");`] },
  "ref-deletion-denied": { description: "deleting refs/heads/cube/t1/x (new = zero oid) without a deletion grant", expect: "deny", actions: [push("refs/heads/cube/t1/x", ZERO)] },
  "ref-deletion-granted-allowed": { description: "deletion under an explicit git_delete_prefix grant", expect: "allow", token: { authority: authority({ extraGrants: [`git_delete_prefix("${H}", "${REPO}", "refs/heads/cube/t1/");`] }) }, actions: [push("refs/heads/cube/t1/x", ZERO)] },
  "multi-ref-push-all-allowed": { description: "push with three ref updates, all under the prefix", expect: "allow", actions: [push("refs/heads/cube/t1/a"), push("refs/heads/cube/t1/b"), push("refs/heads/cube/t1/c")] },
  "multi-ref-push-one-denied": { description: "push with three ref updates, one to main without approval", expect: "deny", actions: [push("refs/heads/cube/t1/a"), push("refs/heads/main"), push("refs/heads/cube/t1/c")] },
  "multi-ref-push-approved-allowed": { description: "prefix refs plus main with a matching approval", expect: "allow", token: { blocks: [approvedMain(SHA_A)] }, actions: [push("refs/heads/cube/t1/a"), push("refs/heads/main", SHA_A)] },
  "deny-reject-block-denied": { description: "the user denied pushes to main: cubed appended reject if for that ref; a valid allow-once approval no longer helps", expect: "deny", token: { blocks: [approvedMain(SHA_A), attenuation(`reject if req_git_push($h, $r, $ref, $o, $n), $ref == "refs/heads/main";`)] }, actions: [push("refs/heads/main", SHA_A)] },
  "deny-reject-block-other-ref-allowed": { description: "the reject block for main leaves the thread's prefix alone", expect: "allow", token: { blocks: [attenuation(`reject if req_git_push($h, $r, $ref, $o, $n), $ref == "refs/heads/main";`)] }, actions: [push("refs/heads/cube/t1/feature")] },
  "leaf-ttl-valid-allowed": { description: "a delivered leaf: base plus a TTL block that has not passed", expect: "allow", token: { blocks: [attenuation(`check if time($t), $t <= 2026-10-15T18:05:00Z;`)] }, actions: [push("refs/heads/cube/t1/feature")] },
  "leaf-ttl-expired-denied": { description: "a delivered leaf whose TTL block has passed, while the grant itself is still valid", expect: "deny", token: { blocks: [attenuation(`check if time($t), $t <= 2026-10-15T17:55:00Z;`)] }, actions: [push("refs/heads/cube/t1/feature")] },
  "leaf-ttl-approval-after-ttl-allowed": { description: "base, approval block, then a fresh TTL block: approvals survive renewal", expect: "allow", token: { blocks: [approvedMain(SHA_A), attenuation(`check if time($t), $t <= 2026-10-15T18:05:00Z;`)] }, actions: [push("refs/heads/main", SHA_A)] },
  "wrong-root-key-denied": { description: "token minted with a key that is not cubed's root key", expect: "deny", token: { root: "other" }, actions: [push("refs/heads/cube/t1/feature")] },
};
fixtures["wrong-peer-denied"].actions = [ambient(push("refs/heads/cube/t1/feature"), { peer: OTHER_RUNNER })];
fixtures["wrong-vm-denied"].actions = [ambient(push("refs/heads/cube/t1/feature"), { vm: "vm2" })];
fixtures["token-expired-denied"].actions = [ambient(push("refs/heads/cube/t1/feature"), { time: "2026-10-15T21:00:00Z" })];

mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".json")) rmSync(join(out, f));
const preset = new Set(["wrong-peer-denied", "wrong-vm-denied", "token-expired-denied"]);
for (const [name, f] of Object.entries(fixtures)) {
  const doc = {
    name,
    description: f.description,
    test_only_keys: {
      _note: "TEST ONLY. sha256('cube-authz-TEST-ONLY:<label>'). Never use outside these fixtures.",
      root_private: testOnlyKeys.root,
      root_key_id: 1,
      approval_private: testOnlyKeys.approval,
      other_private: testOnlyKeys.other,
    },
    token: {
      signed_by: f.token?.root ?? "root",
      authority: f.token?.authority ?? authority(),
      blocks: f.token?.blocks ?? [],
    },
    authorizer: AUTHORIZER,
    revoked_blocks: f.revoked_blocks ?? [],
    actions: preset.has(name) ? f.actions : f.actions.map((a) => ambient(a)),
    expect: f.expect,
  };
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${out}`);
