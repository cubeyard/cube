/** The composer's image intake: a paste of image files alone attaches them,
 * any paste with text stays a text paste; types and sizes are checked before
 * an upload and a large image is shrunk. */
import assert from "node:assert/strict";
import { MEDIA_LIMITS, pastedImages, prepareImage } from "../src/lib/images.ts";
import { transcriptRows } from "../src/lib/transcript.ts";

const file = (type: string, size = 10) => new File([new Uint8Array(size)], "x", { type });
const clipboard = (files: File[], text = "") => ({ files, getData: (type: string) => type === "text/plain" ? text : "" }) as unknown as DataTransfer;

const screenshot = file("image/png");
assert.deepEqual(pastedImages(clipboard([screenshot])), [screenshot], "a screenshot attaches");
assert.deepEqual(pastedImages(clipboard([screenshot], "a table cell")), [], "text with a picture of it pastes as text");
assert.deepEqual(pastedImages(clipboard([file("text/plain")])), [], "a pasted file that is not an image is left to the field");
assert.deepEqual(pastedImages(null), []);

assert.equal(await prepareImage(screenshot), screenshot, "a small image goes as it is");
await assert.rejects(prepareImage(file("image/svg+xml")), /svg images cannot be attached/);
await assert.rejects(prepareImage(file("image/bmp")), /only png, jpeg, gif and webp/);
const large = file("image/jpeg", MEDIA_LIMITS.bytes + 1);
const smaller = file("image/jpeg", 1000);
assert.equal(await prepareImage(large, async () => smaller), smaller, "a large image is shrunk");
await assert.rejects(prepareImage(large, async () => large), /too large even shrunk/);

const rows = transcriptRows({ status: { state: "completed", run: null, error: null }, events: [
  { type: "user-message", id: "1", text: "", images: [{ id: "a".repeat(64), mimeType: "image/png" }] },
  { type: "user-message", id: "2", text: "plain" },
] });
assert.deepEqual(rows, [
  { kind: "user", id: "1", text: "", images: [{ id: "a".repeat(64), mimeType: "image/png" }] },
  { kind: "user", id: "2", text: "plain" },
], "a message's images reach its row");
console.log("ok: image pastes, type and size checks, shrinking and transcript rows with images");
