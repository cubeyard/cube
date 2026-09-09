import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CHECKS, collectDiagnostics, readDiagnosticFile, redact, runCheck } from "../src/diagnostics.ts";
import { piArguments } from "../src/diagnose-cli.ts";

const exec = promisify(execFile);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cube-diagnostics-"));
const repo = path.resolve(import.meta.dirname, "../../..");
try {
  const sensitive = `password="two words"\nAuthorization: Bearer made-up-auth\nhttps://alice:made-up-password@example.org\n{"api_key":"made-up-key"}\nghp_fixture123\n-----BEGIN RSA PRIVATE KEY-----\nprivate-material\n-----END RSA PRIVATE KEY-----\nECONNREFUSED 127.0.0.1:7777`;
  const clean = redact(sensitive);
  for (const secret of ["two words", "made-up-auth", "made-up-password", "made-up-key", "ghp_fixture123", "private-material"]) assert.ok(!clean.includes(secret));
  assert.match(clean, /ECONNREFUSED 127\.0\.0\.1:7777/);
  const calls: string[] = [];
  const { directory, id } = await collectDiagnostics(path.join(tmp, "cube/diagnostics"), async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "systemctl") throw new Error("system bus unavailable");
    if (command === "uname") return { status: "ok", output: "ø".repeat(40_000) };
    return { status: "ok", output: command === "journalctl" ? sensitive : "snapshot" };
  }, async () => ({ status: "error", output: "ECONNREFUSED 127.0.0.1:7777" }));
  assert.equal(calls.length, CHECKS.length);
  const bundle = path.join(directory, "bundle");
  const index = await fs.readFile(path.join(bundle, "index.md"), "utf8");
  assert.match(index, /units.txt: error/);
  assert.match(index, /control-plane.txt: error/);
  assert.match(index, /versions.txt: ok/);
  assert.match(await fs.readFile(path.join(bundle, "units.txt"), "utf8"), /system bus unavailable/);
  assert.match(await readDiagnosticFile(bundle, "host.txt"), /\[TRUNCATED\]/);
  assert.ok((await fs.stat(path.join(bundle, "host.txt"))).size < 68_000, "UTF-8 bounded by bytes, not characters");
  assert.equal((await fs.stat(path.join(bundle, "index.md"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(bundle)).mode & 0o777, 0o700);
  console.log("1 ok: partial collection, bounded commands, redaction and private files");

  await fs.writeFile(path.join(bundle, "sample.txt"), "first\nsecond\nthird\nfourth");
  assert.equal(await readDiagnosticFile(bundle, "sample.txt", 2, 2), "2: second\n3: third");
  for (const name of ["../sample.txt", "/etc/passwd", "nested/sample.txt", "sample.txt/..", "session.jsonl"]) {
    await assert.rejects(readDiagnosticFile(bundle, name));
  }
  await fs.writeFile(path.join(tmp, "secret.txt"), "do not disclose");
  await fs.symlink(path.join(tmp, "secret.txt"), path.join(bundle, "link.txt"));
  await assert.rejects(readDiagnosticFile(bundle, "link.txt"));
  await fs.link(path.join(tmp, "secret.txt"), path.join(bundle, "hardlink.txt"));
  await assert.rejects(readDiagnosticFile(bundle, "hardlink.txt"));
  await fs.mkdir(path.join(bundle, "directory.txt"));
  await assert.rejects(readDiagnosticFile(bundle, "directory.txt"));
  await fs.writeFile(path.join(bundle, "large.txt"), "x".repeat(70_000));
  await assert.rejects(readDiagnosticFile(bundle, "large.txt"));
  await assert.rejects(readDiagnosticFile(bundle, "sample.txt", 0));
  await assert.rejects(readDiagnosticFile(bundle, "sample.txt", 1, 501));
  for (const name of ["link.txt", "hardlink.txt", "directory.txt", "large.txt"]) await fs.rm(path.join(bundle, name), { recursive: true });
  const missing = await runCheck("cube-diagnosis-nonexistent-command", []);
  assert.equal(missing.status, "error");
  assert.match(missing.output, /ENOENT/);
  const overflow = await runCheck(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"]);
  assert.equal(overflow.status, "error");
  console.log("2 ok: numbered reads, traversal/link/special-file rejection and output limits");

  await fs.writeFile(path.join(directory, "session.jsonl"), "never export session");
  await fs.writeFile(path.join(directory, "report.md"), "fixture report");
  const cli = path.join(repo, "packages/pi-extension/src/diagnose-cli.ts");
  const archive = execFileSync(process.execPath, [cli, "--export", id], { env: { PATH: process.env.PATH, HOME: tmp } });
  const listing = execFileSync("tar", ["-tzf", "-"], { input: archive, encoding: "utf8" });
  assert.match(listing, /bundle\/index.md/);
  assert.match(listing, /report.md/);
  assert.doesNotMatch(listing, /session/);
  await fs.rm(path.join(directory, "session.jsonl"));
  await assert.rejects(exec(process.execPath, [cli, "--export", "../escape"], { env: { PATH: process.env.PATH, HOME: tmp } }));

  const launcher = `source launcher/cube; touch "$SSH_KEY"; vm_ssh() { printf '%s\\n' "$@"; }; cmd_ssh() { printf 'interactive\\n%s\\n' "$*"; read -r line; printf '%s\\n' "$line"; }; cmd_diagnose "$@"`;
  const shellEnv = { PATH: process.env.PATH, HOME: tmp, CUBE_HOME: tmp, CUBE_LIB_ONLY: "1" };
  const forwarded = (await exec("bash", ["-c", launcher, "test", "--export", id], { cwd: repo, env: shellEnv })).stdout;
  assert.equal(forwarded, `sh\n/opt/cube/app/scripts/diagnose.sh\n--export\n${id}\n`);
  const interactive = exec("bash", ["-c", launcher, "test"], { cwd: repo, env: shellEnv });
  interactive.child.stdin?.end("user input\n");
  assert.equal((await interactive).stdout, "interactive\nsh /opt/cube/app/scripts/diagnose.sh\nuser input\n");
  await assert.rejects(exec("bash", ["-c", launcher, "test", "--export", "x; echo unsafe"], { cwd: repo, env: shellEnv }));
  console.log("3 ok: archive excludes sessions; launcher safely forwards and rejects arguments");

  // Real Pi CLI + real extension + local fake model. No credentials or external inference.
  const agentDir = path.join(tmp, "agent");
  await fs.mkdir(agentDir);
  const requests: any[] = [];
  let evidencePath = "sample.txt";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (requests.length % 2 === 1) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: evidencePath, offset: 2, limit: 2 }) } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: `RCA fixture completed with ${request.model}.` });
      chunk({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-not-a-secret",
      models: ["fixture", "second"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    } } }));
    await fs.writeFile(path.join(bundle, "AGENTS.md"), "HOSTILE_CONTEXT_CANARY");
    const args = piArguments(directory);
    assert.ok(!args.includes("--print") && !args.includes("--mode") && !args.includes("--"), "production launch waits for user input");
    args.unshift("--print", "--provider", "fixture", "--model", "fixture", "--thinking", "off");
    args.push("--", "The service cannot connect. Please investigate.");
    const running = exec(path.join(repo, "packages/harness/node_modules/.bin/pi"), args, {
      cwd: bundle, timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: tmp, PI_CODING_AGENT_DIR: agentDir, CUBE_DIAGNOSIS_BUNDLE: bundle, PI_OFFLINE: "1" },
    });
    running.child.stdin?.end();
    const result = await running;
    assert.match(result.stdout, /RCA fixture completed/);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools.map((t: any) => t.function.name), ["read"]);
    assert.ok(requests[1].messages.some((m: any) => m.role === "tool" && m.content === "2: second\n3: third"));
    assert.ok(!JSON.stringify(requests).includes("HOSTILE_CONTEXT_CANARY"));
    assert.equal(await fs.readFile(path.join(directory, "report.md"), "utf8"), "RCA fixture completed with fixture.\n");
    console.log("4 ok: real Pi CLI exposes only custom read, reads bounded evidence, ignores project context, returns report");

    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off" }));
    evidencePath = "index.md";
    const env = { PATH: process.env.PATH, HOME: tmp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    // Reuse the repository's PTY dependency to test the actual interactive CLI.
    const { spawn } = createRequire(path.join(repo, "packages/server/package.json"))("@lydell/node-pty");
    const terminal = spawn(process.execPath, [cli], { cwd: repo, env: { ...env, TERM: "xterm-256color" }, cols: 180, rows: 40 });
    let output = "";
    let exited = false;
    terminal.onData((data: string) => { output += data; });
    terminal.onExit(() => { exited = true; });
    const until = async (description: string, check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 20_000;
      while (!(await check())) {
        if (Date.now() > deadline || exited) throw new Error(`Waiting for ${description}: ${output.slice(-4000)}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    try {
      await until("interactive welcome", () => output.includes("describe the issue to begin"));
      assert.equal(requests.length, 2, "opening the interactive session does not start inference");
      const newId = output.match(/Diagnosis: ([a-f0-9-]{36})/)?.[1];
      assert.ok(newId);
      const newDirectory = path.join(tmp, "cube/diagnostics", newId);
      const report = () => fs.readFile(path.join(newDirectory, "report.md"), "utf8").catch(() => "");
      terminal.write("/model fixture/second\r");
      await until("model selection", () => output.includes("Model: second"));
      terminal.write("services.ensure fails with fetch failed after 7ms\r");
      await until("first report", async () => (await report()) === "RCA fixture completed with second.\n");
      assert.equal(requests.length, 4);
      assert.equal(requests[2].model, "second");
      assert.ok(JSON.stringify(requests[2].messages).includes("services.ensure fails with fetch failed after 7ms"));
      assert.deepEqual(requests[2].tools.map((t: any) => t.function.name), ["read"]);
      terminal.write(`!touch ${path.join(tmp, "shell-escape")}\r`);
      await until("blocked shell", () => output.includes("Shell is disabled in RCA mode"));
      await assert.rejects(fs.stat(path.join(tmp, "shell-escape")));
      terminal.write("/model fixture/fixture\r");
      await until("second model selection", () => output.includes("Model: fixture"));
      terminal.write("The server has no matching logs. Does that change the diagnosis?\r");
      await until("updated report", async () => (await report()) === "RCA fixture completed with fixture.\n");
      assert.equal(requests.length, 6);
      assert.equal(requests[4].model, "fixture");
      assert.ok(JSON.stringify(requests[4].messages).includes("The server has no matching logs"));
      assert.doesNotMatch(await report(), /\x1b/);
      terminal.write("/quit\r");
      await until("clean exit", () => exited);
      const exported = execFileSync(process.execPath, [cli, "--export", newId], { env });
      assert.equal(execFileSync("tar", ["-xzOf", "-", "report.md"], { input: exported, encoding: "utf8" }), "RCA fixture completed with fixture.\n");
    } finally { if (!exited) terminal.kill(); }

    const noAuth = { PATH: process.env.PATH, HOME: tmp, PI_CODING_AGENT_DIR: path.join(tmp, "no-auth"), PI_OFFLINE: "1" };
    const collected = await exec(process.execPath, [cli, "--collect-only"], { env: noAuth, timeout: 30_000 });
    assert.match(collected.stderr, /Diagnosis: /);
    assert.equal(collected.stdout, "");
    assert.equal(requests.length, 6, "collect-only never calls the model");
    await assert.rejects(exec(process.execPath, [cli], { env: noAuth, timeout: 30_000 }), (error: any) => {
      assert.match(error.stderr, /requires a terminal/);
      return true;
    });
    console.log("5 ok: interactive CLI waits for issue, changes models, accepts follow-ups, blocks shell and exports latest report; headless collection still works");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
console.log("ALL PASS: diagnostics");
