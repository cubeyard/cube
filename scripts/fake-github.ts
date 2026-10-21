/** A local GitHub for the end-to-end tests (runner-vm-test.ts, B-5, and
 * runner-vm-cubed-test.ts): HTTPS for github.com and api.github.com with its
 * own CA, `api.github.com/user` for the token, smart HTTP for repositories
 * under `dir` through `git http-backend` with `x-access-token:<token>` as
 * Basic credentials, and a skills repository. A cube-gateway built with
 * `test-hooks` reaches it through `--test-upstream`.
 *
 * `/cube-test/...` answers the credential tests (B-5) on either host,
 * whatever the credentials: `echo` (Authorization echoed in `x-echo-auth`
 * and the body, with Content-Length), `split?at=N` (the same body chunked,
 * cut at byte N of the value, 100 ms apart), `gzip` (gzip-encoded),
 * `redirect?to=URL` (302) and `large?mib=N` (N MiB, the value in every
 * 64 KiB). `seen` records what credentials each request carried. */
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";

export interface FakeGithub {
  port: number;
  ca: string;
  repository: string;
  skills: { url: string; commit: string; path: string; bare: string };
  /** `METHOD host/path auth=<scheme or none>` per request. */
  requests: string[];
  /** Per request: whether its Authorization held the token, a placeholder,
   * something else or nothing, and its Accept-Encoding. */
  seen: Array<{ method: string; host: string; path: string; auth: "token" | "placeholder" | "other" | "none"; acceptEncoding: string }>;
  /** Per request from its start (`seen` gets it at its end): the body bytes
   * received so far, and whether the body ended (false while it streams or
   * when the connection was cut). */
  bodies: Array<{ method: string; path: string; bytes: number; ended: boolean }>;
  close(): void;
}

/** Fails unless the certificate at `file` is signed with ecdsa-with-SHA256,
 * read from its DER rather than from openssl's text, which differs between
 * OpenSSL and LibreSSL. */
export function requireEcdsaSha256(file: string): void {
  const oid = new X509Certificate(fs.readFileSync(file)).signatureAlgorithmOid;
  if (oid !== "1.2.840.10045.4.3.2") throw new Error(`fake-github: ${file} is signed with ${oid}, not ecdsa-with-SHA256 (1.2.840.10045.4.3.2)`);
}

/** The DER start of a P-256 key named by OID: SubjectPublicKeyInfo,
 * id-ecPublicKey, prime256v1. */
const P256_SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107", "hex");

/** Fails unless the key in the certificate at `file` names P-256 by OID.
 * LibreSSL (macOS /usr/bin/openssl) writes the curve's explicit parameters
 * by default, which Node's TLS and the gateway rightly refuse. Read from the
 * key's DER: asymmetricKeyDetails reports prime256v1 for explicit keys too. */
