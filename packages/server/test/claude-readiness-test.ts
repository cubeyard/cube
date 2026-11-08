/** claude · max is offered only when the host can run it: the `claude`
 * binary and the long-lived token from `claude setup-token` that the model
 * channel substitutes. Without the token (a host that only ran `claude
 * /login`), cubed neither lists Claude Code's models nor reports a working
 * model login. Disposable state; no Pi provider; a fake `claude`. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSecret } from "../src/egress-policy.ts";
import { createCubed } from "../src/index.ts";
import { ClaudeModelChannel } from "../src/model-channel.ts";
import { createModelRuntime } from "../src/models.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-ready-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const fakeClaude = [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")];

async function host(name: string, env: NodeJS.ProcessEnv, claude: readonly string[] | null = fakeClaude) {
  const channel = new ClaudeModelChannel({ secret: claudeSecret(env), address: () => "127.0.0.1:9" });
  const app = await createCubed({ state: path.join(root, name), models: await createModelRuntime(), machines: new LocalMachines(path.join(root, `${name}-machines`)),
    claude, gateway: null, modelChannel: channel });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as { port: number };
  const get = async (route: string) => (await fetch(`http://127.0.0.1:${port}${route}`)).json() as Promise<Record<string, unknown>>;
  try {
    const models = (await get("/api/models")).models as Array<{ provider: string; id: string }>;
    const state = await get("/api/state");
    return { claudeModels: models.filter(model => model.provider === "claude-code").map(model => model.id), auth: state.auth };
  } finally { await app.close(); }
}

try {
  const loginOnly = await host("login-only", {});
  assert.deepEqual(loginOnly.claudeModels, [], "no claude · max without the setup-token");
  assert.deepEqual(loginOnly.auth, { state: "missing", provider: "model" }, "no working model login is reported");

  const ready = await host("ready", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-readiness" });
  assert.deepEqual(ready.claudeModels, ["fable", "opus", "sonnet", "haiku"]);
  assert.deepEqual(ready.auth, { state: "ok", provider: "claude-code", credentialType: "claude setup-token" });

  const noBinary = await host("no-binary", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-readiness" }, null);
  assert.deepEqual(noBinary.claudeModels, [], "the token alone runs nothing");
  console.log("ok: claude · max and a ready model login only with claude and its setup-token; a claude /login host is not reported ready");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
