// Spike for the authorization plan, steps 2 and 4: the recorded corpus
// against the plan's Datalog, evaluated by biscuit-wasm. A reference profile
// for the capture's thread is minted with test-only keys; every request
// becomes its actions (facts.ts, already in the corpus), each action becomes
// ambient facts, and the request is allowed only if all its actions are.
// Unclassified actions are denied without evaluation; a push with more than
// MAX_REFS ref updates is denied (spike 4a: one authorization per ref).
//
//   node replay.ts <corpus.jsonl> <scenarios.json> <out.expected.json>
//
// BISCUIT_WASM: biscuit-wasm's module/biscuit.js (installed outside the repo).
import fs from "node:fs";
import { createHash } from "node:crypto";

const B = await import(process.env.BISCUIT_WASM ?? "/tmp/authz/node-biscuit/node_modules/@biscuit-auth/biscuit-wasm/module/biscuit.js");
const { AuthorizerBuilder, Biscuit, BiscuitBuilder, KeyPair, PrivateKey } = B;

const [corpusFile, scenariosFile, outFile] = process.argv.slice(2);
const { id: threadRef, repository } = JSON.parse(fs.readFileSync(scenariosFile, "utf8")) as { id: string; repository: string };
const repo = repository.toLowerCase();
const ZERO = "0000000000000000000000000000000000000000";
const MAX_REFS = 2;
const testKey = (label: string) => createHash("sha256").update(`cube-authz-TEST-ONLY:${label}`).digest("hex");
const priv = (hex: string) => PrivateKey.fromString(`ed25519-private/${hex}`);
const root = priv(testKey("root"));
const approvalPublic = KeyPair.fromPrivateKey(priv(testKey("approval"))).getPublicKey().toString().replace(/^ed25519\//, "");
const runner = testKey("runner-node-id");
const now = "2026-10-15T18:00:00Z";
const q = (s: string) => JSON.stringify(s);

// The reference profile: the project's repository, the thread's prefix, main
// behind an approval, package registries read-only, GitHub reads, PR creation.
const readHosts = ["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com", "registry.npmjs.org",
  "raw.githubusercontent.com", "objects.githubusercontent.com", "codeload.github.com", "github.com"];
const authority = [
  `on_behalf_of("user:1"); project("authz"); thread(${q(threadRef)}); runner(${q(runner)}); machine("vm1");`,
  ...readHosts.map(h => `http(${q(h)}, "GET"); http(${q(h)}, "HEAD");`),
  `git("github.com", ${q(repo)}, "fetch");`,
  `git_push_prefix("github.com", ${q(repo)}, ${q(`refs/heads/cube/${threadRef}/`)});`,
  `git_delete_prefix("github.com", ${q(repo)}, ${q(`refs/heads/cube/${threadRef}/`)});`,
  `git_push_approval("github.com", ${q(repo)}, "refs/heads/main");`,
  `github_api(${q(repo)}, "read"); github_api("", "read");`,
  `github_api(${q(repo)}, "pulls/create");`,
  `github_graphql("query", "*");`,
  `github_graphql("mutation", "createPullRequest");`,
  `check if time($t), $t <= 2026-10-15T20:00:00Z;`,
  `check if peer($p), runner($p);`,
  `check if vm($v), machine($v);`,
  `check if req_http($h, $m)
  or req_git_fetch($h, $r)
  or req_github_api($r, $op)
  or req_github_graphql($k, $f)
  or req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p)
  or req_git_push($h, $r, $ref, $o, $n), git_delete_prefix($h, $r, $p), $ref.starts_with($p)
  or req_git_push($h, $r, $ref, $o, $n), approved($h, $r, $ref, $n) trusting ed25519/${approvalPublic}
  or req_git_push($h, $r, $ref, $o, $n), approved_ref($h, $r, $ref, $exp), time($t), $t <= $exp trusting ed25519/${approvalPublic};`,
].join("\n");
const authorizer = `allow if req_http($h, $m), http($h, $m);
allow if req_git_fetch($h, $r), git($h, $r, "fetch");
allow if req_github_api($r, $op), github_api($r, $op);
allow if req_github_graphql("query", $f), github_graphql("query", "*");
allow if req_github_graphql("mutation", $f), github_graphql("mutation", $f);
allow if req_git_push($h, $r, $ref, $o, $n), git_push_prefix($h, $r, $p), $ref.starts_with($p), $n != ${q(ZERO)};
allow if req_git_push($h, $r, $ref, $o, $n), git_push_approval($h, $r, $ref), $n != ${q(ZERO)}, $n != "unknown";
allow if req_git_push($h, $r, $ref, $o, $n), $n == ${q(ZERO)}, git_delete_prefix($h, $r, $p), $ref.starts_with($p);`;

const builder = new BiscuitBuilder();
builder.addCode(authority);
builder.setRootKeyId(1);
const token = Biscuit.fromBytesWithProvider(builder.build(root).toBytes(), () => KeyPair.fromPrivateKey(root).getPublicKey());

type Action = { kind: string; [key: string]: any };
/** One action as ambient facts, or a reason it is denied without evaluation. */
function ambient(action: Action): string | { deny: string } {
  switch (action.kind) {
    case "http": return `req_http(${q(action.host)}, ${q(action.method)});`;
    case "git_discover":
    case "git_fetch": return `req_git_fetch(${q(action.host)}, ${q(action.repo)});`;
    case "git_push": return `req_git_push(${q(action.host)}, ${q(action.repo)}, ${q(action.ref)}, ${q(action.old)}, ${q(action.new)});`;
    case "github_rest": {
      // REST writes that move a ref are pushes: the ref from the path or body, the sha when the body names one.
      if (["git/create-ref", "git/update-ref", "repos/create-or-update-file-contents", "repos/merge-upstream", "repos/merge"].includes(action.op)) {
        if (!action.bodyRef || !action.repo) return { deny: "a ref write without a ref" };
        return `req_git_push("github.com", ${q(action.repo)}, ${q(action.bodyRef)}, "", ${q(action.sha ?? "unknown")});`;
      }
      const op = action.method === "GET" || action.method === "HEAD" ? "read" : action.op;
      return `req_github_api(${q(action.repo ?? "")}, ${q(op)});`;
    }
    case "github_graphql":
      if (action.type === "subscription" || action.fields.length !== 1) return { deny: "graphql: one top-level field per operation" };
      return `req_github_graphql(${q(action.type)}, ${q(action.fields[0])});`;
    default: return { deny: `unclassified: ${action.why ?? action.kind}` };
  }
}

function authorize(facts: string): "allow" | "deny" {
  const a = new AuthorizerBuilder();
  a.addCode(`peer(${q(runner)}); vm("vm1"); time(${now});\n${facts}\n${authorizer}`);
  try { a.buildAuthenticated(token).authorizeWithLimits({ max_facts: 1000, max_iterations: 100, max_time_micro: 200_000 }); return "allow"; }
  catch { return "deny"; }
}
// Warm-up: the first authorization in a process is slow (spike 4b).
authorize(`req_http("registry.npmjs.org", "GET");`);

const rows = fs.readFileSync(corpusFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const results = rows.map(row => {
  const actions: Action[] = row.actions;
  const pushes = actions.filter(a => a.kind === "git_push").length;
  const verdicts = actions.map(action => {
    if (pushes > MAX_REFS) return { verdict: "deny" as const, why: `more than ${MAX_REFS} ref updates in one push` };
    const facts = ambient(action);
    if (typeof facts !== "string") return { verdict: "deny" as const, why: facts.deny };
    const verdict = authorize(facts);
    const ref = action.kind === "git_push" ? action.ref : action.bodyRef;
    const sha = action.kind === "git_push" ? action.new : action.sha;
    const needsApproval = verdict === "deny" && (action.kind === "git_push" || action.kind === "github_rest") && action.repo === repo
      && ref === "refs/heads/main" && typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) && sha !== ZERO;
    return { verdict, why: needsApproval ? "needs approval" : verdict === "deny" ? "not granted" : "granted" };
  });
  const verdict = verdicts.every(v => v.verdict === "allow") ? "allow" : "deny";
  return { seq: row.seq, scenario: row.scenario, request: `${row.request.method} ${row.request.host}${row.request.target.split("?")[0]}`, verdict,
    why: [...new Set(verdicts.filter(v => v.verdict === "deny").map(v => v.why))].join("; ") || "granted" };
});
fs.writeFileSync(outFile, `${JSON.stringify({
  note: "Expected verdicts for the corpus under the reference profile below (plan 2026-10-15-authorization, appendix B). Keys are test-only.",
  maxRefsPerPush: MAX_REFS, time: now, authority, authorizer, results }, null, 1)}\n`);
const by = new Map<string, { allow: number; deny: number; why: Set<string> }>();
for (const r of results) {
  const e = by.get(r.scenario) ?? { allow: 0, deny: 0, why: new Set() };
  e[r.verdict as "allow" | "deny"]++;
  if (r.verdict === "deny") e.why.add(r.why);
  by.set(r.scenario, e);
}
for (const [scenario, e] of by) console.log(`| ${scenario} | ${e.allow} | ${e.deny} | ${[...e.why].join("; ")} |`);
