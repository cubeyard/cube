/** The verification cubed for `.agents/skills/verify-cube`: the real product
 * server and OptChat with local guests (the real guest helper under
 * temporary roots, no VM) and a faux model scripted by the prompt, with a
 * seeded git repository and one enrolled stand-in runner row. No model
 * service, GitHub or runner is contacted. Everything it writes is under
 * `scratch`, which it creates (an existing one is refused) and marks with
 * an owner file holding `owner`; `close`, or a start that fails part way,
 * removes it only while that file still holds this token.
 *
 * The model's script, read from the last text of the turn's message:
 * a line `tool {"name":…,"args":{…}}` calls that tool, and after its result
 * answers `result: <output>`; `please fail` is a provider error; anything
 * else is answered `ok: <message>`. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { LocalMachines } from "./local-guest.ts";

export const VERIFY_RUNNER = "node-verify";
export const VERIFY_OWNER_FILE = ".verify-cube-owner";
export const VERIFY_SEED_COMMIT = "verify-cube seed commit";

const said = (message: unknown) => JSON.stringify(message) ?? "";
const lastText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { type: string; text?: string }[]).flatMap(part => part.type === "text" ? [part.text ?? ""] : []).at(-1) ?? "" : "";
const allText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { text?: string }[]).map(part => part.text ?? "").join("") : "";

export async function startVerifyHost(options: { scratch: string; host?: string; port?: number; allowedHosts?: string[] }) {
  const { scratch } = options;
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  try { fs.mkdirSync(scratch); }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? `${scratch} already exists: verify-cube uses only a scratch directory it creates` : String(error)); }
  const owner = randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(scratch, VERIFY_OWNER_FILE), `${owner}\n`);
  const removeScratch = () => {
    let mark = "";
    try { mark = fs.readFileSync(path.join(scratch, VERIFY_OWNER_FILE), "utf8").trim(); } catch { /* gone */ }
    if (mark === owner) fs.rmSync(scratch, { recursive: true, force: true });
  };
  let machines: LocalMachines | null = null;
  let app: Awaited<ReturnType<typeof createCubed>> | null = null;
  const stop = async () => {
    try {
      if (app) { app.server.closeAllConnections(); await app.close(); }
    } finally {
      for (const guest of machines?.guests.values() ?? []) guest.stop();
      removeScratch();
    }
  };
  try {
    const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Verify", "-c", "user.email=verify@example.invalid",
      "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
    const seed = path.join(scratch, "seed");
    fs.mkdirSync(seed);
    git(seed, ["init", "-q", "--initial-branch=main"]);
    fs.writeFileSync(path.join(seed, "README.md"), "# demo\n\nseeded by verify-cube\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", VERIFY_SEED_COMMIT]);
    const repository = path.join(scratch, "demo.git");
    git(scratch, ["clone", "-q", "--bare", seed, repository]);

    const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 3, max: 6 } });
    faux.setResponses(Array.from({ length: 2000 }, () => async request => {
      if (said(request.messages.find(message => message.role === "system")).includes("You write the memory of OptChat")) return fauxAssistantMessage("a summary");
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") return fauxAssistantMessage(`result: ${allText(last.content).trim()}`);
      const asked = last.role === "user" ? lastText(last.content).trim() : "";
      if (asked.includes("please fail")) throw new Error("the provider refused");
      const tool = asked.match(/^tool (\{.*\})$/m);
      if (tool) {
        const { name, args } = JSON.parse(tool[1]!) as { name: string; args: Record<string, unknown> };
        return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id: `call-${Date.now()}` })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(`ok: ${asked.slice(0, 200)}`);
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    machines = new LocalMachines(path.join(scratch, "machines"));
    const state = path.join(scratch, "state");
    app = await createCubed({ state, models, machines, claude: null, gateway: null, portal: null, skillSource: null,
      ...options.allowedHosts ? { allowedHosts: options.allowedHosts } : {} });
    if (app.registry.runnerCount() === 0) {
      app.registry.enrollRunner({ nodeId: VERIFY_RUNNER, environmentId: 1, threadId: "runner-verify", configPath: "/private/verify.json",
        configHash: "verify", maxActiveVms: 4, protocol: 4, kind: "vm" });
    }
    const server = app.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    const done = await fetch(`${url}/api/onboarding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!done.ok) throw new Error(`onboarding: ${done.status} ${await done.text()}`);
    const registry = app.registry;
    const local = machines;
    return {
      url,
      port,
      state,
      repository,
      owner,
      model: { provider: faux.getModel().provider, id: faux.getModel().id },
      /** A thread's guest root: its `workspace` is the thread's /workspace. */
      guest: (id: string) => local.guest(registry.getThread(id)!).root,
      close: stop,
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
