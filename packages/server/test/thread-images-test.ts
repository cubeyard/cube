/** Images in thread transcripts: a Claude Code Read of a screenshot (the
 * stream the real `claude` 2.1.293 printed for its own Read of a Chromium
 * screenshot, recorded against a mock API) and a Pi tool's image (a real
 * Harness, faux model) are shown by reference, never as base64, in the live
 * transcript and in stored history alike; the reference serves the same
 * bytes from the thread's store and nothing else. Disposable state only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { render } from "../src/claude-thread-events.ts";
import { openStorage } from "../src/durable-agent.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import type { ThreadEvent } from "../src/thread-events.ts";
import { readClaudeHistory, readPiHistory } from "../src/thread-history.ts";
import { isThreadImageRef, readThreadImage, THREAD_IMAGE_LIMITS } from "../src/thread-images.ts";
import type { Workspace } from "../src/workspace.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-images-"));
const results = (events: ThreadEvent[]) => events.filter((event): event is Extract<ThreadEvent, { type: "tool-result" }> => event.type === "tool-result");

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 90)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

try {
  // Claude Code: the recorded stream, stored as ClaudeAgent stores it.
  {
    const directory = path.join(root, "claude");
    fs.mkdirSync(directory);
    const workspace = { lease: async () => ({ token: "t" }), release: async () => {}, cancel: async () => {} } as unknown as Workspace;
    await (await ClaudeAgent.open({ directory, threadId: "images", workspace, runtime: { command: ["false"], mod: "", socket: "" }, model: "opus" })).close();
    const home = path.join(directory, "claude");
    const recorded = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "claude-2.1.293-read-image.jsonl"), "utf8").trim().split("\n").map(line => line.split("__ROOT__").join(home));
    const screenshot = Buffer.from((JSON.parse(recorded[1]!) as { tool_use_result: { file: { base64: string } } }).tool_use_result.file.base64, "base64");
    const file = path.join(directory, "claude.sqlite");
    const db = new DatabaseSync(file);
    const seq = Number(db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES ('r1', 'read the screenshot', 'completed', NULL, 0)").run().lastInsertRowid);
    const store = (data: unknown) => Number(db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)").run(seq, typeof data === "string" ? data : JSON.stringify(data)).lastInsertRowid);
    const rows = recorded.map(store);
    const toolResult = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", parent_tool_use_id: null, ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${Math.random()}`, content }] } });
    const image = (data: string, mediaType = "image/png") => ({ type: "image", source: { type: "base64", data, media_type: mediaType } });
    const svg = store(toolResult([image(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>").toString("base64"))]));
    const garbled = store(toolResult([image(`${screenshot.toString("base64").slice(0, 100)}!!`)]));
    const huge = store(toolResult([image(Buffer.alloc(THREAD_IMAGE_LIMITS.bytes + 3, 1).toString("base64"))]));
    const bmp = store(toolResult([image(screenshot.toString("base64"), "image/bmp")]));
    const subagent = store(toolResult([image(screenshot.toString("base64"))], { parent_tool_use_id: "toolu_agent" }));
    const many = store(toolResult([{ type: "text", text: "a contact sheet" }, ...Array.from({ length: THREAD_IMAGE_LIMITS.perEvent + 2 }, () => image(screenshot.toString("base64")))]));
    db.close();
    const state = { submissions: [{ seq, requestId: "r1", text: "read the screenshot", state: "completed" as const, error: null }],
      messages: (new DatabaseSync(file, { readOnly: true }).prepare("SELECT seq, submission, data FROM message ORDER BY seq").all() as Array<{ seq: number; submission: number; data: string }>)
        .map(row => ({ seq: row.seq, submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> })), partial: [], waiting: [] };
    const transcript = render(state as never, "claude-code", null, home);
    assert.ok(!JSON.stringify(transcript).includes(screenshot.toString("base64").slice(0, 64)), "no base64 reaches the transcript");
    const [read, ...others] = results(transcript.events);
    assert.deepEqual(read, { type: "tool-result", id: `m${rows[1]}.0`, callId: "toolu_read1", name: "Read", output: "", isError: false, final: true,
      images: [{ id: `m${rows[1]}.0.0`, mimeType: "image/png" }] }, "Claude Code's Read result is the image");
    const call = transcript.events.find(event => event.type === "tool-call");
    assert.deepEqual(call?.type === "tool-call" && call.input, { file_path: "/workspace/.shots/07-thread-received.png" }, "the path the browser sees is the workspace's");
    const said = transcript.events.at(-(others.length + 1));
    assert.match(said?.type === "assistant-text" ? said.text : "", /!\[thread received\]\(\/workspace\/\.shots\/07-thread-received\.png\)/);

    const claude = (ref: string) => readThreadImage({ agent: "claude-code", file }, ref);
    const served = claude(read!.images![0]!.id);
    assert.equal(served?.mimeType, "image/png");
    assert.deepEqual(served?.bytes, screenshot, "the bytes the model saw");
    assert.deepEqual(screenshot.subarray(16, 24), Buffer.from([0, 0, 2, 0x80, 0, 0, 1, 0x90]), "the recorded screenshot is 640×400");

    // Stored history (archived threads, OptChat's history tool) names the same image.
    const page = await readClaudeHistory(file, home, null, null, { limit: 40 });
    assert.deepEqual(results(page!.events)[0], read);

    // Shown by reference only when cube serves it; served only when its bytes are an image.
    const byRow = (row: number) => results(transcript.events).find(event => event.id === `m${row}.0`)!;
    assert.deepEqual(byRow(svg).images, [{ id: `m${svg}.0.0`, mimeType: "image/png" }], "the declared type names it");
    assert.equal(claude(`m${svg}.0.0`), null, "svg bytes under a png type are never served");
    assert.equal(claude(`m${garbled}.0.0`), null, "malformed base64");
    assert.equal(claude(`m${huge}.0.0`), null, "over the byte limit");
    assert.deepEqual([byRow(bmp).images, byRow(bmp).output], [undefined, "[image]"], "a type cube does not serve stays a mark");
    assert.equal(claude(`m${bmp}.0.0`), null);
    assert.ok(!results(transcript.events).some(event => event.id === `m${subagent}.0`), "subagent internals are not shown");
    assert.equal(claude(`m${subagent}.0.0`), null, "nor served");
    assert.equal(byRow(many).images?.length, THREAD_IMAGE_LIMITS.perEvent);
    assert.equal(byRow(many).output, "a contact sheet\n[2 more images]");
    assert.equal(claude(`m${many}.0.0`), null, "a text part is no image");
    assert.deepEqual(claude(`m${many}.0.${THREAD_IMAGE_LIMITS.perEvent + 2}`)?.bytes, screenshot, "every stored image part has its reference");
    for (const ref of [`m${rows[0]}.0.0`, `m${rows[2]}.0.0`, `m${rows[1]}.1.0`, `m${rows[1]}.0.1`, `m${rows[1]}.0.00`, "m999.0.0", `${rows[1]}.0.0`, "../claude.sqlite", "m1.0.0/../x", ""]) {
      assert.equal(claude(ref), null, ref);
    }
    assert.equal(readThreadImage({ agent: "pi", file }, read!.images![0]!.id), null, "a claude reference means nothing to a pi store");
    assert.equal(readThreadImage({ agent: "claude-code", file: path.join(root, "absent.sqlite") }, read!.images![0]!.id), null, "a thread without a store has no images");
    assert.equal(fs.existsSync(path.join(root, "absent.sqlite")), false, "and gets none created");
    assert.ok(isThreadImageRef("m3.0.1") && isThreadImageRef("12.0.3") && !isThreadImageRef("m03.0.1") && !isThreadImageRef("a".repeat(64)));
    console.log("ok: claude code's recorded read of a screenshot shows by reference, live and stored; its bytes are served unchanged; svg, malformed, oversized, subagent and foreign references are not");
  }

  // Pi: a tool that returns an image, through a real Harness.
  {
    const directory = path.join(root, "pi");
    fs.mkdirSync(directory);
    const file = path.join(directory, "pi.sqlite");
    const picture = png(48, 30);
    const faux = fauxProvider({ tokensPerSecond: 1e9 });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("look", { path: ".shots/a.png" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage("it is a grey square: ![a](.shots/a.png)"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "images", tools: [defineTool({
      name: "look", description: "returns an image", parameters: Type.Object({ path: Type.String() }), replay: "safe",
      async execute() { return { content: [{ type: "text" as const, text: "48×30" }, { type: "image" as const, data: picture.toString("base64"), mimeType: "image/png" }] }; },
    })] }));
    const harness = await Harness.open(await openStorage(file), { models, registry }, context);
    try {
      const conversation = await harness.root(context, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
      const settled = await (await conversation.submit({ type: "input", content: "look at it", requestId: "r1" }, context)).wait(context);
      assert.equal(settled.status, "done");
    } finally { await harness.close(context); }
    const storage = await openStorage(file);
    let transcript;
    try { transcript = await storedPiTranscript(storage, null, null); }
    finally { await storage.close(context); }
    assert.ok(!JSON.stringify(transcript).includes(picture.toString("base64").slice(0, 64)));
    const [look] = results(transcript.events);
    assert.equal(look?.output, "48×30");
    assert.equal(look?.images?.length, 1);
    assert.match(look!.images![0]!.id, /^\d+\.0\.1$/);
    assert.deepEqual(readThreadImage({ agent: "pi", file }, look!.images![0]!.id), { bytes: picture, mimeType: "image/png" });
    assert.deepEqual(results((await readPiHistory(file, null, null, { limit: 40 }))!.events)[0], look, "stored history names the same image");
    assert.equal(readThreadImage({ agent: "pi", file }, look!.images![0]!.id.replace(/\.1$/, ".0")), null, "the text part is no image");
    assert.equal(readThreadImage({ agent: "claude-code", file }, `m${look!.images![0]!.id}`), null);
    console.log("ok: a pi tool's image shows by reference in the transcript and stored history and is served from the thread's store");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
