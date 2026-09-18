import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export async function smokeProduct(root: string, config: string) {
  const state = path.join(root, "product");
  fs.mkdirSync(state);
  const children = new Set<ChildProcess>();
  async function stop(child: ChildProcess) {
    const closed = once(child, "close"); child.kill("SIGKILL"); await closed; children.delete(child);
  }
  function start(mode: string) {
    const child = fork(path.resolve("packages/server/test/product-fixture.ts"), [state, config, mode], {
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, HOME: state },
    });
    children.add(child);
    const messages: Record<string, string>[] = [];
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("message", event => messages.push(event as Record<string, string>));
    return { child, async wait(type: string) {
      const deadline = Date.now() + 20000;
      while (!messages.some(message => message.type === type)) {
        assert(child.exitCode === null && child.signalCode === null && Date.now() < deadline, stderr);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return messages.find(message => message.type === type)!;
    } };
  }
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const first = start("hold");
    const ready = await first.wait("ready");
    const input = { projectId: "product", requestId: "create-once", text: "calculate with bash", model: { provider: ready.provider, id: ready.model } };
    const response = await post(`${ready.url}/api/threads`, input);
    assert.equal(response.status, 200, await response.clone().text());
    const { id } = await response.json();
    const threadWorkspace = path.join(root, "state", "workspaces", id);
    assert.deepEqual(await (await post(`${ready.url}/api/threads`, input)).json(), { id });
    assert.equal((await post(`${ready.url}/api/threads`, { ...input, text: "changed" })).status, 409);
    await first.wait("accepted");
    await stop(first.child);

    const second = start("resume");
    const recovered = await second.wait("ready");
    const base = `${recovered.url}/api/threads/${id}`;
    const controller = new AbortController();
    const stream = await fetch(`${base}/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    let frames = "";
    const consume = (async () => {
      try { for await (const chunk of stream.body!) frames += new TextDecoder().decode(chunk); }
      catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    let history;
    const deadline = Date.now() + 20000;
    do {
      history = await (await fetch(`${base}/history`)).json();
      assert(Date.now() < deadline, JSON.stringify(history));
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (history.run?.status !== "completed");
    assert.match(JSON.stringify(history), /product recovered runner result: 93/);
    assert.match(frames, /"finalized":false/);
    assert.match(frames, /"role":"tool"/);
    controller.abort(); await consume;
    const replay = await fetch(`${base}/stream`);
    const reader = replay.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /product recovered runner result: 93/);
    await reader.cancel();
    assert.equal(fs.readFileSync(path.join(threadWorkspace, "product-count"), "utf8"), "once");
    await stop(second.child);
    const third = start("resume");
    const final = await third.wait("ready");
    assert.deepEqual(await (await fetch(`${final.url}/api/threads/${id}/history`)).json(), history);
    assert.equal(fs.readFileSync(path.join(threadWorkspace, "product-count"), "utf8"), "once");
    const followup = `${final.url}/api/threads/${id}`;
    const message = { text: "confirm the result", requestId: "followup-once" };
    const sent = await Promise.all([post(`${followup}/prompt`, message), post(`${followup}/prompt`, message)]);
    assert.deepEqual(sent.map(response => response.status), [200, 200]);
    assert.equal((await post(`${followup}/prompt`, { ...message, text: "different content" })).status, 409);
    assert.equal((await post(`${followup}/stop`, {})).status, 200);
    const stoppedDeadline = Date.now() + 10000;
    do {
      history = await (await fetch(`${followup}/history`)).json();
      assert(Date.now() < stoppedDeadline, JSON.stringify(history));
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (history.run?.status === "running");
    assert.equal(history.messages.filter((entry: { role: string }) => entry.role === "user").length, 2);
    assert.equal((await post(`${followup}/prompt`, message)).status, 200);
    assert.deepEqual(await (await fetch(`${followup}/history`)).json(), history, "stopped prompt retry must not launch a new run");
    const selected = { provider: final.provider, id: "faux-2" };
    const changed = await fetch(`${followup}/model`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(selected) });
    assert.equal(changed.status, 200);
    assert.deepEqual((await changed.json()).selected, selected);
    await stop(third.child);
    const fourth = start("removed-initial");
    const reopened = await fourth.wait("ready");
    assert.equal((await post(`${reopened.url}/api/threads/${id}/prompt`, message)).status, 200);
    assert.deepEqual(await (await fetch(`${reopened.url}/api/threads/${id}/history`)).json(), history);
    assert.deepEqual((await (await fetch(`${reopened.url}/api/threads/${id}/model`)).json()).selected, selected, "Pi must restore changed model, not registry bootstrap model");
    await stop(fourth.child);
    const fifth = start("removed-selected");
    const missing = await fifth.wait("ready");
    const missingBase = `${missing.url}/api/threads/${id}`;
    assert.deepEqual(await (await fetch(`${missingBase}/history`)).json(), history, "missing selected model must not block saved transcript");
    assert.deepEqual((await (await fetch(`${missingBase}/model`)).json()).selected, selected, "no silent fallback when selected model disappears");
    const replacement = { provider: missing.provider, id: "faux-3" };
    const replaced = await fetch(`${missingBase}/model`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(replacement) });
    assert.equal(replaced.status, 200);
    assert.deepEqual((await replaced.json()).selected, replacement, "explicit selection repairs unavailable model");
    const archived = await fetch(missingBase, { method: "DELETE" });
    assert.equal(archived.status, 200, await archived.clone().text());
    const projects = (await (await fetch(`${missing.url}/api/projects`)).json()).projects;
    assert.equal(projects[0].availableRunnerCount, 1, "archive must return runner capacity");
    assert.equal(projects[0].runnerCapacity.states.available, 1);
    assert.equal(fs.readFileSync(path.join(threadWorkspace, "product-count"), "utf8"), "once", "dirty archived worktree is retained");
    const next = await post(`${missing.url}/api/threads`, { projectId: "product", requestId: "after-archive", text: "new workspace", model: replacement });
    assert.equal(next.status, 200, await next.clone().text());
    const nextId = (await next.json()).id;
    assert.notEqual(nextId, id);
    assert.notEqual(path.join(root, "state", "workspaces", nextId), threadWorkspace);
    console.log("ok: product API creation dedup/conflict, SIGKILL/startup activation, actual runner once, streaming snapshots, SSE reconnect, third reopen");
    console.log("ok: concurrent followup deduplication, stop, model recovery, archive capacity release, dirty retention and distinct next workspace");
  } finally { await Promise.all([...children].map(stop)); }
}
