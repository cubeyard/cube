/** A local GitHub for the end-to-end tests (test-vm-e2e.ts, p3; and
 * runner-vm-test.ts, B-5): HTTPS for github.com and api.github.com with its
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
  close(): void;
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube E2E", "-c", "user.email=e2e@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();

export function fakeGithub(options: { dir: string; token: string }): Promise<FakeGithub> {
  const { dir, token: fakeToken } = options;
  fs.mkdirSync(path.join(dir, "cube-e2e"), { recursive: true });
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=cube e2e test ca");
  fs.writeFileSync(path.join(dir, "san.ext"), "subjectAltName=DNS:github.com,DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=github.com");
  openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "san.ext");
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
  const classify = (auth: string): FakeGithub["seen"][number]["auth"] => {
    const basic = /^Basic (.+)$/i.exec(auth)?.[1];
    const decoded = basic ? Buffer.from(basic, "base64").toString() : "";
    if (auth.includes(fakeToken) || decoded.includes(fakeToken)) return "token";
    if (auth.includes("cube_ph_") || decoded.includes("cube_ph_")) return "placeholder";
    return auth ? "other" : "none";
  };
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
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
    resolve({ port, ca: path.join(dir, "ca.pem"), repository, skills, requests, seen, close: () => { server.closeAllConnections(); server.close(); } });
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
