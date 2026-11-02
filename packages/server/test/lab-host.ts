/** Lab: a real cubed on disposable state with a slow faux model, behind a
 * TCP proxy the lab can cut, and restartable on the same state. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

const said = (message: unknown) => JSON.stringify(message) ?? "";
const lastText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { type: string; text?: string }[]).flatMap(part => part.type === "text" ? [part.text ?? ""] : []).at(-1) ?? "" : "";
const allText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { text?: string }[]).map(part => part.text ?? "").join("") : "";

/** `words N`: answers N numbered words; `tool {...}`; `please fail`; else `ok: …`. */
export function words(n: number): string { return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" "); }

export function labModels(tokensPerSecond: number) {
  const faux = fauxProvider({ tokensPerSecond, tokenSize: { min: 3, max: 4 } });
  faux.setResponses(Array.from({ length: 2000 }, () => async request => {
    if (said(request.messages.find(message => message.role === "system")).includes("You write the memory of OptChat")) return fauxAssistantMessage("a summary");
    const last = request.messages.at(-1)!;
    if (last.role === "toolResult") return fauxAssistantMessage(`result: ${allText(last.content).trim()}`);
    const asked = last.role === "user" ? lastText(last.content).trim() : "";
    if (asked.includes("please fail")) throw new Error("the provider refused");
    const count = asked.match(/^words (\d+)/);
    if (count) return fauxAssistantMessage(`${words(Number(count[1]))} end`);
    const tool = asked.match(/^tool (\{.*\})$/m);
    if (tool) {
      const { name, args } = JSON.parse(tool[1]!) as { name: string; args: Record<string, unknown> };
      return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id: `call-${Date.now()}` })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`ok: ${asked.slice(0, 200)}`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: faux.getModel().provider, id: faux.getModel().id } };
}

export async function startLab(scratch: string, tokensPerSecond = 30) {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Lab", "-c", "user.email=lab@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
  const seed = path.join(scratch, "seed");
  fs.mkdirSync(seed);
  git(seed, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(seed, "README.md"), "# demo\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "seed"]);
  const repository = path.join(scratch, "demo.git");
  git(scratch, ["clone", "-q", "--bare", seed, repository]);
  const state = path.join(scratch, "state");

  const makeModels = () => labModels(tokensPerSecond);

  let machines = new LocalMachines(path.join(scratch, "machines"));
  let made = makeModels();
  let app = await createCubed({ state, models: made.models, machines, claude: null, gateway: null, portal: null, skillSource: null });
  if (app.registry.runnerCount() === 0) {
    app.registry.enrollRunner({ nodeId: "node-lab", environmentId: 1, threadId: "runner-lab", configPath: "/private/lab.json", configHash: "lab", maxActiveVms: Number(process.env.LAB_SLOTS ?? 4), protocol: 4, kind: "vm" });
  }
  const listen = async () => { await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve)); return (app.server.address() as AddressInfo).port; };
  let backend = await listen();

  const sockets = new Set<net.Socket>();
  let refusing = false;
  const proxy = net.createServer(client => {
    if (refusing) { client.destroy(); return; }
    const upstream = net.connect(backend, "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", end);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const direct = () => `http://127.0.0.1:${backend}`;
  await fetch(`${direct()}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const project = await (await fetch(`${direct()}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo", repositories: [{ url: repository, base: "main" }] }) })).json() as { project: { id: string; status: string } };

  const lab = {
    url,
    projectId: project.project.id,
    get model() { return made.model; },
    api: async (route: string, init?: RequestInit) => {
      const response = await fetch(`${direct()}${route}`, init);
      const text = await response.text();
      if (!response.ok) throw new Error(`${route}: ${response.status} ${text}`);
      return JSON.parse(text) as any;
    },
    post: (route: string, body: unknown) => lab.api(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    /** Cuts every connection through the proxy (a lost network). */
    drop() { for (const socket of sockets) socket.destroy(); sockets.clear(); },
    /** Refuses new connections until `restore`. */
    down() { refusing = true; lab.drop(); },
    restore() { refusing = false; },
    /** Closes cubed and opens it again on the same state (a host restart). */
    async restart(between?: () => Promise<void>, startDelayMs = 0, failStart = false) {
      lab.down();
      app.server.closeAllConnections();
      await app.close();
      for (const guest of machines.guests.values()) guest.stop();
      await between?.();
      machines = new LocalMachines(path.join(scratch, "machines"));
      if (startDelayMs) {
        const start = machines.start.bind(machines);
        machines.start = async (thread, options) => { await new Promise(resolve => setTimeout(resolve, startDelayMs)); return start(thread, options); };
      }
      if (failStart) machines.start = async () => { throw new Error("lab: the machine could not boot"); };
      made = makeModels();
      app = await createCubed({ state, models: made.models, machines, claude: null, gateway: null, portal: null, skillSource: null });
      backend = await listen();
      lab.restore();
    },
    /** Closes the in-process cubed for good and runs cubed as a child process from now on, which `crash` SIGKILLs. */
    async toChild() {
      lab.down();
      app.server.closeAllConnections();
      await app.close();
      for (const guest of machines.guests.values()) guest.stop();
      await lab.spawnChild();
    },
    child: null as null | import("node:child_process").ChildProcess,
    async spawnChild() {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "lab-child.ts"), scratch, String(tokensPerSecond), process.env.LAB_SLOTS ?? "4"], { stdio: ["ignore", "pipe", "inherit"] });
      lab.child = child;
      const line = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout!.on("data", chunk => { buffer += chunk; const line = buffer.split("\n").find(l => l.startsWith('{"port"')); if (line) resolve(line); });
        child.once("exit", code => reject(new Error(`lab child exited ${code}`)));
      });
      backend = (JSON.parse(line) as { port: number }).port;
      lab.restore();
    },
    /** SIGKILLs the child cubed (and its guest processes' parent), then starts it again on the same state. */
    async crash(between?: () => Promise<void>) {
      lab.down();
      const child = lab.child!;
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      await between?.();
      await lab.spawnChild();
    },
    async close() {
      if (lab.child) { lab.down(); lab.child.kill("SIGKILL"); proxy.close(); return; }
      lab.down();
      app.server.closeAllConnections();
      await app.close();
      for (const guest of machines.guests.values()) guest.stop();
      proxy.close();
    },
  };
  return lab;
}
