// Spike 4b (2026-10-15): biscuit-wasm in Node 26. Mints each fixture of
// packages/runner-protocol/fixtures/authz/datalog with the fixture's
// TEST-ONLY keys, verifies it with a root key provider, checks the revocation
// set and authorizes every action; prints the verdict per fixture.
//
//   node run-fixtures.ts                       mint + evaluate in TS
//   node run-fixtures.ts --mint-to DIR         also write DIR/<name>.b64
//   node run-fixtures.ts --verify-from DIR     evaluate tokens minted elsewhere (Rust)
//   node run-fixtures.ts --bench [N]           verify+authorize timing (informational)
//   --warmup                                   one throwaway authorization first: the first
//                                              authorize() in a fresh process takes 30-55 ms here
//                                              and trips biscuit-wasm's default 20 ms limit (deny)
//
// biscuit-wasm is installed outside the repo; set BISCUIT_WASM to its
// module/biscuit.js (default /tmp/authz/node-biscuit/...).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const B = await import(
  process.env.BISCUIT_WASM ?? "/tmp/authz/node-biscuit/node_modules/@biscuit-auth/biscuit-wasm/module/biscuit.js"
);
const { AuthorizerBuilder, Biscuit, BiscuitBuilder, BlockBuilder, KeyPair, PrivateKey } = B;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "../../../packages/runner-protocol/fixtures/authz/datalog");

type Block = { type: "attenuation"; code: string } | { type: "third_party"; signer: string; code: string };
type Fixture = {
  name: string;
  test_only_keys: { root_private: string; root_key_id: number; approval_private: string; other_private: string };
  token: { signed_by: string; authority: string; blocks: Block[] };
  authorizer: string;
  revoked_blocks: number[];
  actions: string[];
  expect: "allow" | "deny";
};

const priv = (hex: string) => PrivateKey.fromString(`ed25519-private/${hex}`);
const pub = (hex: string) => KeyPair.fromPrivateKey(priv(hex)).getPublicKey();
const signerHex = (f: Fixture, s: string) =>
  ({ root: f.test_only_keys.root_private, approval: f.test_only_keys.approval_private, other: f.test_only_keys.other_private })[s]!;
// The provider must return a PublicKey: throwing (or returning anything else)
// panics inside the wasm module (KeyProvider unwraps). Unknown ids therefore
// get a key nobody signs with, so verification fails cleanly.
const NOBODY = new KeyPair().getPublicKey();

export function mint(f: Fixture) {
  const b = new BiscuitBuilder();
  b.addCode(f.token.authority);
  b.setRootKeyId(f.test_only_keys.root_key_id);
  let token = b.build(priv(signerHex(f, f.token.signed_by)));
  for (const blk of f.token.blocks) {
    const bb = new BlockBuilder();
    bb.addCode(blk.code);
    if (blk.type === "attenuation") token = token.appendBlock(bb);
    else {
      const hex = signerHex(f, blk.signer);
      const signed = token.getThirdPartyRequest().createBlock(priv(hex), bb);
      token = token.appendThirdPartyBlock(pub(hex), signed);
    }
  }
  return token;
}

function verify(bytes: Uint8Array, f: Fixture): { token: any; keyId: number | null } {
  let keyId: number | null = null;
  const root = pub(f.test_only_keys.root_private);
  const token = Biscuit.fromBytesWithProvider(bytes, (id: number | null) => {
    keyId = id;
    return id === f.test_only_keys.root_key_id ? root : NOBODY;
  });
  return { token, keyId };
}

const brief = (e: unknown) => {
  const s = typeof e === "string" ? e : JSON.stringify(e);
  return s.length > 160 ? `${s.slice(0, 160)}...` : s;
};

export function evaluate(bytes: Uint8Array, f: Fixture): { verdict: "allow" | "deny"; reason: string; keyId?: number | null } {
  let v;
  try {
    v = verify(bytes, f);
  } catch (e) {
    return { verdict: "deny", reason: `verify: ${brief(e)}` };
  }
  const ids: string[] = v.token.getRevocationIdentifiers();
  const revoked = new Set(f.revoked_blocks.map((i) => ids[i]));
  if (ids.some((id) => revoked.has(id))) return { verdict: "deny", reason: "revoked", keyId: v.keyId };
  for (const [i, ambient] of f.actions.entries()) {
    try {
      const ab = new AuthorizerBuilder();
      ab.addCode(f.authorizer);
      ab.addCode(ambient);
      const auth = ab.buildAuthenticated(v.token);
      auth.authorize();
      auth.free();
    } catch (e) {
      return { verdict: "deny", reason: `action ${i}: ${brief(e)}`, keyId: v.keyId };
    }
  }
  v.token.free();
  return { verdict: "allow", reason: "", keyId: v.keyId };
}

