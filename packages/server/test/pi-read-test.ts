/** Real Pi Harness/QuickJS/guest helper; faux vision provider, not visual inspection. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openAgent } from "../src/durable-agent.ts";
import { checkedPiImage, createPiReadTool } from "../src/pi-read.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";
import { readPiHistory } from "../src/thread-history.ts";
import { readThreadImage } from "../src/thread-images.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

type ReadCase = { name: string; args: Parameters<typeof fauxToolCall>[1]; images: number; error?: boolean; text?: RegExp };

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-read-"));
const png = fs.readFileSync(new URL("fixtures/pi-read.png", import.meta.url));
const jpg = fs.readFileSync(new URL("fixtures/pi-read.jpg", import.meta.url));
const gif = fs.readFileSync(new URL("fixtures/pi-read.gif", import.meta.url));
const webp = fs.readFileSync(new URL("fixtures/pi-read.webp", import.meta.url));
const standaloneMarkers = Buffer.from([0xff, 0x01, ...Array.from({ length: 8 }, (_, n) => [0xff, 0xd0 + n]).flat()]);
const standaloneJpg = Buffer.concat([jpg.subarray(0, 2), standaloneMarkers, jpg.subarray(2)]);
const lfsPointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`;
const imageFixtures = new Map<string, Buffer[]>([["image/png", [png]], ["image/jpeg", [jpg, standaloneJpg]], ["image/gif", [gif]], ["image/webp", [webp]]]);
// Fixtures authored with Chromium canvas: 360×180 white field, orange square,
// blue circle, 'cube 427'. This description is provenance, not model evidence.
for (const [bytes, mimeType] of [[png, "image/png"], [jpg, "image/jpeg"], [gif, "image/gif"], [webp, "image/webp"]] as const) {
  assert.equal(checkedPiImage(bytes).mimeType, mimeType);
  assert.throws(() => checkedPiImage(bytes.subarray(0, -1)), /end marker/);
}
// Standalone TEM and each RSTn marker must not be treated as segment lengths.
for (const marker of [0x01, ...Array.from({ length: 8 }, (_, n) => 0xd0 + n)]) {
  assert.equal(checkedPiImage(Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, marker]), jpg.subarray(2)])).mimeType, "image/jpeg");
}
for (const bytes of [jpg, gif]) {
  assert.throws(() => checkedPiImage(Buffer.concat([bytes, Buffer.from("trailer")])), error => {
    assert(error instanceof Error);
    assert.match(error.message, /trailing bytes/);
    assert.doesNotMatch(error.message, /truncated/);
    return true;
  });
}
// Tool invocation without a catalog entry is not evidence of text-only input.
await assert.rejects(() => createPiReadTool(createModels()).execute({ path: "a.png" }, {
  env: { absolutePath: async (file: string) => ok(file), exists: async () => ok(true), readBinaryFile: async () => ok(png) } as unknown as ExecutionEnv,
  agent: async () => ({ model: { provider: "unavailable", modelId: "gone" } }),
} as unknown as ToolExecutionApi, context), /unavailable in the model catalog/);
const corrupt = Buffer.from(png); corrupt[50] = corrupt[50]! ^ 1;
assert.throws(() => checkedPiImage(corrupt), /malformed PNG/);
assert.throws(() => checkedPiImage(Buffer.alloc(2 * 1024 * 1024 + 1)), /2 MiB/);
assert.throws(() => checkedPiImage(Buffer.from("<svg></svg>")), /only png/);
const huge = Buffer.from(png); huge.writeUInt32BE(2001, 16);
assert.throws(() => checkedPiImage(huge), /2000 pixels/);

try {
  for (const vision of [true, false]) {
    const dir = path.join(root, String(vision));
    const files = path.join(dir, "workspace");
    fs.mkdirSync(files, { recursive: true });
    for (const [name, bytes] of Object.entries({ "a.png": png, "a.jpg": jpg, "a.gif": gif, "a.webp": webp, "standalone.jpg": standaloneJpg, "no-extension": png,
      "trailing.jpg": Buffer.concat([jpg, Buffer.from("trailer")]), "trailing.gif": Buffer.concat([gif, Buffer.from("trailer")]),
      "lfs.png": Buffer.from(lfsPointer), "invalid.png": Buffer.from([0x89, 1, 255]), "latin1.txt": Buffer.from([0xe9]),
      "wrong.jpg": png, "truncated.png": png.subarray(0, -20), "fake.png": Buffer.from("not an image"),
      "a.txt": Buffer.from("one\ntwo\nthree"), "binary": Buffer.from([0, 1, 255]) })) fs.writeFileSync(path.join(files, name), bytes);
    fs.writeFileSync(path.join(files, "oversized.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const guest = new LocalGuestTransport(dir);
    const directory = path.join(dir, "thread");
    const leases = new LeaseStore(directory);
    const workspace = new VmWorkspace({ guest, leases, owner: "pi", binding: guest.binding });
    const faux = fauxProvider({ tokensPerSecond: 1e9, models: [{ id: "test", input: vision ? ["text", "image"] : ["text"] }] });
    const models = createModels(); models.setProvider(faux.provider);
    const requests: ReadCase[] = vision ? [
      { name: "read", args: { path: "a.png", offset: 500, limit: 1 }, images: 1 },
      { name: "read", args: { path: "a.jpg" }, images: 1 },
      { name: "read", args: { path: "no-extension" }, images: 1 },
      ...["a.gif", "a.webp", "standalone.jpg"].map(file => ({ name: "read", args: { path: file }, images: 1 })),
      ...["trailing.jpg", "trailing.gif"].flatMap((file): ReadCase[] => [
        { name: "read", args: { path: file }, images: 0, error: true, text: /trailing bytes/ },
        { name: "codemode", args: { code: `await tools.read({path:${JSON.stringify(file)}})` }, images: 0, error: true, text: /trailing bytes/ },
      ]),
      { name: "read", args: { path: "lfs.png" }, images: 0, text: /version https:\/\/git-lfs.github.com\/spec\/v1/ },
      { name: "codemode", args: { code: 'return await tools.read({path:"lfs.png"})' }, images: 0, text: /oid sha256:/ },
      { name: "read", args: { path: "fake.png" }, images: 0, text: /not an image/ },
      { name: "read", args: { path: "wrong.jpg" }, images: 1 },
      { name: "read", args: { path: "a.txt", offset: 2, limit: 1 }, images: 0, text: /two/ },
      ...["truncated.png", "invalid.png", "latin1.txt", "binary", "oversized.png", "../escape"].map(file => ({ name: "read", args: { path: file }, images: 0, error: true })),
      { name: "codemode", args: { code: 'await tools.read({path:"a.png"}); return await tools.read({path:"a.jpg"})' }, images: 2 },
      { name: "codemode", args: { code: 'return await tools.read({path:"invalid.png"})' }, images: 0, error: true },
      { name: "codemode", args: { code: 'await tools.read({path:"a.gif"}); await tools.read({path:"a.webp"}); await tools.read({path:"standalone.jpg"})' }, images: 3 },
      { name: "codemode", args: { code: 'return await tools.read({path:"a.txt",offset:2,limit:1})' }, images: 0, text: /two/ },
      { name: "codemode", args: { code: 'for(let i=0;i<9;i++) await tools.read({path:"a.png"})' }, images: 8, error: true, text: /image budget/ },
      { name: "codemode", args: { code: 'await tools.read({path:"a.jpg"}); throw Error("after read")' }, images: 1, error: true },
    ] : [
      { name: "read", args: { path: "a.png" }, images: 0, error: true, text: /vision-capable/ },
      { name: "codemode", args: { code: 'await tools.read({path:"a.jpg"})' }, images: 0, error: true, text: /vision-capable/ },
    ];
    let checked = 0;
    const delivered: ImageContent[] = [];
    faux.setResponses(requests.flatMap(request => [
      fauxAssistantMessage([fauxToolCall(request.name, request.args)], { stopReason: "toolUse" }),
      (transcript: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[0]) => {
        const result = transcript.messages.findLast(message => message.role === "toolResult");
        assert(result?.role === "toolResult");
        assert.equal(!!result.isError, !!request.error, JSON.stringify(result));
        const images = result.content.filter((part): part is ImageContent => part.type === "image");
        assert.equal(images.length, request.images);
        for (const image of images) {
          assert(imageFixtures.get(image.mimeType)?.some(bytes => bytes.equals(Buffer.from(image.data, "base64"))), `exact fixture bytes for ${image.mimeType}`);
          delivered.push(image);
        }
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        if (request.text) assert.match(text, request.text);
        assert(!text.includes(png.toString("base64")), "no image base64 in text/QuickJS return");
        checked++;
        return fauxAssistantMessage("mock result checked; no visual inspection");
      },
    ]));
    const agent = await openAgent({ directory, binding: guest.binding, workspace, models, model: { provider: faux.getModel().provider, id: "test" } });
    try {
      for (const request of requests) {
        const settled = await (await agent.conversation.submit({ type: "input", content: `test ${request.name}` }, context)).wait(context);
        assert.equal(settled.status, "done");
      }
      assert.equal(checked, requests.length);
      const transcript = await new PiThreadEvents({ agent, owner: () => "pi", failure: () => null }).read();
      assert.equal(transcript.events.flatMap(event => event.type === "tool-result" ? event.images ?? [] : []).length, delivered.length);
    } finally { await agent.close(); guest.stop(); leases.close(); }
    // Read durable image bytes only after closing Pi and deleting guest files.
    fs.rmSync(files, { recursive: true, force: true });
    const file = path.join(directory, "pi.sqlite");
    let before: number | undefined;
    const images: import("../src/thread-events.ts").MessageImage[] = [];
    do {
      const history = (await readPiHistory(file, null, null, { limit: 40, before }))!;
      images.unshift(...history.events.flatMap(event => event.type === "tool-result" ? event.images ?? [] : []));
      before = history.start;
    } while (before > 0);
    assert.equal(images.length, delivered.length);
    images.forEach((image, index) => assert.deepEqual(readThreadImage({ agent: "pi", file }, image.id)?.bytes, Buffer.from(delivered[index]!.data, "base64")));
    console.log(`ok: Pi direct/codemode reads, model image capability=${vision}, durable display refs after guest deletion (faux provider)`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
