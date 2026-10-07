/** Images in OptChat: the store takes only real png, jpeg, gif and webp
 * images within bounds and serves them by id; a message holds a reference,
 * the request hook gives the model the image itself in that turn only, and
 * the log, view, stored entries and transcripts keep no base64. A model that
 * takes no images is refused before anything is sent. Unsent uploads are
 * swept; a reopen shows the images again. cubed's routes upload and serve
 * them with headers that keep them inert. Faux models, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { OptChat, OptChatEvents, withImages, type OptThreads } from "../src/optchat.ts";
import { MEDIA_LIMITS, MediaError, mediaData, MediaStore, sniffImage } from "../src/optchat-media.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-media-"));
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");

/** A real png of `width`×`height`, one colour per call. */
function png(width: number, height: number, shade = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, shade)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const gif = (width: number, height: number) => Buffer.from([...Buffer.from("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0, 0x3b]);
function webp(width: number, height: number): Buffer {
  const bits = Buffer.alloc(4); bits.writeUInt32LE((width - 1) | ((height - 1) << 14));
  const payload = Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(7)]);
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  const riff = Buffer.alloc(4); riff.writeUInt32LE(payload.length + 12);
  return Buffer.concat([Buffer.from("RIFF"), riff, Buffer.from("WEBPVP8L"), size, payload]);
}

// Formats come from the bytes alone; nothing the browser could run passes.
assert.deepEqual(sniffImage(png(3, 2)), { mimeType: "image/png", width: 3, height: 2 });
assert.deepEqual(sniffImage(jpeg(640, 480)), { mimeType: "image/jpeg", width: 640, height: 480 });
assert.deepEqual(sniffImage(gif(5, 7)), { mimeType: "image/gif", width: 5, height: 7 });
assert.deepEqual(sniffImage(webp(300, 200)), { mimeType: "image/webp", width: 300, height: 200 });
for (const [bytes, why] of [
  [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /only png, jpeg, gif and webp/],
  [Buffer.from("<!doctype html><script>alert(1)</script>"), /only png, jpeg, gif and webp/],
  [png(3, 2).subarray(0, 20), /only png, jpeg, gif and webp/],
  [Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]), /not a readable jpeg/],
  [png(MEDIA_LIMITS.side + 1, 1), /at most 8000 pixels a side/],
] as const) assert.throws(() => sniffImage(bytes), why);

// The store: content-addressed, ids only, whole files, sweeps unsent uploads.
const store = new MediaStore(path.join(root, "store"));
const stored = store.put(png(3, 2));
assert.equal(store.put(png(3, 2)).id, stored.id, "the same bytes, the same id");
assert.deepEqual(store.get(stored.id)?.bytes, png(3, 2));
for (const id of ["../store", `${stored.id}/../${stored.id}`, stored.id.toUpperCase(), "", "a".repeat(63)]) assert.equal(store.get(id), null, `refused id ${id}`);
assert.throws(() => store.put(Buffer.alloc(0)), /empty/);
assert.throws(() => store.put(Buffer.concat([png(1, 1), Buffer.alloc(MEDIA_LIMITS.bytes)])), (error: unknown) => error instanceof MediaError && error.status === 413);
fs.writeFileSync(path.join(store.directory, `.${stored.id}.0.tmp`), "half");
fs.writeFileSync(path.join(store.directory, "notes.txt"), "not ours");
const other = store.put(gif(1, 1));
const old = new Date(Date.now() - 3_600_000);
for (const name of fs.readdirSync(store.directory)) fs.utimesSync(path.join(store.directory, name), old, old);
assert.equal(store.sweep(new Set([stored.id]), Date.now() - 60_000), 2, "the unsent upload and the crash's temporary file");
assert.ok(store.has(stored.id) && !store.has(other.id) && fs.existsSync(path.join(store.directory, "notes.txt")));
console.log("ok: images are recognized by their own bytes and bounded; the store is content-addressed and swept");

