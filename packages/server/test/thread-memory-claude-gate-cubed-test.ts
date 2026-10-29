/** A Claude Code thread's start memory through the real cubed (createCubed,
 * so index.ts's own wiring of the gate before each prompt), with OptChat's
 * open hanging: its first prompt's memory block is the honest fallback,
 * frozen in the registry before that prompt was written, and a second
 * prompt carries the same bytes. Only the gate freezes a fallback (a final
 * read, after its own wait, here 400 ms); the mod's route alone would give
 * an unfrozen "cannot be read right now", so this fails if the gate's
 * wiring is gone or not final. OptChat hangs because its first open asks the
 * model catalog for a new chat's model, and that one read never answers.
 * Faux model, fake `claude`, local guest; no network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-gate-"));
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", repository, ...args], { encoding: "utf8" });
git(["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(["add", "README"]);
git(["commit", "-qm", "base"]);

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("ok")));
const real = createModels();
real.setProvider(faux.provider);
/** The catalog, except to OptChat's own open, which waits for it forever. */
let optchatReads = 0;
const models = new Proxy(real, {
  get(target, key, receiver) {
    if (key !== "getAvailable") return Reflect.get(target, key, receiver);
    return () => {
      if (/OptChat\.start/.test(new Error().stack ?? "")) { optchatReads++; return new Promise<never>(() => {}); }
      return target.getAvailable();
    };
  },
}) as Models;
const WAIT_MS = 400;
const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")), gateway: null, memoryWaitMs: WAIT_MS,
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
app.registry.enrollRunner({ nodeId: "node-1", environmentId: 1, threadId: "runner-1", configPath: "/private/1.json", configHash: "h1", protocol: 4, kind: "vm" });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const call = async (route: string, body?: unknown) => {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
  return { status: response.status, body: await response.json() as Record<string, any> };
};
const completed = async (id: string, turns: number) => {
  for (const deadline = Date.now() + 60_000; ; await delay(50)) {
    const history = await call(`/api/threads/${id}/history`);
    const said = (history.body.events ?? []).filter((event: any) => event.type === "assistant-text" && String(event.text).startsWith("memory: ")).map((event: any) => String(event.text).slice("memory: ".length));
    if (history.status === 200 && history.body.status?.state === "completed" && said.length >= turns) return said as string[];
    assert.ok(Date.now() < deadline, `the claude thread answers ${turns} time(s): ${JSON.stringify(history.body).slice(0, 2000)}`);
  }
};

try {
  const project = (await call("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] })).body.project;
  await call(`/api/projects/${project.id}/check`, {});
  const id = (await call("/api/threads", { projectId: project.id, requestId: "claude", model: { provider: "claude-code", id: "sonnet" }, text: "memory" })).body.id as string;
  assert.ok(id, "the thread is accepted");
  const [first] = await completed(id, 1);
  assert.ok(optchatReads >= 1, "OptChat's open is the one left hanging");
  const row = app.registry.threadMemory(id)!;
  assert.equal(typeof row.text, "string", "the gate (a final read) froze a text before the first prompt; the route alone freezes no fallback");
  assert.equal(row.chat, null, "no chat was read");
  assert.match(row.text!, /^Chat memory: [^]*\nThe chat could not be read when this thread started \(OptChat is still opening\), so there is no view of it here; mcp__cube__memory_zoom and mcp__cube__memory_date read all of it once OptChat is open\.$/);
  assert.equal(first, row.text, "the first prompt's block is the fallback the gate froze before it");
  await call(`/api/threads/${id}/prompt`, { text: "memory", requestId: "again" });
  const said = await completed(id, 2);
  assert.deepEqual(said, [row.text, row.text], "the second prompt carries the same bytes");
  console.log("ok: a claude code thread through cubed's own wiring, OptChat hanging: the gate froze the honest fallback before the first prompt, and every prompt carries it");
} finally {
  app.server.closeAllConnections();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
