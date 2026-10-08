/** Offline Pi checks over the Workspace: pi-durable's file tools through the
 * WorkspaceEnv, cube's keyed bash, stop as real cancellation, and shutdown
 * leaving a command to the next process. The real guest helper under a
 * temporary root stands in for the VM (local guest); real VMs run in
 * scripts/test-vm-e2e.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { LEGACY_THREAD, openAgent, type Agent } from "../src/durable-agent.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { MAX_FILE_READ_BYTES, WorkspaceEnv } from "../src/workspace-env.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-durable-agent-"));
const guests: LocalGuestTransport[] = [];
const stores: LeaseStore[] = [];
function thread(name: string) {
  const files = path.join(root, name, "workspace");
  fs.mkdirSync(files, { recursive: true });
  const guest = new LocalGuestTransport(path.dirname(files));
  const leases = new LeaseStore(path.join(root, name, "thread"));
  guests.push(guest); stores.push(leases);
  return { files, directory: path.join(root, name, "thread"), guest, workspace: new VmWorkspace({ guest, leases, owner: "pi", binding: guest.binding }) };
}
function model(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  faux.setResponses(steps);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: faux.getModel().provider, id: faux.getModel().id } };
}
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
async function results(agent: Agent): Promise<Extract<Message, { role: "toolResult" }>[]> {
  const watch = await agent.conversation.watch(context);
  await watch.stop();
  return watch.value.entries.flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult"));
}
const text = (message: { content: Array<{ type: string; text?: string }> }) => message.content.map(part => part.text ?? "").join("");
async function until(check: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
}
const live = async (agent: Agent) => (await agent.harness.snapshot(LiveDoc, agent.conversation.id, context)) as LiveState | undefined;

try {
  {
    // read/write/edit are pi-durable's own tools; files only change through the Workspace.
    const { files, directory, guest, workspace } = thread("tools");
    const agent = await openAgent({ directory, binding: guest.binding, workspace, ...model([
      call("write", { path: "notes/a.txt", content: "hello\nworld\n" }),
      call("read", { path: "notes/a.txt" }),
      call("edit", { path: "/workspace/notes/a.txt", edits: [{ oldText: "world", newText: "pi" }] }),
      call("read", { path: "../outside.txt" }),
      call("bash", { command: "cat a.txt", cwd: "notes" }),
      // Outside the workspace: files of the same machine (guest.root here).
      call("write", { path: "/home/agent/portal-runtime/start-portal.sh", content: "#!/bin/sh\nexec node portal.js\n" }),
      call("edit", { path: "~/portal-runtime/start-portal.sh", edits: [{ oldText: "node", newText: "bun" }] }),
      call("read", { path: "/tmp/notes/../screens/note.txt" }),
      call("read", { path: "/proc/self/environ" }),
      call("read", { path: "/tmp/host/durable-agent-test.ts" }),
      call("read", { path: "~bob/notes.md" }),
      fauxAssistantMessage("done"),
    ]) });
    fs.mkdirSync(path.join(guest.root, "tmp/screens"), { recursive: true });
    fs.writeFileSync(path.join(guest.root, "tmp/screens/note.txt"), "in the machine\n");
    fs.symlinkSync(import.meta.dirname, path.join(guest.root, "tmp/host"));
    try {
      const submission = await agent.conversation.submit({ type: "input", content: "use the tools", requestId: "tools" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      assert.equal(fs.readFileSync(path.join(files, "notes/a.txt"), "utf8"), "hello\npi\n");
      const [write, read, edit, outside, bash, machineWrite, machineEdit, machineRead, pseudo, host, otherHome] = await results(agent);
      assert.match(text(write), /Successfully wrote/);
      assert.equal(text(read), "hello\nworld\n");
      assert.match(text(edit), /Successfully replaced 1 block/);
      // ../outside.txt is the machine's /outside.txt, which does not exist.
      assert.equal(outside.isError, true);
      assert.match(text(outside), /does not exist/);
      assert.match(text(machineWrite), /Successfully wrote/);
      assert.match(text(machineEdit), /Successfully replaced 1 block/);
      assert.equal(fs.readFileSync(path.join(guest.root, "home/agent/portal-runtime/start-portal.sh"), "utf8"), "#!/bin/sh\nexec bun portal.js\n");
      assert.equal(text(machineRead), "in the machine\n");
      assert.equal(pseudo.isError, true);
      assert.match(text(pseudo), /kernel or device filesystem/);
      assert.equal(host.isError, true);
      assert.match(text(host), /leaves the machine/);
      assert.match(text(otherHome), /only ~ and ~\/ name a home/);
      assert.equal(text(bash), "hello\npi\n\n[exit=0; exited]");
      assert.match(JSON.stringify(bash.details), /"operationKey":"pi:[0-9a-f-]+:\d+:bash"/);
      // The same request id never submits twice.
      assert.equal((await agent.conversation.submit({ type: "input", content: "use the tools", requestId: "tools" }, context)).id, submission.id);
    } finally { await agent.close(); }
    // The machine binding is fixed for the storage.
    await assert.rejects(openAgent({ directory, binding: "other", workspace, ...model([]) }), /thread machine binding changed/);
    console.log("ok: pi-durable read/write/edit through the WorkspaceEnv, keyed bash, machine paths outside the workspace (never /proc or the host), request ids, fixed binding");
  }
  {
    // The repository's AGENTS.md/CLAUDE.md on the guest reach the model, and an edit applies to the next generation.
    const { files, directory, guest, workspace } = thread("instructions");
    fs.writeFileSync(path.join(files, "AGENTS.md"), "The secret word is PAPAYA.\n");
    const seen: string[] = [];
    const agent = await openAgent({ directory, binding: guest.binding, workspace, ...model([
      async request => { seen.push(JSON.stringify(request)); return call("write", { path: "CLAUDE.md", content: "Answer in haiku.\n" }); },
      async request => { seen.push(JSON.stringify(request)); return fauxAssistantMessage("done"); },
    ]) });
    try {
      const submission = await agent.conversation.submit({ type: "input", content: "go", requestId: "instructions" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      assert.match(seen[0]!, /Contents of AGENTS\.md in the thread workspace[^"]*PAPAYA/);
      assert.doesNotMatch(seen[0]!, /Answer in haiku/);
      assert.match(seen[1]!, /Contents of CLAUDE\.md in the thread workspace[^"]*Answer in haiku/);
    } finally { await agent.close(); }
    console.log("ok: repository AGENTS.md and CLAUDE.md come from the guest workspace and follow edits");
  }
  {
    // Keys and expectedSha: a replayed write is not written twice, and a
    // write after a read is conditional on what was read.
    const { files, workspace } = thread("env");
    const lease = await workspace.lease({ owner: "pi" });
    const env = () => new WorkspaceEnv({ workspace, token: lease.token, id: "env", key: "pi:test:1" });
    assert.equal((await env().writeFile("/workspace/a.txt", "one", context)).ok, true);
    fs.writeFileSync(path.join(files, "a.txt"), "changed");
    assert.equal((await env().writeFile("a.txt", "one", context)).ok, true, "same key and request replays the result");
    assert.equal(fs.readFileSync(path.join(files, "a.txt"), "utf8"), "changed", "a replay never writes again");
    const conflict = await env().writeFile("a.txt", "two", context);
    assert(!conflict.ok && /CONFLICT/.test(conflict.error.message));
    const reader = new WorkspaceEnv({ workspace, token: lease.token, id: "env", key: "pi:test:2" });
    assert.equal((await reader.readTextFile("a.txt", context)).ok, true);
    fs.writeFileSync(path.join(files, "a.txt"), "changed again");
    const stale = await reader.writeFile("a.txt", "mine", context);
    assert(!stale.ok && /changed since it was read/.test(stale.error.message));
    assert.deepEqual(await reader.exists("missing", context), { ok: true, value: false });
    // The file tools read whole files up to a cap; larger ones are for bash,
    // refused after the first page instead of paging gigabytes into cubed.
    fs.writeFileSync(path.join(files, "big.log"), Buffer.alloc(MAX_FILE_READ_BYTES + 1, 0x61));
    let pages = 0;
    const counting = new Proxy(workspace, { get: (target, name) => name === "readFile"
      ? (...args: Parameters<typeof workspace.readFile>) => { pages++; return target.readFile(...args); }
      : Reflect.get(target, name, target) });
    const big = await new WorkspaceEnv({ workspace: counting, token: lease.token, id: "env", key: "pi:test:3" }).readTextFile("big.log", context);
    assert(!big.ok && big.error.code === "invalid" && /use bash/.test(big.error.message), "a file over the cap is refused");
    assert.equal(pages, 1, "only the first page was read");
    fs.writeFileSync(path.join(files, "fits.log"), Buffer.alloc(MAX_FILE_READ_BYTES, 0x62));
    const fits = await reader.readBinaryFile("fits.log", context);
    assert(fits.ok && fits.value.length === MAX_FILE_READ_BYTES, "a file at the cap is read whole");
    const shell = await reader.exec();
    assert(!shell.ok && shell.error.code === "shell_unavailable");
    await workspace.release(lease.token);
    console.log("ok: WorkspaceEnv write keys replay without writing, expectedSha after read, read size cap, no shell fallback");
  }
  {
    // Stop cancels the guest command for real.
    const { files, directory, guest, workspace } = thread("stop");
    const agent = await openAgent({ directory, binding: guest.binding, workspace, ...model([
      call("bash", { command: "sleep 5; touch late" }),
      fauxAssistantMessage("unreachable"),
    ]) });
    try {
      await agent.conversation.submit({ type: "input", content: "wait" }, context);
      await until(async () => (await live(agent))?.tools?.some(slot => slot.status === "running") ?? false, "running bash");
      await delay(100);
      await agent.conversation.abort(context);
      assert.equal((await live(agent))?.run, undefined);
      await delay(300);
      assert.equal(fs.existsSync(path.join(files, "late")), false, "the command was killed");
      const [result] = await results(agent);
      assert.equal(result.isError, true);
    } finally { await agent.close(); }
    console.log("ok: stop aborts the run and cancels the guest command");
  }
  {
    // Shutdown leaves a running command alone; the next process reattaches.
    const { files, directory, guest, workspace } = thread("shutdown");
    const steps = model([call("bash", { command: "sleep 0.5; printf x >> count; printf done" }), fauxAssistantMessage("first")]);
    let agent = await openAgent({ directory, binding: guest.binding, workspace, ...steps });
    const submission = await agent.conversation.submit({ type: "input", content: "count" }, context);
    await until(async () => (await live(agent))?.tools?.some(slot => slot.status === "running") ?? false, "running bash");
    await agent.close();
    await delay(800);
    assert.equal(fs.readFileSync(path.join(files, "count"), "utf8"), "x", "shutdown did not cancel the command");
    agent = await openAgent({ directory, binding: guest.binding, workspace, ...model([fauxAssistantMessage("recovered")]) });
    try {
      const settled = await (await agent.harness.submission(submission.id, context))!.wait(context);
      assert.equal(settled.status, "done");
      const [result] = await results(agent);
      assert.equal(text(result), "done\n[exit=0; exited]");
      assert.equal(fs.readFileSync(path.join(files, "count"), "utf8"), "x", "the replayed call found the same command");
    } finally { await agent.close(); }
    console.log("ok: shutdown keeps the guest command; reopen replays bash by task key without running it again");
  }
  {
    // A thread directory from before pi-durable is refused: opening it would
    // start an empty conversation and run the first message again.
    for (const legacy of ["session", "owner.sqlite"]) {
      const { directory, guest, workspace } = thread(`legacy-${legacy}`);
      if (legacy === "session") fs.mkdirSync(path.join(directory, "session"), { recursive: true });
      else fs.writeFileSync(path.join(directory, "owner.sqlite"), "");
      const steps = model([call("bash", { command: "touch must-not-run" }), fauxAssistantMessage("no")]);
      await assert.rejects(openAgent({ directory, binding: guest.binding, workspace, ...steps }), (error: Error) => error.message === LEGACY_THREAD);
      assert.equal(fs.existsSync(path.join(directory, "pi.sqlite")), false, "no new Pi store is created");
      assert.equal(await workspace.lease({ owner: "pi" }).then(lease => workspace.release(lease.token)).then(() => true), true, "the lease was never taken");
    }
    console.log("ok: a thread directory with the old Pi store is refused before any lease, store or submission");
  }
} finally {
  for (const guest of guests) guest.stop();
  for (const store of stores) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
