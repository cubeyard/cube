/** Called by the real runner acceptance portfolio, using its disposable
 * runner: one Pi codemode script whose nested write, edit, bash and read
 * reach the real Rust runner over Iroh under their nested keys. The model is
 * a faux one; no model service is contacted. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { CodemodeDetails } from "../src/codemode.ts";
import { openAgent } from "../src/durable-agent.ts";
import { IrohExecutionNodeClient } from "../src/iroh-node.ts";
import { RunnerWorkspace } from "../src/workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";

const context = BACKGROUND_CONTEXT;

export async function smokeCodemode(root: string, configPath: string, workspace: string) {
  const client = new IrohExecutionNodeClient({ configPath });
  const leases = new LeaseStore(path.join(root, "codemode-lease"));
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: `
      await tools.write({ path: "codemode/a.txt", content: "one\\n" });
      await tools.edit({ path: "codemode/a.txt", edits: [{ oldText: "one", newText: "two" }] });
      const listed = await tools.bash({ command: "cat codemode/a.txt; printf ran >> codemode/count" });
      const read = await tools.read({ path: "/workspace/codemode/a.txt" });
      return { listed, read };
    ` })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const agent = await openAgent({
    directory: path.join(root, "codemode-agent"), runner: { binding: client.binding, configHash: client.configHash },
    workspace: new RunnerWorkspace({ runner: client, leases, owner: "pi" }), models,
    model: { provider: faux.getModel().provider, id: faux.getModel().id },
  });
  try {
    const submission = await agent.conversation.submit({ type: "input", content: "batch it", requestId: "codemode" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(fs.readFileSync(path.join(workspace, "codemode/a.txt"), "utf8"), "two\n");
    assert.equal(fs.readFileSync(path.join(workspace, "codemode/count"), "utf8"), "ran");
    const watch = await agent.conversation.watch(context);
    await watch.stop();
    const [result] = watch.value.entries.flatMap(entry => (entry.model ?? []).filter((message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult"));
    const text = result!.content.map(part => part.type === "text" ? part.text : "").join("");
    assert.equal(result!.isError, false, text);
    const value = JSON.parse(text.split("Return value:\n")[1]!) as { listed: string; read: string };
    assert.equal(value.listed, "two\n\n[exit=0; exited]");
    assert.equal(value.read, "two\n");
    const details = result!.details as CodemodeDetails;
    const base = details.calls[0]!.key.replace(/:code:1$/, "");
    assert.match(base, /^pi:[0-9a-f-]+:\d+$/);
    assert.deepEqual(details.calls.map(call => [call.name, call.key, call.status]), [
      ["write", `${base}:code:1`, "ok"], ["edit", `${base}:code:2`, "ok"], ["bash", `${base}:code:3`, "ok"], ["read", `${base}:code:4`, "ok"],
    ]);
  } finally {
    await agent.close();
    leases.close();
  }
}
