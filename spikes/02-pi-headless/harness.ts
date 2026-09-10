/**
 * Spike 2 — pi SDK headless with sandbox-routed bash + host-FS file tools.
 *
 * Architecture under test (ARCHITECTURE §4): the harness (pi AgentSession) runs on the
 * host. read/write/edit operate directly on the host workspace dir, which is
 * mounted shift=true at /workspace inside the orb. Only bash crosses the
 * boundary, via `incus exec` into orb-spike01.
 *
 * Run with: ./run.sh  (wraps in `sg incus-admin` — this shell may not have the
 * group yet; a fresh login won't need it)
 *
 * Success criteria:
 *  - a single prompt makes the model write a file (host-side), run commands
 *    in the orb that see that file, edit it, and read back a file the orb
 *    created — same workspace, both directions.
 *  - events.jsonl captures a stream rich enough for a web UI: tool argument
 *    deltas while streaming, edit diffs in tool results.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createAgentSession,
  createBashToolDefinition,
  SessionManager,
  ModelRuntime,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

const ORB = "orb-spike01";
const HOST_WS = path.join(process.env.HOME!, "cube/orbs/spike01/workspace");
const GUEST_WS = "/workspace";
const EVENTS_FILE = path.join(import.meta.dirname, "events.jsonl");

// ---------------------------------------------------------------- path map

function toGuestPath(hostPath: string): string {
  const rel = path.relative(HOST_WS, hostPath);
  if (rel === "") return GUEST_WS;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // Bash must never operate outside the workspace: that is the boundary.
    throw new Error(`cwd escapes workspace: ${hostPath}`);
  }
  return path.posix.join(GUEST_WS, rel);
}

// ------------------------------------------------------- incus-routed bash

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function createIncusBashOps(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const guestCwd = toGuestPath(cwd);
      // `su - dev` (not incus --user 1000): only a login picks up dev's
      // supplementary groups — without it, the docker group is missing and
      // the inner docker socket is unreachable.
      // Deliberately NO env passthrough: host env (and credentials) must not
      // leak into the sandbox. cubed will curate an explicit allowlist.
      const inner = `cd ${shQuote(guestCwd)} && ${command}`;
      const args = [
        "exec", ORB, "--env", "TERM=dumb",
        "--", "su", "-", "dev", "-c", inner,
      ];
      const child = spawn("incus", args, { stdio: ["ignore", "pipe", "pipe"] });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeout * 1000)
          : undefined;
      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => onData(d));
      child.stderr.on("data", (d: Buffer) => onData(d));

      try {
        const exitCode: number | null = await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code) => resolve(code));
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ----------------------------------------------------------------- session

const modelRuntime = await ModelRuntime.create();
const available = await modelRuntime.getAvailable();
if (available.length === 0) {
  console.error("No models available — check provider API keys / auth.json");
  process.exit(1);
}
// Prefer the codex-subscription OAuth (luna, user-designated test model);
// fall back to the native DeepSeek key. OpenRouter is out of credits (402).
const prefer: Array<[string, string]> = [
  ["openai-codex", "gpt-5.6-luna"],
  ["deepseek", "deepseek-v4-pro"],
  ["deepseek", "deepseek-v4-flash"],
];
const model =
  prefer
    .map(([prov, id]) =>
      available.find((m) => m.provider === prov && m.id.toLowerCase().includes(id)),
    )
    .find(Boolean) ?? available[0];
console.log(`model: ${model.provider}/${model.id}`);
console.log(`available (${available.length}): ${available.slice(0, 20).map((m) => `${m.provider}/${m.id}`).join(", ")}${available.length > 20 ? " …" : ""}`);

const incusBash = createBashToolDefinition(HOST_WS, {
  operations: createIncusBashOps(),
});

const { session } = await createAgentSession({
  cwd: HOST_WS,
  model,
  thinkingLevel: "off",
  // "bash" must be in the allowlist (it filters custom tools too); the custom
  // definition below then shadows the built-in local bash by name.
  tools: ["read", "write", "edit", "grep", "find", "ls", "bash"],
  customTools: [incusBash], // bash replaced by the incus-routed one
  modelRuntime,
  sessionManager: SessionManager.inMemory(HOST_WS),
});

// Log the raw event stream for the richness assessment.
const eventLog = fs.createWriteStream(EVENTS_FILE);
session.subscribe((event) => {
  eventLog.write(JSON.stringify(event) + "\n");
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
  if (event.type === "tool_execution_start") {
    console.log(`\n[tool_execution_start] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 200)}`);
  }
  if (event.type === "tool_execution_end") {
    console.log(`[tool_execution_end] ${event.toolName} isError=${event.isError}`);
  }
});

const PROMPT = `
Do these steps in order, exactly as described, then summarize:

1. Use the write tool to create notes/spike02.md containing a two-line haiku
   about containers (any words you like, include the word "gondola").
2. Use bash to run: hostname; id; pwd; cat notes/spike02.md
3. Use bash to run: docker ps --format '{{.Names}}'
4. Use the edit tool on notes/spike02.md to replace the word "gondola" with
   the word "orbit".
5. Use bash to run: cat notes/spike02.md   (confirm the edit is visible)
6. Use bash to run: echo "written inside the orb by $(whoami) on $(hostname)" > from-orb.txt
7. Use the read tool to read from-orb.txt and quote its content.

Report each step's outcome briefly.
`.trim();

console.log("--- prompting ---");
const t0 = performance.now();
await session.prompt(PROMPT);
console.log(`\n--- done in ${((performance.now() - t0) / 1000).toFixed(1)}s ---`);
session.dispose();
eventLog.end();
