/** Checks a real `claude` against cube's model channel: cubed's own
 * EgressPolicy and ClaudeModelChannel on a decision socket, the real
 * cube-gateway under cubed's GatewaySupervisor, and `claude -p` started with
 * the environment cubed gives a claude-code child (claudeEnvironment and the
 * channel's base URL and placeholder), in a config directory of its own.
 *
 * Offline (the default) api.anthropic.com is a local TLS fake reached
 * through the gateway's test hooks, so it needs a test-hooks build:
 *   CARGO_TARGET_DIR=target/test-hooks cargo build -p cube-gateway --features test-hooks
 *   node scripts/check-claude-model-channel.ts [--gateway target/test-hooks/debug/cube-gateway]
 * The fake answers with the token echoed back and a web search result, so
 * the check sees the token go upstream, only the placeholder come back, the
 * audit row and its event.
 *
 * `--real` is the one subscription session: the gateway without test hooks
 * (`cargo build -p cube-gateway`), the real api.anthropic.com, and the
 * host's long-lived token from `claude setup-token` in this process's
 * CLAUDE_CODE_OAUTH_TOKEN (as cubed reads it). One short prompt. It prints
 * routes, statuses, outcomes and hashes, never the token or a body.
 *
 * Both modes put a CONNECT-logging proxy in the child's HTTPS_PROXY (an
 * allow-listed variable) to list hosts Claude Code reaches without the base
 * URL; offline it refuses them, `--real` tunnels them unread.
 *
 *   CLAUDE=<path> names the binary (default: claude on PATH). */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeEnvironment } from "../packages/server/src/claude-agent.ts";
import { claudeSecret, EgressPolicy, serveEgress } from "../packages/server/src/egress-policy.ts";
import { GatewaySupervisor } from "../packages/server/src/gateway.ts";
import { ClaudeModelChannel } from "../packages/server/src/model-channel.ts";

const real = process.argv.includes("--real");
const gatewayArg = process.argv.indexOf("--gateway");
const repo = path.resolve(import.meta.dirname, "..");
const gatewayBinary = gatewayArg > 0 ? path.resolve(process.argv[gatewayArg + 1]!)
  : path.join(repo, real ? "target/debug/cube-gateway" : "target/test-hooks/debug/cube-gateway");
const claude = process.env.CLAUDE ?? "claude";
const THREAD = "check-model-channel";
const OFFLINE_TOKEN = "sk-ant-oat01-offline-check-token-0123456789abcdef";
const token = real ? process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() : OFFLINE_TOKEN;
if (!token) {
  console.error("--real needs the host's long-lived token from `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN");
  process.exit(2);
}
fs.accessSync(gatewayBinary, fs.constants.X_OK);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-model-channel-"));
fs.chmodSync(temp, 0o700);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const gatewayLines: string[] = [];
const gatewayLog = { ...quiet, info: (message: string, fields?: { line?: string }) => { if (fields?.line) gatewayLines.push(fields.line); }, child() { return gatewayLog; } };

