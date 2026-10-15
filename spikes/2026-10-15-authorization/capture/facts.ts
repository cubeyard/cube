// Spike for the authorization plan, step 2: what a gate can derive from one
// recorded request, and nothing more. Each request becomes one or more
// actions (the facts a policy would see); a request it cannot classify is
// `unclassified` and the plan denies it.
//
//   node facts.ts <corpus.jsonl> <github-ops.json>
//
// github-ops.json: [{ method, path, id }] from github/rest-api-description
// (api.github.com.json, one entry per operation).
import fs from "node:fs";
// graphql-js 16, installed outside the repository for this spike.
import { parse, Kind, type OperationDefinitionNode, type FragmentDefinitionNode, type SelectionNode } from "/tmp/authz/node/node_modules/graphql/index.mjs";

export type Action =
  | { kind: "git_discover"; host: string; repo: string; service: "git-upload-pack" | "git-receive-pack" }
  | { kind: "git_fetch"; host: string; repo: string; protocol: "v0" | "v2"; command?: string }
  | { kind: "git_push"; host: string; repo: string; ref: string; old: string; new: string; change: "create" | "update" | "delete" }
  | { kind: "github_rest"; repo: string | null; method: string; op: string; template: string; bodyRef?: string; sha?: string }
  | { kind: "github_graphql"; type: "query" | "mutation" | "subscription"; fields: string[]; operationName?: string }
  | { kind: "http"; host: string; method: string; path: string }
  | { kind: "unclassified"; host: string; method: string; path: string; why: string };

export interface Recorded {
  scheme: string; host: string; port: number; method: string; target: string;
  headers: [string, string][]; bodyLength: number; body: string;
}

const ZERO = /^0{40}$|^0{64}$/;
const GIT_PATH = /^\/([^/]+\/[^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** pkt-lines up to the first flush-pkt (and the push-options section after it). Throws on malformed input. */
export function pktLines(body: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > body.length) throw new Error("truncated pkt-line length");
    const hex = body.subarray(at, at + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error("invalid pkt-line length");
    const length = parseInt(hex, 16);
    if (length === 0) return { lines, rest: body.subarray(at + 4) };
    // v2's delim-pkt (0001) separates a command's capabilities from its arguments.
    if (length === 1) { lines.push(Buffer.from("\u0001")); at += 4; continue; }
    if (length < 4 || length > 65520) throw new Error("invalid pkt-line length");
    if (at + length > body.length) throw new Error("truncated pkt-line");
    lines.push(body.subarray(at + 4, at + length));
    at += length;
  }
}

/** The ref updates of a receive-pack request: "old new ref[\0caps]" up to the flush. */
export function receivePackCommands(body: Buffer): { ref: string; old: string; new: string }[] {
  const { lines } = pktLines(body);
  if (lines.length === 0) throw new Error("no commands");
  return lines.map((raw, index) => {
    let line = raw.toString("latin1");
    if (index === 0) line = line.split("\0")[0];
    line = line.replace(/\n$/, "");
    if (line.startsWith("shallow ") || line.startsWith("push-cert")) throw new Error(`unsupported: ${line.slice(0, 16)}`);
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/[^\0\s]+)$/.exec(line);
    if (!match) throw new Error("malformed command");
    return { old: match[1], new: match[2], ref: match[3] };
  });
}

