/** Called by the real runner acceptance portfolio, using its disposable runner. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export async function smokeDurableAgent(root: string, configPath: string, workspace: string) {
  const children = new Set<ChildProcess>();
  async function stop(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
    children.delete(child);
  }
  function start(directory: string, mode: string, boundary: string) {
    const child = fork(path.resolve("packages/server/test/durable-agent-fixture.ts"), [directory, configPath, mode, boundary], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, HOME: directory },
    });
    children.add(child);
    const events: Array<Record<string, string>> = [];
    let failure = "";
    child.stderr!.on("data", chunk => { failure += String(chunk); });
    child.on("message", event => events.push(event as Record<string, string>));
    async function wait(type: string) {
      const deadline = Date.now() + 30000;
      for (;;) {
        const fatal = events.find(event => event.type === "failure");
        if (fatal) throw new Error(fatal.error);
        const found = events.find(event => event.type === type);
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error(`waiting for ${type}: ${failure}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    return { child, wait };
  }
  try {
    for (const boundary of ["accepted", "tool-result-gap", "after-tool", "model-stream"]) {
      const directory = path.join(root, `durable-${boundary}`);
      fs.mkdirSync(directory);
      const original = start(directory, "create", boundary);
      const ready = await original.wait("ready");
      const contender = start(directory, "contend", boundary);
      await contender.wait("blocked");
      await stop(contender.child);
      await fetch(`${ready.url}/drive`, { method: "POST" });
      await original.wait("checkpoint");
      await stop(original.child);

      const recovered = start(directory, "recover", boundary);
      const reopened = await recovered.wait("ready");
      assert.equal(reopened.operationId, ready.operationId);
      const controller = new AbortController();
      const stream = await fetch(`${reopened.url}/events`, { signal: controller.signal });
      const reader = stream.body!.getReader();
      let received = new TextDecoder().decode((await reader.read()).value);
      assert.match(received, /"type":"snapshot"/);
      if (boundary === "model-stream") assert.match(received, /checking/);
      const consume = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += new TextDecoder().decode(chunk.value);
          }
        } catch (error) { if (!controller.signal.aborted) throw error; }
      })();
      await fetch(`${reopened.url}/drive`, { method: "POST" });
      await recovered.wait("done");
      const snapshot = await (await fetch(`${reopened.url}/snapshot`)).json();
      assert.match(JSON.stringify(snapshot), /verified runner result: 74/);
      assert.match(received, /text_delta/);
      assert.match(received, /run_end/);
      controller.abort();
      await consume;
      await stop(recovered.child);

      const inspection = start(directory, "inspect", boundary);
      const inspected = await inspection.wait("ready");
      assert.deepEqual(await (await fetch(`${inspected.url}/snapshot`)).json(), snapshot);
      await stop(inspection.child);
      assert.equal(fs.readFileSync(path.join(workspace, `${boundary}-count`), "utf8"), "once");
      const attempts = fs.readFileSync(path.join(directory, "attempts"), "utf8").trim().split("\n");
      assert.equal(attempts.length, boundary === "tool-result-gap" ? 2 : 1);
      assert.equal(new Set(attempts).size, 1);
      console.log(`ok: durable agent ${boundary}: SIGKILL/reopen, exclusive owner, actual runner effect once, same identity, SSE and third reopen`);
    }
  } finally { await Promise.all([...children].map(stop)); }
}