const fixtures: Fixture[] = readdirSync(fixtureDir)
  .filter((n) => n.endsWith(".json"))
  .sort()
  .map((n) => JSON.parse(readFileSync(join(fixtureDir, n), "utf8")));

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

if (args.includes("--bench")) {
  const n = Number(flag("--bench") ?? 10000) || 10000;
  const f = fixtures.find((x) => x.name === "push-main-approved-sha-allowed")!;
  // Same shape as the Rust bench token: authority + attenuation + approval.
  f.token.blocks = [
    {
      type: "attenuation",
      code: `check if req_git_push($h, $r, $ref, $o, $n), $ref.starts_with("refs/heads/cube/t1/")\n  or req_git_push($h, $r, "refs/heads/main", $o, $n)\n  or req_git_fetch($h, $r)\n  or req_http($h, "GET", $path)\n  or req_github_api($r, $op);`,
    },
    f.token.blocks[0],
  ];
  const bytes = mint(f).toBytes();
  // Failures = authorizations that should allow but threw (RunLimit timeout).
  const run = (label: string, fn: () => void) => {
    let failures = 0;
    const call = () => {
      try {
        fn();
      } catch {
        failures++;
      }
    };
    for (let i = 0; i < n / 10; i++) call();
    const warmFailures = failures;
    failures = 0;
    const t: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = process.hrtime.bigint();
      call();
      t.push(Number(process.hrtime.bigint() - s) / 1000);
    }
    t.sort((a, b) => a - b);
    const q = (p: number) => t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(1);
    console.log(`${label.padEnd(36)} n=${n} p50=${q(0.5)}us p90=${q(0.9)}us p99=${q(0.99)}us max=${t[t.length - 1].toFixed(1)}us failures=${failures} (warm-up failures ${warmFailures})`);
  };
  run("ts_verify", () => verify(bytes, f).token.free());
  const { token } = verify(bytes, f);
  run("ts_authorize_push_main_approved", () => {
    const ab = new AuthorizerBuilder();
    ab.addCode(f.authorizer);
    ab.addCode(f.actions[0]);
    const a = ab.buildAuthenticated(token);
    a.authorize();
    a.free();
  });
  run("ts_verify_plus_authorize", () => {
    const r = evaluate(bytes, f);
    if (r.verdict !== "allow") throw new Error(r.reason);
  });
  process.exit(0);
}

if (args.includes("--warmup")) {
  const f = fixtures[0];
  try {
    evaluate(mint(f).toBytes(), f);
  } catch {}
}

const mintTo = flag("--mint-to");
const verifyFrom = flag("--verify-from");
if (mintTo) mkdirSync(mintTo, { recursive: true });
let bad = 0;
for (const f of fixtures) {
  let bytes: Uint8Array;
  if (verifyFrom) {
    const b64 = readFileSync(join(verifyFrom, `${f.name}.b64`), "utf8").trim();
    bytes = Buffer.from(b64, "base64url");
  } else {
    const t = mint(f);
    bytes = t.toBytes();
    if (mintTo) writeFileSync(join(mintTo, `${f.name}.b64`), t.toBase64());
  }
  const r = evaluate(bytes, f);
  const ok = r.verdict === f.expect;
  if (!ok) bad++;
  // Root key id read back through the provider (only reached when the
  // token parses; biscuit-wasm has no direct getter).
  const kid = r.keyId === undefined ? "-" : String(r.keyId);
  console.log(`${ok ? "ok" : "MISMATCH"}\t${f.name}\t${r.verdict}\t${f.expect}\tkey_id=${kid}\t${r.reason}`);
}
console.log(`ts: ${fixtures.length} fixtures, ${bad} mismatches`);
process.exit(bad === 0 ? 0 : 1);