/** Offline: a TLS fake of api.anthropic.com with its own CA. */
async function fakeAnthropic(): Promise<{ address: string; ca: string; seen: Array<{ method: string; url: string; auth: string; beta: string }> }> {
  const ca = path.join(temp, "ca.pem");
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: temp, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=check-ca"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "api.key", "-out", "api.csr", "-subj", "/CN=api.anthropic.com"]);
  fs.writeFileSync(path.join(temp, "ext"), "subjectAltName=DNS:api.anthropic.com\n");
  run(["x509", "-req", "-in", "api.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "api.pem", "-days", "1", "-extfile", "ext"]);
  const seen: Array<{ method: string; url: string; auth: string; beta: string }> = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(temp, "api.key")), cert: fs.readFileSync(path.join(temp, "api.pem")) }, (request, response) => {
    request.resume();
    request.on("end", () => {
      const auth = request.headers.authorization ?? "";
      seen.push({ method: request.method!, url: request.url!, auth, beta: String(request.headers["anthropic-beta"] ?? "") });
      const echoed = auth.replace(/^Bearer /, "");
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_offline" });
      response.write(event("message_start", { type: "message_start", message: { id: "msg_check", type: "message", role: "assistant", model: "claude-check", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
      response.write(event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_check",
        content: [{ type: "web_search_result", url: "https://example.com/", title: "example", encrypted_content: "x", page_age: null }] } }));
      response.write(event("content_block_stop", { type: "content_block_stop", index: 0 }));
      response.write(event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
      response.write(event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `pong (upstream saw ${echoed})` } }));
      response.write(event("content_block_stop", { type: "content_block_stop", index: 1 }));
      response.write(event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
      response.end(event("message_stop", { type: "message_stop" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, ca, seen };
}

/** A proxy for the child's HTTPS_PROXY: logs each CONNECT's host; tunnels
 * it unread with --real, refuses it offline. */
async function connectLog(): Promise<{ url: string; hosts: string[] }> {
  const hosts: string[] = [];
  const proxy = http.createServer((_, response) => { response.writeHead(403); response.end(); });
  proxy.on("connect", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => {});
    hosts.push(request.url ?? "");
    if (!real) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const [host, port] = (request.url ?? "").split(":");
    const upstream = net.connect(Number(port ?? 443), host!, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, hosts };
}

const fake = real ? null : await fakeAnthropic();
const proxy = await connectLog();
let gateway: GatewaySupervisor | null = null;
const channel = new ClaudeModelChannel({ secret: claudeSecret({ CLAUDE_CODE_OAUTH_TOKEN: token }), address: () => gateway?.modelAddress ?? null,
  unavailable: () => gateway?.unavailable ?? null, started: () => gateway?.ready() ?? Promise.resolve() });
const egress = await serveEgress(path.join(temp, "egress.sock"), new EgressPolicy({ vms: { vm: () => null }, secrets: [], model: channel, log: quiet as never }));
const audit = path.join(temp, "model-audit.sqlite");
gateway = new GatewaySupervisor({ binary: gatewayBinary, decide: path.join(temp, "egress.sock"), credential: path.join(temp, "credential.sock"), model: { audit },
  extraArgs: fake ? ["--test-upstream", `api.anthropic.com=${fake.address}`, "--test-upstream-ca", fake.ca] : [], log: gatewayLog as never });
gateway.start();
let exitCode = 1;
try {
  await channel.ready();
  const modelEnv = channel.environment(THREAD);
  const home = path.join(temp, "home");
  fs.mkdirSync(home);
  const env = claudeEnvironment({ PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(temp, "config"), HTTPS_PROXY: proxy.url, LANG: "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: "must-not-reach" }, {}, modelEnv);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, modelEnv.CLAUDE_CODE_OAUTH_TOKEN, "the child holds the placeholder");
  assert.ok(Object.values(env).every(value => !value?.includes(token)), "the token is in no variable of the child");
  const version = execFileSync(claude, ["--version"], { env, encoding: "utf8" }).trim();
  const work = path.join(temp, "work");
  fs.mkdirSync(work);
  const child = spawn(claude, ["-p", "Reply with the single word pong.", "--model", "haiku", "--output-format", "json", "--setting-sources", "", "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", ""], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 180_000); child.on("close", status => { clearTimeout(timer); resolve(status); }); });
  let result: { is_error?: boolean; result?: string; api_error_status?: unknown; subtype?: string } = {};
  try { result = JSON.parse(stdout) as typeof result; } catch { /* reported below */ }
  await new Promise(resolve => setTimeout(resolve, 500));
  const db = new DatabaseSync(audit, { readOnly: true });
  const rows = db.prepare("SELECT seq, method, route, outcome, status, reason, request_sha256 AS request, response_sha256 AS response, response_message_sha256 AS message, request_headers AS headers, (SELECT count(*) FROM event WHERE event.exchange=exchange.seq) AS events FROM exchange WHERE thread=? ORDER BY seq").all(THREAD) as Array<Record<string, unknown>>;
  db.close();
  const files = ["", "-wal", "-shm"].map(suffix => `${audit}${suffix}`).filter(file => fs.existsSync(file));
  const leaks = {
    claudeOutput: (stdout + stderr).includes(token),
    gatewayLog: gatewayLines.some(line => line.includes(token)),
    auditFiles: files.some(file => fs.readFileSync(file).includes(token)),
  };
  const report = {
    mode: real ? "real api.anthropic.com" : "offline fake api.anthropic.com",
    claude: version, exit: code, subtype: result.subtype ?? null, isError: result.is_error ?? null, apiErrorStatus: result.api_error_status ?? null,
    resultSha256: result.result ? sha(result.result) : null, resultLength: result.result?.length ?? null,
    routes: rows.map(row => ({ method: row.method, route: row.route, outcome: row.outcome, status: row.status, reason: row.reason, events: row.events,
      requestSha256: row.request, responseSha256: row.response, messageSha256: row.message,
      oauthBeta: String(row.headers).includes("oauth-2025-04-20") })),
    directHosts: [...new Set(proxy.hosts)],
    tokenFound: leaks,
    ...fake ? { upstreamSaw: fake.seen.map(seen => ({ method: seen.method, url: seen.url, bearerIsToken: seen.auth === `Bearer ${token}`, oauthBeta: seen.beta.includes("oauth-2025-04-20") })) } : {},
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(!leaks.claudeOutput && !leaks.gatewayLog && !leaks.auditFiles, "the token appears nowhere outside the gateway's request");
  assert.equal(code, 0, `claude exited ${code}`);
  assert.equal(result.is_error, false, "the session answered");
  const forwarded = rows.filter(row => row.outcome === "forwarded" && String(row.route).startsWith("/v1/messages"));
  assert.ok(forwarded.length > 0 && forwarded.every(row => row.status === 200), "model requests went through the channel and were answered");
  if (fake) {
    assert.ok(fake.seen.length > 0 && fake.seen.every(seen => seen.auth === `Bearer ${token}`), "the token went upstream");
    assert.ok(result.result?.includes(modelEnv.CLAUDE_CODE_OAUTH_TOKEN), "the echoed token came back as the placeholder");
    assert.ok(forwarded.some(row => Number(row.events) === 1), "the web search result is its own audit event");
    const db2 = new DatabaseSync(audit, { readOnly: true });
    const message = JSON.parse(Buffer.from((db2.prepare("SELECT bytes FROM blob WHERE sha256=?").get(String(forwarded[0]!.message)) as { bytes: Uint8Array }).bytes).toString("utf8")) as { content: Array<{ type: string; text?: string }> };
    db2.close();
    assert.deepEqual(message.content.map(block => block.type), ["web_search_tool_result", "text"], "the stream reconstructed as one message");
    assert.ok(message.content[1]!.text?.includes(modelEnv.CLAUDE_CODE_OAUTH_TOKEN), "the reconstructed text holds the placeholder");
  }
  console.log(`ok: ${report.mode}: claude ${version} through cube's model channel; token only upstream; audit by hash`);
  exitCode = 0;
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await gateway.stop();
  await egress.close();
  if (!process.argv.includes("--keep")) fs.rmSync(temp, { recursive: true, force: true });
  else console.log(`kept ${temp}`);
}
process.exit(exitCode);
