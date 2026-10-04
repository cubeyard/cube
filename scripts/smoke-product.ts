import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
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
    const remote = String(execFileSync("git", ["-C", path.join(root, "workspace"), "remote", "get-url", "origin"], { encoding: "utf8" })).trim();
    const projectResponse = await post(`${ready.url}/api/projects`, { name: "product test", repositories: [{ url: remote, base: "develop" }] });
    assert.equal(projectResponse.status, 200, await projectResponse.clone().text());
    const projectId = (await projectResponse.json()).project.id;
    const input = { projectId, requestId: "create-once", text: "calculate with bash", model: { provider: ready.provider, id: ready.model } };
    const response = await post(`${ready.url}/api/threads`, input);
    assert.equal(response.status, 200, await response.clone().text());
    const { id } = await response.json();
    const threadWorkspace = path.join(root, "state", "workspaces", id, "workspace");
    const createdThread = (await (await fetch(`${ready.url}/api/threads`)).json()).threads.find((thread: { id: string }) => thread.id === id);
    assert.ok(createdThread.workspaceBase, createdThread.workspaceError ?? "workspace base was not recorded");
    assert.equal(createdThread.workspaceBase.ref, "refs/heads/develop");
    assert.match(createdThread.workspaceBase.oid, /^[0-9a-f]{40}$/);
    assert.equal(fs.readFileSync(path.join(threadWorkspace, "remote-base"), "utf8"), "fresh base\n");
    assert.deepEqual(await (await post(`${ready.url}/api/threads`, input)).json(), { id });
    assert.equal((await post(`${ready.url}/api/threads`, { ...input, text: "changed" })).status, 409);
    await first.wait("accepted");
    await stop(first.child);

    const second = start("resume");
    const recovered = await second.wait("ready");
    const base = `${recovered.url}/api/threads/${id}`;
    // cubed mounts the workspace routes; the thread's agent is fixed and Pi
    // holds its lease, so no second writable owner can be admitted.
    const workspace = await (await fetch(`${base}/workspace`)).json();
    assert.ok(workspace.capabilities.includes("fs.write") && workspace.limits.maxWriteBytes > 0, JSON.stringify(workspace));
    const leaseRoute = (owner: string) => post(`${base}/workspace/lease`, { owner });
    assert.equal((await (await leaseRoute("claude-code")).json()).code, "CONFLICT");
    assert.equal((await (await leaseRoute("pi")).json()).code, "LEASE_HELD");
    assert.equal((await fetch(`${base}/workspace/stat?path=.`)).status, 401);
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
    } while (history.status.state !== "completed");
    assert.match(JSON.stringify(history), /product recovered runner result: 93/);
    assert.match(frames, /"final":false/);
    assert.match(frames, /"type":"tool-result"/);
    assert.match(frames, /"type":"tool-call"/);
    assert.equal(history.agent, "pi");
    assert.equal(history.owner, "pi");
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
    } while (history.status.state === "working");
    assert.equal(history.events.filter((event: { type: string }) => event.type === "user-message").length, 2);
    assert.equal(history.status.state, "stopped");
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
    const otherProjectResponse = await post(`${missing.url}/api/projects`, { name: "other project", repositories: [] });
    assert.equal(otherProjectResponse.status, 200);
    const otherProject = (await otherProjectResponse.json()).project;
    assert.equal(otherProject.availableRunnerCount, 1, "every project sees the same global capacity");
    const next = await post(`${missing.url}/api/threads`, { projectId: otherProject.id, requestId: "after-archive", text: "new workspace", model: replacement });
    assert.equal(next.status, 200, await next.clone().text());
    const nextId = (await next.json()).id;
    assert.notEqual(nextId, id);
    assert.notEqual(path.join(root, "state", "workspaces", nextId, "workspace"), threadWorkspace);
    await stop(fifth.child);

    // A claude · max thread on the same runner, with a fake `claude` that
    // runs the Claude Code mod's tool functions over cubed's workspace socket.
    const sixth = start("resume");
    const host = await sixth.wait("ready");
    const historyOf = async (threadId: string) => (await fetch(`${host.url}/api/threads/${threadId}/history`)).json();
    const settled = async (threadId: string, run?: string) => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const value = await historyOf(threadId);
        if (value.status?.state && value.status.state !== "working" && value.status.state !== "idle" && (!run || value.status.run === run)) return value;
        assert(Date.now() < deadline, JSON.stringify(value));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await settled(nextId);
    assert.equal((await fetch(`${host.url}/api/threads/${nextId}`, { method: "DELETE" })).status, 200);
    const catalog = (await (await fetch(`${host.url}/api/models`)).json()).models as Array<{ provider: string; id: string }>;
    assert.ok(catalog.some(model => model.provider === "claude-code" && model.id === "sonnet"), JSON.stringify(catalog));
    const claudeInput = { projectId: otherProject.id, requestId: "claude-once", text: "run printf once >> claude-count; printf 41", model: { provider: "claude-code", id: "sonnet" } };
    const created = await post(`${host.url}/api/threads`, claudeInput);
    assert.equal(created.status, 200, await created.clone().text());
    const claudeId = (await created.json()).id;
    const claudeBase = `${host.url}/api/threads/${claudeId}`;
    const claudeWorkspace = path.join(root, "state", "workspaces", claudeId, "workspace");
    let claudeHistory = await settled(claudeId);
    assert.equal(claudeHistory.status.state, "completed", JSON.stringify(claudeHistory));
    assert.equal(claudeHistory.agent, "claude-code");
    assert.equal(claudeHistory.owner, "claude-code");
    assert.ok(claudeHistory.events.some((event: { type: string; name?: string; output?: string }) => event.type === "tool-result" && event.name === "Bash" && event.output === "41"), JSON.stringify(claudeHistory.events));
    assert.equal(fs.readFileSync(path.join(claudeWorkspace, "claude-count"), "utf8"), "once");
    assert.equal((await (await post(`${claudeBase}/workspace/lease`, { owner: "pi" })).json()).code, "CONFLICT");
    assert.equal((await (await post(`${claudeBase}/workspace/lease`, { owner: "claude-code" })).json()).code, "LEASE_HELD");
    const claudeModels = await (await fetch(`${claudeBase}/model`)).json();
    assert.deepEqual(claudeModels.models.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`), ["claude-code/fable", "claude-code/opus", "claude-code/sonnet", "claude-code/haiku"]);
    assert.deepEqual(claudeModels.selected, { provider: "claude-code", id: "sonnet" });
    const toOpus = await fetch(`${claudeBase}/model`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "claude-code", id: "opus" }) });
    assert.equal(toOpus.status, 200, await toOpus.clone().text());
    assert.equal((await fetch(`${claudeBase}/model`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(selected) })).status, 409, "a claude thread runs claude models only");
    await stop(sixth.child);
    const seventh = start("resume");
    const restarted = await seventh.wait("ready");
    const again = `${restarted.url}/api/threads/${claudeId}`;
    assert.deepEqual(await (await fetch(`${again}/history`)).json(), claudeHistory, "the claude transcript survives a cubed SIGKILL");
    assert.deepEqual((await (await fetch(`${again}/model`)).json()).selected, { provider: "claude-code", id: "opus" });
    assert.equal((await post(`${again}/prompt`, { text: "id toolu_once run printf again >> claude-count", requestId: "claude-2" })).status, 200);
    const waitRun = async (run: string) => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const value = await (await fetch(`${again}/history`)).json();
        if (value.status.run === run && value.status.state !== "working") return value;
        assert(Date.now() < deadline, JSON.stringify(value));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    claudeHistory = await waitRun("claude-2");
    assert.equal(claudeHistory.status.state, "completed");
    assert.match(JSON.stringify(claudeHistory.events.at(-1)), /done with opus/);
    assert.equal((await post(`${again}/prompt`, { text: "id toolu_once run printf again >> claude-count", requestId: "claude-3" })).status, 200);
    assert.equal((await waitRun("claude-3")).status.state, "completed");
    assert.equal(fs.readFileSync(path.join(claudeWorkspace, "claude-count"), "utf8"), "onceagain", "a tool_use_id runs once on the runner");
    assert.equal((await post(`${again}/prompt`, { text: "slow sleep 5; touch claude-late", requestId: "claude-4" })).status, 200);
    const slowDeadline = Date.now() + 10000;
    while (!JSON.stringify(await (await fetch(`${again}/history`)).json()).includes("claude-late")) {
      assert(Date.now() < slowDeadline, "claude tool call did not start");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await post(`${again}/stop`, {})).status, 200);
    assert.equal((await waitRun("claude-4")).status.state, "stopped");
    assert.equal((await fetch(again, { method: "DELETE" })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.ok(!fs.existsSync(path.join(claudeWorkspace, "claude-late")), "stop cancelled the runner command");
    console.log("ok: product API creation dedup/conflict, SIGKILL/startup activation, actual runner once, streaming snapshots, SSE reconnect, third reopen");
    console.log("ok: concurrent followup deduplication, stop, model recovery, archive release to the global pool, cross-project reuse, dirty retention and distinct next workspace");
    console.log("ok: claude · max thread on the actual runner through the mod's tools: lease owner, transcript, model switch, SIGKILL reopen with resume, keyed tool once, stop with runner cancel");
  } finally { await Promise.all([...children].map(stop)); }
}