export function requireNamedP256(file: string): void {
  const spki = new X509Certificate(fs.readFileSync(file)).publicKey.export({ type: "spki", format: "der" });
  if (!spki.subarray(0, P256_SPKI.length).equals(P256_SPKI)) throw new Error(`fake-github: ${file} does not name P-256 in its key (explicit EC parameters?)`);
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube E2E", "-c", "user.email=e2e@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();

export function fakeGithub(options: { dir: string; token: string }): Promise<FakeGithub> {
  const { dir, token: fakeToken } = options;
  fs.mkdirSync(path.join(dir, "cube-e2e"), { recursive: true });
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  // The digest and the curve encoding are explicit: LibreSSL (macOS
  // /usr/bin/openssl) may sign with SHA-1 and writes explicit curve
  // parameters by default, and the gateway rightly refuses both.
  openssl("req", "-x509", "-sha256", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=cube e2e test ca");
  fs.writeFileSync(path.join(dir, "san.ext"), "subjectAltName=DNS:github.com,DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=github.com");
  openssl("x509", "-req", "-sha256", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "san.ext");
  requireEcdsaSha256(path.join(dir, "leaf.pem"));
  requireNamedP256(path.join(dir, "ca.pem"));
  requireNamedP256(path.join(dir, "leaf.pem"));
  const seedTree = path.join(dir, "seed");
  fs.mkdirSync(seedTree);
  git(seedTree, "init", "-q", "--initial-branch=main");
  fs.writeFileSync(path.join(seedTree, "README.md"), "e2e\n");
  git(seedTree, "add", "README.md");
  git(seedTree, "commit", "-qm", "base");
  const repository = path.join(dir, "cube-e2e", "repo.git");
  git(dir, "clone", "-q", "--bare", seedTree, repository);
  // Skills the thread installs: one links the other by ../<name>/SKILL.md.
  const skillsTree = path.join(dir, "skills-seed");
  for (const [name, body] of [["target", "the linked skill\n"], ["linking", "see [target](../target/SKILL.md)\n"]]) {
    fs.mkdirSync(path.join(skillsTree, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(skillsTree, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: e2e ${name}\n---\n${body}`);
  }
  git(skillsTree, "init", "-q", "--initial-branch=main");
  git(skillsTree, "add", "-A");
  git(skillsTree, "commit", "-qm", "skills");
  const skillsBare = path.join(dir, "cube-e2e", "skills.git");
  git(dir, "clone", "-q", "--bare", skillsTree, skillsBare);
  const skills = { url: "https://github.com/cube-e2e/skills.git", commit: git(skillsTree, "rev-parse", "HEAD").trim(), path: "skills", bare: skillsBare };
  const requests: string[] = [];
  const seen: FakeGithub["seen"] = [];
  const bodies: FakeGithub["bodies"] = [];
  const classify = (auth: string): FakeGithub["seen"][number]["auth"] => {
    const basic = /^Basic (.+)$/i.exec(auth)?.[1];
    const decoded = basic ? Buffer.from(basic, "base64").toString() : "";
    if (auth.includes(fakeToken) || decoded.includes(fakeToken)) return "token";
    if (auth.includes("cube_ph_") || decoded.includes("cube_ph_")) return "placeholder";
    return auth ? "other" : "none";
  };
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (request, response) => {
    const chunks: Buffer[] = [];
    const body = { method: request.method ?? "", path: new URL(request.url!, "https://github.com").pathname, bytes: 0, ended: false };
    bodies.push(body);
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); body.bytes += chunk.length; });
    request.on("end", () => {
      body.ended = true;
      const auth = request.headers.authorization ?? "";
      const host = request.headers.host?.split(":")[0];
      requests.push(`${request.method} ${host}${request.url} auth=${auth ? auth.split(" ")[0] : "none"}`);
      const url = new URL(request.url!, "https://github.com");
      seen.push({ method: request.method ?? "", host: host ?? "", path: url.pathname, auth: classify(auth), acceptEncoding: String(request.headers["accept-encoding"] ?? "") });
      if (url.pathname.startsWith("/cube-test/")) { testRoute(url, auth, response); return; }
      if (host === "api.github.com") {
        const token = /^(?:token|Bearer) (.+)$/.exec(auth)?.[1];
        if (token !== fakeToken) { response.writeHead(401, { "content-type": "application/json" }); response.end('{"message":"Bad credentials"}'); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ login: "cube-e2e", id: 1 }));
        return;
      }
      const basic = /^Basic (.+)$/.exec(auth)?.[1];
      if (!basic || Buffer.from(basic, "base64").toString() !== `x-access-token:${fakeToken}`) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
        response.end();
        return;
      }
      const backend = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x-access-token", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(Buffer.concat(chunks).length),
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "", GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "") } });
      const out: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      backend.stdin.end(Buffer.concat(chunks));
      backend.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, split).toString().split("\r\n");
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head) {
          const [name, ...rest] = line.split(":");
          if (name.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0]);
          else headers[name] = rest.join(":").trim();
        }
        response.writeHead(status, headers);
        response.end(all.subarray(split + 4));
      });
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    resolve({ port, ca: path.join(dir, "ca.pem"), repository, skills, requests, seen, bodies, close: () => { server.closeAllConnections(); server.close(); } });
  }));
}

/** The B-5 routes; see the header. */
function testRoute(url: URL, auth: string, response: import("node:http").ServerResponse): void {
  const body = `auth=[${auth}]`;
  switch (url.pathname) {
    case "/cube-test/echo":
      response.writeHead(200, { "x-echo-auth": auth, "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    case "/cube-test/split": {
      const at = Math.min(Number(url.searchParams.get("at")), auth.length);
      response.writeHead(200, { "x-echo-auth": auth, "content-type": "text/plain" });
      response.write(`auth=[${auth.slice(0, at)}`);
      setTimeout(() => response.end(`${auth.slice(at)}]`), 100);
      return;
    }
    case "/cube-test/gzip":
      response.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      response.end(zlib.gzipSync(body));
      return;
    case "/cube-test/redirect":
      response.writeHead(302, { location: url.searchParams.get("to") ?? "https://example.com/" });
      response.end();
      return;
    case "/cube-test/large": {
      const total = Number(url.searchParams.get("mib")) * 1024 * 1024;
      const block = Buffer.alloc(65536, "x");
      Buffer.from(`${auth}\n`).copy(block);
      let sent = 0;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const more = () => {
        while (sent < total) {
          sent += block.length;
          if (!response.write(block)) { response.once("drain", more); return; }
        }
        response.end();
      };
      response.on("close", () => { sent = total; });
      more();
      return;
    }
    default:
      response.writeHead(404);
      response.end();
  }
}