// The hook: references become images, newest first up to the limit; what
// cannot go becomes a note, never a gap.
const user = (...ids: string[]): Message => ({ role: "user", timestamp: 0, content: [{ type: "text", text: "look" }, ...ids.map(id => ({ type: "image" as const, mimeType: "image/png", data: mediaData(id) }))] });
const ids = ["a", "b", "c"].map(letter => letter.repeat(64));
const load = (id: string) => id === ids[2] ? null : { bytes: Buffer.from(id.slice(0, 1)), mimeType: "image/png" };
const hooked = withImages([user(ids[0]!), user(ids[1]!, ids[2]!)], { load, refused: null, limit: 1 });
const earlier = "(an earlier image of this turn, not sent: a turn's requests carry at most 1 images)";
assert.deepEqual(hooked.map(message => message.content), [
  [{ type: "text", text: "look" }, { type: "text", text: earlier }],
  [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: Buffer.from("b").toString("base64") }, { type: "text", text: "(an image the user attached, missing from cube's store)" }],
]);
assert.match(JSON.stringify(withImages([user(ids[0]!)], { load, refused: "blind does not take images", limit: 8 })), /not sent: blind does not take images/);
const bounded = withImages([user(ids[0]!, ids[1]!)], { load: () => ({ bytes: Buffer.alloc(6), mimeType: "image/png" }), refused: null, limit: 8, bytes: 10 });
assert.deepEqual((bounded[0]!.content as Array<{ type: string }>).map(part => part.type), ["text", "text", "image"], "the turn's bytes are bounded too, newest kept");
const plain: Message = { role: "user", timestamp: 0, content: [{ type: "image", mimeType: "image/png", data: "aGk=" }] };
assert.equal(withImages([plain], { load, refused: null, limit: 8 })[0], plain, "an image that is not a reference is left alone");
console.log("ok: the request hook fills in the turn's images and notes what it cannot send");