function compile(ops: { method: string; path: string; id: string }[]) {
  // A template's last {ref} or {path} may span segments (`/git/refs/{ref}` = heads/main, `/contents/{path}`).
  return ops.map(op => ({ ...op, pattern: new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(?:ref|path)\}$/, "(?:.+)").replace(/\{[^}]+\}/g, "[^/]+")}$`),
    literal: op.path.replace(/\{[^}]+\}/g, "").length }))
    // The most specific template first: /repos/{o}/{r}/pulls before /repos/{o}/{r}/{x}.
    .sort((a, b) => b.literal - a.literal);
}

export function classify(request: Recorded, ops: ReturnType<typeof compile>): Action[] {
  const host = request.host.toLowerCase();
  const method = request.method.toUpperCase();
  const [pathname, query = ""] = request.target.split("?", 2);
  const body = Buffer.from(request.body, "base64");
  const header = (name: string) => request.headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const unclassified = (why: string): Action[] => [{ kind: "unclassified", host, method, path: pathname, why }];
  if (request.scheme !== "https") {
    // Plain http: only package mirrors' GETs, never with a secret.
    return method === "GET" || method === "HEAD" ? [{ kind: "http", host, method, path: pathname }] : unclassified("plain http write");
  }
  if (host === "github.com") {
    const git = GIT_PATH.exec(pathname);
    if (!git) return method === "GET" ? [{ kind: "http", host, method, path: pathname }] : unclassified("github.com non-git write");
    const repo = git[1].toLowerCase();
    if (git[2] === "info/refs") {
      const service = new URLSearchParams(query).get("service");
      if (method !== "GET" || (service !== "git-upload-pack" && service !== "git-receive-pack")) return unclassified("dumb http or unknown service");
      return [{ kind: "git_discover", host, repo, service }];
    }
    if (method !== "POST") return unclassified("git endpoint not POST");
    const encoded = !!header("content-encoding") && header("content-encoding") !== "identity";
    if (git[2] === "git-upload-pack") {
      // A fetch is decided by its repository (the path); its body only says
      // what is fetched. git gzips large fetch requests, so the body is optional.
      const v2 = /version=2/.test(header("git-protocol") ?? "");
      let command: string | undefined;
      if (v2 && !encoded) { try { command = pktLines(body).lines[0]?.toString("latin1").replace(/\n$/, ""); } catch { /* informational */ } }
      return [{ kind: "git_fetch", host, repo, protocol: v2 ? "v2" : "v0", command }];
    }
    // A push is decided by its command list: an encoded one is not read (git does not encode pushes).
    if (encoded) return unclassified("compressed receive-pack request");
    try {
      return receivePackCommands(body).map(c => ({ kind: "git_push" as const, host, repo, ...c,
        change: ZERO.test(c.old) ? "create" as const : ZERO.test(c.new) ? "delete" as const : "update" as const }));
    } catch (error) { return unclassified(`receive-pack: ${(error as Error).message}`); }
  }
  if (host === "api.github.com") {
    if (pathname === "/graphql" && method === "POST") {
      let document: { query?: unknown; operationName?: unknown };
      try { document = JSON.parse(body.toString("utf8")); } catch { return unclassified("graphql body not json"); }
      if (typeof document.query !== "string") return unclassified("graphql without query");
      // A real parser (graphql-js): exactly one operation, no fragments, its type and top-level fields.
      let parsed;
      try { parsed = parse(document.query); } catch { return unclassified("graphql does not parse"); }
      const operations = parsed.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION) as OperationDefinitionNode[];
      if (operations.length !== 1) return unclassified("graphql: not exactly one operation");
      if (parsed.definitions.some(d => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION)) return unclassified("graphql: type system definitions");
      const operation = operations[0];
      const type = operation.operation as "query" | "mutation" | "subscription";
      // Top-level fields, through fragment spreads and inline fragments (directives make a field conditional, not hidden).
      const fragments = new Map(parsed.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [(d as FragmentDefinitionNode).name.value, d as FragmentDefinitionNode]));
      const fields: string[] = [];
      const visit = (selections: readonly SelectionNode[], depth: number): boolean => {
        if (depth > 8) return false;
        for (const selection of selections) {
          if (selection.kind === Kind.FIELD) fields.push(selection.name.value);
          else if (selection.kind === Kind.INLINE_FRAGMENT) { if (!visit(selection.selectionSet.selections, depth + 1)) return false; }
          else { const fragment = fragments.get(selection.name.value); if (!fragment || !visit(fragment.selectionSet.selections, depth + 1)) return false; }
        }
        return true;
      };
      if (!visit(operation.selectionSet.selections, 0)) return unclassified("graphql: unresolvable fragment");
      return [{ kind: "github_graphql", type, fields: [...new Set(fields)], operationName: typeof document.operationName === "string" ? document.operationName : undefined }];
    }
    const op = ops.find(o => o.method.toUpperCase() === method && o.pattern.test(pathname));
    if (!op) return unclassified("no OpenAPI operation for this method and path");
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(pathname)?.[1]?.toLowerCase() ?? null;
    let bodyRef: string | undefined;
    let sha: string | undefined;
    if (body.length) {
      try {
        const json = JSON.parse(body.toString("utf8"));
        bodyRef = typeof json.ref === "string" ? json.ref : typeof json.branch === "string" ? `refs/heads/${json.branch}` : typeof json.base === "string" ? `refs/heads/${json.base}` : undefined;
        if (typeof json.sha === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(json.sha)) sha = json.sha;
      } catch { /* not json */ }
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/refs\/(.+)$/.test(pathname) && method !== "GET") bodyRef = `refs/${/\/git\/refs\/(.+)$/.exec(pathname)![1]}`;
    return [{ kind: "github_rest", repo, method, op: op.id, template: op.path, bodyRef, sha }];
  }
  // Any other host: host, method and path are all a gate can know.
  return [{ kind: "http", host, method, path: pathname }];
}

if (import.meta.main) {
  const [corpus, opsFile] = process.argv.slice(2);
  const ops = compile(JSON.parse(fs.readFileSync(opsFile, "utf8")));
  for (const line of fs.readFileSync(corpus, "utf8").split("\n").filter(Boolean)) {
    const request: Recorded = JSON.parse(line);
    console.log(JSON.stringify({ request: `${request.method} ${request.host}${request.target.slice(0, 80)}`, actions: classify(request, ops) }));
  }
}
export { compile };
