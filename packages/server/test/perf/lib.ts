/** Shared parts of the perf harness (packages/server/test/perf/README.md): a seeded
 * PRNG, synthetic text, and the controlled model that answers OptChat, its
 * compactor and the threads deterministically. Offline, disposable state,
 * no provider is ever called. */
import fs from "node:fs";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type Models } from "@earendil-works/pi-ai";
import { createCubed } from "../../src/index.ts";
import type { TrustedRunnerHealth } from "../../src/runner-types.ts";
import { LocalMachines } from "../local-guest.ts";

/** mulberry32: a small deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** FNV-1a of a string, for per-request randomness that depends only on content. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
export const between = (random: () => number, min: number, max: number) => min + Math.floor(random() * (max - min + 1));

const WORDS = ("the runner machine thread gateway review merge commit branch test build layer image keel berth guest workspace "
  + "artifact revision comment project hook template setup resume network egress policy proxy credential token session lease "
  + "epoch transcript stream frame window page history summary node memory view zoom compactor model provider usage cost "
  + "and a of to in for with on that is it was as by from at this be are not but or an which when then so because after before "
  + "fix check run start stop open close read write send wait retry fail pass show keep move change add remove update").split(" ");
const FILES = ["packages/server/src/optchat.ts", "packages/server/src/registry.ts", "packages/web/src/components/Conversation.svelte",
  "packages/berth/src/vm/egress.rs", "packages/server/src/runner-session.ts", "packages/web/src/lib/transcript.ts", "scripts/test-offline.sh",
  "packages/keel/agent/src/main.rs", "packages/server/src/artifacts.ts", "packages/web/src/components/ThreadList.svelte"];

export function sentence(random: () => number, min = 6, max = 22): string {
  const n = between(random, min, max);
  const words = Array.from({ length: n }, () => pick(random, WORDS));
  if (random() < 0.25) words.splice(between(random, 0, words.length - 1), 0, `\`${pick(random, FILES)}\``);
  const text = words.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}
export const paragraph = (random: () => number, min = 2, max = 6) => Array.from({ length: between(random, min, max) }, () => sentence(random)).join(" ");

/** A Markdown reply as an agent writes one: paragraphs, often a list, sometimes code or a table. */
export function markdown(random: () => number, scale = 1): string {
  const parts: string[] = [];
  const blocks = Math.max(1, Math.round(between(random, 1, 5) * scale));
  for (let b = 0; b < blocks; b++) {
    const kind = random();
    if (kind < 0.5) parts.push(paragraph(random));
    else if (kind < 0.75) parts.push(Array.from({ length: between(random, 2, 6) }, () => `- ${sentence(random, 4, 14)}`).join("\n"));
    else if (kind < 0.9) parts.push(`\`\`\`ts\n${Array.from({ length: between(random, 3, 14) }, (_, i) => `const ${pick(random, WORDS)}${i} = await ${pick(random, WORDS)}(${between(random, 0, 999)});`).join("\n")}\n\`\`\``);
    else parts.push(`| case | before | after |\n| --- | --- | --- |\n${Array.from({ length: between(random, 2, 6) }, () => `| ${pick(random, WORDS)} | ${between(random, 1, 900)} ms | ${between(random, 1, 900)} ms |`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** A bash command whose output looks like a build log, deterministic in its lines. */
export function logCommand(random: () => number): string {
  const lines = pick(random, [5, 20, 40, 80, 160, 300]);
  const name = pick(random, ["test", "build", "lint", "typecheck"]);
  return `seq 1 ${lines} | awk '{printf "${name} src/mod%03d.ts:%d:%d ok %s\\n", $1%97, $1*7, $1%13, ($1%11==0)?"warn: slow step":"pass"}'`;
}

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { type: string; text?: string }).type === "text" ? (part as { text: string }).text : "").join("\n") : "";

/** The controlled model. OptChat: a reply, sometimes after a read-only tool;
 * "please start these in <project>:" with "- task" lines spawns them;
 * "revise artifact <id>" writes a revision; "write an artifact" creates one.
 * The compactor gets a short line. A thread runs 0-3 bash calls (more on
 * "long"), sometimes writes an artifact, then reports. */
export function controlledModel(seed: number, options: { tokensPerSecond?: number } = {}): { models: Models; model: { provider: string; id: string }; calls: () => number } {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 1e9 });
  let calls = 0;
  const answer: FauxResponseFactory = async request => {
    calls++;
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    const system = JSON.stringify(messages.filter(message => message.role === "system")) + String((request as { systemPrompt?: string }).systemPrompt ?? "");
    const users = messages.filter(message => message.role === "user");
    const lastUser = users.at(-1);
    const blocks = lastUser ? (typeof lastUser.content === "string" ? [lastUser.content] : (lastUser.content as Array<{ type: string; text?: string }>).map(part => part.text ?? "")) : [""];
    const said = blocks.at(-1) ?? "";
    const last = messages.at(-1)!;
    const sinceUser = messages.slice(messages.lastIndexOf(lastUser!) + 1);
    const toolRounds = sinceUser.filter(message => message.role === "toolResult").length;
    const random = prng(hash(`${seed}:${said}:${toolRounds}`));
    if (system.includes("You write the memory of OptChat")) {
      return fauxAssistantMessage(`${sentence(random, 5, 12)}\n${sentence(random, 9, 20)}\n${sentence(random, 14, 30)}`);
    }
    if (system.includes("You are OptChat")) {
      if (last.role === "toolResult") return fauxAssistantMessage(markdown(random, 0.8));
      const start = said.match(/^please start these in ([^:\n]+):\n([^]*)$/);
      if (start) {
        const tasks = start[2]!.split("\n").filter(line => line.startsWith("- ")).map(line => ({ project: start[1]!, task: line.slice(2) }));
        return fauxAssistantMessage([{ type: "text", text: "starting them" }, fauxToolCall("spawn", { tasks }, { id: `spawn-${hash(said)}` })], { stopReason: "toolUse" });
      }
      const revise = said.match(/^revise artifact ([a-z0-9-]+)/);
      if (revise) {
        return fauxAssistantMessage([fauxToolCall("artifact_write", { id: revise[1], body: `# ${sentence(random, 3, 6).slice(0, -1)}\n\n${markdown(random, 3)}` }, { id: `aw-${hash(said)}` })], { stopReason: "toolUse" });
      }
      if (said.startsWith("write an artifact")) {
        return fauxAssistantMessage([fauxToolCall("artifact_write", { title: sentence(random, 3, 7).slice(0, -1), body: `# ${sentence(random, 3, 6).slice(0, -1)}\n\n${markdown(random, 3)}` }, { id: `aw-${hash(said)}` })], { stopReason: "toolUse" });
      }
      const archive = said.match(/^archive \[([0-9a-f]{8})\]/);
      if (archive) return fauxAssistantMessage([fauxToolCall("archive", { ids: [archive[1]] }, { id: `ar-${hash(said)}` })], { stopReason: "toolUse" });
      const read = said.match(/^\[([0-9a-f]{8})\]/);
      const roll = random();
      if (read && roll < 0.3) return fauxAssistantMessage([fauxToolCall("history", { id: read[1] }, { id: `h-${hash(said)}` })], { stopReason: "toolUse" });
      if (roll < 0.08) return fauxAssistantMessage([fauxToolCall("threads", {}, { id: `t-${hash(said)}` })], { stopReason: "toolUse" });
      if (roll < 0.11) return fauxAssistantMessage([fauxToolCall("projects", {}, { id: `p-${hash(said)}` })], { stopReason: "toolUse" });
      if (roll < 0.13) return fauxAssistantMessage([fauxToolCall("usage", {}, { id: `u-${hash(said)}` })], { stopReason: "toolUse" });
      if (roll < 0.16) return fauxAssistantMessage([fauxToolCall("zoom", { id: 0, n: 1 }, { id: `z-${hash(said)}` })], { stopReason: "toolUse" });
      return fauxAssistantMessage(markdown(random, read ? 0.6 : 1));
    }
    // A thread: the task is its first user message.
    const task = textOf(users[0]?.content);
    const long = /\blong\b/.test(said);
    const planned = long ? between(prng(hash(`${seed}:${said}`)), 2, 6) : hash(`${seed}:${said}`) % 4;
    if (toolRounds < planned) return fauxAssistantMessage([{ type: "text", text: sentence(random, 4, 12) }, fauxToolCall("bash", { command: logCommand(random) }, { id: `b-${hash(`${said}:${toolRounds}`)}` })], { stopReason: "toolUse" });
    if (toolRounds === planned && hash(`${seed}:artifact:${task}:${said}`) % 6 === 0 && last.role !== "toolResult" + "x") {
      // Once per run at most: after the planned commands, a report as an artifact.
      if (!sinceUser.some(message => JSON.stringify(message.content ?? "").includes("artifact_write"))) {
        return fauxAssistantMessage([fauxToolCall("artifact_write", { title: `report: ${sentence(random, 3, 6).slice(0, -1)}`, body: `# report\n\n${markdown(random, 4)}` }, { id: `taw-${hash(said)}` })], { stopReason: "toolUse" });
      }
    }
    return fauxAssistantMessage(`## done\n\n${markdown(random, 1.5)}`);
  };
  // The factory is pushed again whenever few are left: an endless supply.
  faux.setResponses(Array.from({ length: 1000 }, () => answer));
  const top = setInterval(() => { if (faux.getPendingResponseCount() < 500) faux.appendResponses(Array.from({ length: 1000 }, () => answer)); }, 50);
  top.unref();
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: faux.getModel().provider, id: faux.getModel().id }, calls: () => calls };
}

/** Never contacts a runner: every enrolled runner reports itself ready. */
export const runnerHealth = async (runner: { kind?: string }): Promise<TrustedRunnerHealth> => ({
  lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 256,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "perf-harness", protocolVersion: 4, kind: (runner.kind ?? "vm") as "vm",
});

/** A `gh` that is never logged in, first on PATH: cubed asks it for the
 * host's GitHub login, and the harness must never reach GitHub. */
export function isolateGh(root: string): void {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'perf harness: gh is disabled' >&2\nexit 1\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
}

/** The real cubed over the disposable root: local guests stand in for the
 * runner's machines (test harness, not a sandbox), the controlled model
 * for every provider. */
export async function openCubed(root: string, seed: number) {
  isolateGh(root);
  const control = controlledModel(seed, { tokensPerSecond: Number(process.env.PERF_TPS) || undefined });
  const app = await createCubed({ state: path.join(root, "state"), models: control.models, machines: new LocalMachines(path.join(root, "machines")),
    claude: null, gateway: null, runnerHealth, portal: null, skillSource: null,
    secrets: [], githubPulls: { async pull() { throw new Error("perf harness: no GitHub"); }, async merge() { throw new Error("perf harness: no GitHub"); } } });
  return { app, ...control };
}