// OptChat with a faux model that sees images and one that does not.
const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "vision", input: ["text", "image"] }, { id: "blind", input: ["text"] }] });
const requests: Message[][] = [];
// Closed, the compactor holds the view unsettled, so new messages wait.
let compactorGate: Promise<void> = Promise.resolve();
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) { await compactorGate; return fauxAssistantMessage("summary"); }
  requests.push(request.messages.filter(message => message.role !== "system"));
  const last = request.messages.at(-1)!;
  if (last.role === "user" && JSON.stringify(last.content).includes("check the projects")) {
    return fauxAssistantMessage([fauxToolCall("projects", {}, { id: `call-${requests.length}` })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(`reply ${requests.length}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const vision = { provider: faux.models[0].provider, id: "vision" };
let projectsGate: Promise<void> = Promise.resolve();
let inProjects = false;
const threads: OptThreads = {
  async projects() { inProjects = true; await projectsGate; inProjects = false; return "projects: none"; }, async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
  async events() { return null; }, async history() { return null; },
};
const directory = path.join(root, "optchat");
const open = () => OptChat.open({ directory, models, model: async () => vision, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
const imagesOf = (messages: Message[]) => messages.flatMap(message => message.role === "user" && typeof message.content !== "string" ? message.content.filter(part => part.type === "image") : []);
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let k = 0; k < 500 && !await check(); k++) await delay(10);
  assert.ok(await check(), what);
}
const transcript = async (optchat: OptChat) => new OptChatEvents(optchat, new PiThreadEvents({ agent: optchat.agent, owner: () => null, failure: () => null })).read();
const settled = async (optchat: OptChat, count: number) => {
  await until(() => requests.length >= count, `request ${count}`);
  await optchat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await until(async () => !(await optchat.pending()).length, "nothing waits");
};

const picture = png(4, 4, 200);
let chat = await open();
let sent: string;
try {
  assert.deepEqual(chat.imageSupport(), { supported: true, reason: null });
  const first = await chat.upload(picture);
  assert.deepEqual({ ...first, id: undefined }, { id: undefined, mimeType: "image/png", width: 4, height: 4, bytes: picture.byteLength });
  assert.equal(await chat.image(first.id), null, "an upload no message holds is not served");
  await chat.send("what is this?", "m1", [first.id]);
  await settled(chat, 1);
  // The model gets the image itself, after the view, in its own message.
  const turn = requests[0]!;
  assert.equal(turn.length, 1);
  const blocks = turn[0]!.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  assert.match(blocks[0]!.text!, /^<chat>/);
  assert.deepEqual(blocks.slice(-2), [{ type: "text", text: "what is this?" }, { type: "image", mimeType: "image/png", data: picture.toString("base64") }]);
  // Nothing else holds the base64: not the log, the view, the store or the transcript.
  sent = picture.toString("base64");
  await until(() => chat.memory.settled(), "the view is summarized");
  assert.equal(chat.memory.messages[0]!.text, "what is this?\n[image]");
  assert.ok(!chat.memory.render().includes(sent));
  const files = fs.readdirSync(directory).filter(name => name.startsWith("pi.sqlite")).map(name => fs.readFileSync(path.join(directory, name), "latin1")).join("");
  assert.ok(files.includes(mediaData(first.id)) && !files.includes(sent), "the Pi store keeps the reference, not the bytes");
  const shown = await transcript(chat);
  assert.ok(!JSON.stringify(shown).includes(sent));
  assert.deepEqual(shown.events.find(event => event.type === "user-message"), { type: "user-message", id: shown.events[0]!.id, text: "what is this?", images: [{ id: first.id, mimeType: "image/png" }] });
  assert.deepEqual((await chat.image(first.id))?.bytes, picture);
  // A resend of the same request is accepted once.
  await chat.send("what is this?", "m1", [first.id]);
  assert.deepEqual(await chat.pending(), []);
  assert.equal(requests.length, 1);

  // The next turn is a fresh context: the image is not sent again.
  await chat.send("and the weather?", "m2");
  await settled(chat, 2);
  assert.deepEqual(imagesOf(requests[1]!), []);
  assert.match(JSON.stringify(requests[1]), /\[image\]/, "the view says an image was there");

  // Images alone, several, and the bounds.
  const second = await chat.upload(gif(2, 2));
  const third = await chat.upload(webp(9, 9));
  await chat.send("", "m3", [second.id, third.id, second.id]);
  await settled(chat, 3);
  const last = requests[2]!.at(-1)!.content as Array<{ type: string; mimeType?: string }>;
  assert.deepEqual(last.filter(part => part.type === "image").map(part => part.mimeType), ["image/gif", "image/webp"], "a repeated image goes once");
  assert.ok(!last.some(part => part.type === "text" && "text" in part && part.text === ""), "no empty text block");
  await assert.rejects(chat.send("too many", "m4", Array.from({ length: MEDIA_LIMITS.perMessage + 1 }, (_, k) => String(k).repeat(64))), /at most 4 images a message/);
  await assert.rejects(chat.send("gone", "m5", ["f".repeat(64)]), (error: unknown) => error instanceof MediaError && error.status === 404);

  // Images waiting for the chat are bounded; a stop keeps them, unanswered.
  let openCompactor!: () => void;
  compactorGate = new Promise<void>(resolve => { openCompactor = resolve; });
  await chat.send("hold the view", "w0");
  await settled(chat, 4);
  const fourth = await chat.upload(jpeg(8, 8));
  const four = [first.id, second.id, third.id, fourth.id];
  await chat.send("a", "w1", four);
  await chat.send("b", "w2", four);
  await assert.rejects(chat.send("c", "w3", [first.id]), (error: unknown) => error instanceof MediaError && error.status === 429 && /8 images are already waiting/.test(error.message));
  await chat.stop();
  openCompactor();
  await until(async () => !(await chat.pending()).length, "nothing waits after the stop");
  const unanswered = (await transcript(chat)).events.filter(event => event.type === "user-message" && (event.text === "a" || event.text === "b"));
  assert.deepEqual(unanswered.map(event => event.type === "user-message" && event.images?.length), [4, 4], "unanswered messages keep their images");
  assert.deepEqual((await chat.image(fourth.id))?.bytes, jpeg(8, 8));

  // Unsent uploads are bounded; the oldest older than ten minutes goes first.
  const before64 = chat.media.list().length;
  const uploads: string[] = [];
  for (let k = 0; uploads.length + before64 - 4 < MEDIA_LIMITS.unsent; k++) uploads.push((await chat.upload(png(1, 1, k))).id);
  await assert.rejects(chat.upload(png(1, 2)), (error: unknown) => error instanceof MediaError && error.status === 429);
  fs.utimesSync(path.join(chat.media.directory, uploads[0]!), new Date(0), new Date(0));
  await chat.upload(png(1, 2));
  assert.ok(!chat.media.has(uploads[0]!) && chat.media.has(uploads[1]!) && chat.media.has(first.id), "only the oldest unsent upload went");
  for (const id of uploads.slice(1)) fs.rmSync(path.join(chat.media.directory, id));

  // A model that takes no images: refused at upload, send and model change.
  const mark = requests.length;
  await chat.send("waiting with an image", "m6", [first.id]);
  await assert.rejects(chat.selectModel({ provider: vision.provider, id: "blind" }), /blind does not take images, and a message with images is waiting/);
  await settled(chat, mark + 1);
  await chat.selectModel({ provider: vision.provider, id: "blind" });
  assert.deepEqual(chat.imageSupport(), { supported: false, reason: "blind does not take images" });
  await assert.rejects(chat.upload(png(1, 1)), (error: unknown) => error instanceof MediaError && error.status === 422);
  await assert.rejects(chat.send("look", "m7", [first.id]), /not sent: blind does not take images/);
  assert.ok(!(await chat.pending()).length, "a refused message is not kept");
  await chat.selectModel(vision);
  console.log("ok: an image reaches the model in its own turn only; the log, view, store and transcript keep a reference");
  console.log("ok: images alone, repeats, resends, the waiting and unsent bounds, a stop, missing uploads and models without image input");

  // An unsent upload is swept on open; a sent one stays.
  const unsent = await chat.upload(png(2, 2, 9));
  await chat.close();
  const media = path.join(directory, "media");
  for (const name of fs.readdirSync(media)) fs.utimesSync(path.join(media, name), new Date(0), new Date(0));
  chat = await open();
  assert.ok(!fs.existsSync(path.join(media, unsent.id)), "the unsent upload is gone");
  for (const id of [first.id, second.id, third.id]) assert.ok(fs.existsSync(path.join(media, id)), "every sent image stays");
  // A message sent during a tool round is steered in with its image.
  let release!: () => void;
  projectsGate = new Promise<void>(resolve => { release = resolve; });
  const before = requests.length;
  await chat.send("check the projects", "s1");
  await until(() => inProjects, "the tool round runs");
  await chat.send("this too", "s2", [third.id]);
  // Steered once Pi has it, before the round ends.
  await until(async () => (await chat.pending()).every(item => item.requestId !== "s2") || !!(await chat.agent.conversation.commit(tx => tx.submissionByRequest(chat.agent.conversation.id, "s2"), BACKGROUND_CONTEXT)), "steered");
  release();
  await settled(chat, before + 2);
  const steered = requests[before + 1]!;
  assert.ok(steered.some(message => message.role === "toolResult"), "the same turn, after the tool's result");
  assert.deepEqual(imagesOf(steered).map(part => part.type === "image" && part.data), [webp(9, 9).toString("base64")], "the steered image reaches the model in that turn");
  console.log("ok: an image steered into a tool round reaches the model");

  const reopened = await transcript(chat);
  assert.deepEqual(reopened.events.filter(event => event.type === "user-message" && event.images).map(event => event.type === "user-message" && event.images!.length), [1, 2, 4, 4, 1, 1]);
  assert.deepEqual((await chat.image(third.id))?.bytes, webp(9, 9));
  console.log("ok: unsent uploads are swept; images show again after a reopen");
} finally { await chat.close(); }

// cubed's routes: raw image bytes up; served inert, same-origin, by id.
const state = path.join(root, "state");
const app = await createCubed({ state, models, claude: null, gateway: null });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/optchat`;
try {
  const upload = (body: Buffer, type = "image/png", headers: Record<string, string> = {}) => fetch(`${base}/media`, { method: "POST", headers: { "content-type": type, ...headers }, body: new Uint8Array(body) });
  const model = await (await fetch(`${base}/model`)).json() as { images: unknown };
  assert.deepEqual(model.images, { supported: true, reason: null });
  assert.equal((await upload(png(2, 2), "text/plain")).status, 415, "not an image body");
  assert.equal((await upload(Buffer.from("<svg/>"), "image/svg+xml")).status, 415);
  const big = await upload(Buffer.alloc(MEDIA_LIMITS.bytes + 1));
  assert.equal(big.status, 413);
  assert.match((await big.json() as { error: string }).error, /at most 3\.8 MB/);
  assert.equal((await upload(png(2, 2), "image/png", { origin: "http://elsewhere.example" })).status, 403);
  const accepted = await upload(png(5, 5, 77));
  assert.equal(accepted.status, 200);
  const { image } = await accepted.json() as { image: { id: string; mimeType: string; width: number } };
  assert.equal(image.width, 5);
  assert.equal((await fetch(`${base}/media/${image.id}`)).status, 404, "not served before a message holds it");
  const post = (body: unknown) => fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ requestId: "h0", text: "x", images: ["../../pi.sqlite"] })).status, 400);
  assert.equal((await post({ requestId: "h1", images: [image.id] })).status, 200, "images need no text");
  const served = await fetch(`${base}/media/${image.id}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(5, 5, 77));
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(served.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(served.headers.get("content-security-policy") ?? "", /default-src 'none'; sandbox/);
  for (const id of ["..%2Fpi.sqlite", "%2e%2e", "0".repeat(64)]) assert.equal((await fetch(`${base}/media/${id}`)).status, 404);
  // A body without a length is cut off at the limit, not read on.
  const chunked = await new Promise<number>(resolve => {
    const request = http.request(`${base}/media`, { method: "POST", headers: { "content-type": "image/png" } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on("error", () => resolve(0));
    const chunk = Buffer.alloc(256 * 1024);
    let written = 0;
    const pump = () => { while (written < 2 * MEDIA_LIMITS.bytes) { written += chunk.length; if (!request.write(chunk)) return void request.once("drain", pump); } request.end(); };
    pump();
  });
  assert.ok(chunked === 413 || chunked === 0, `a chunked upload over the limit is refused (${chunked})`);
  const history = await (await fetch(`${base}/history`)).json() as { events: Array<{ type: string; images?: unknown[] }> };
  assert.equal(history.events.find(event => event.type === "user-message")?.images?.length, 1);
  console.log("ok: routes take raw image bytes within bounds, refuse other origins and types, and serve a message's image inert by id");
} finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
