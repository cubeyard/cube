/** Images the user attaches to OptChat messages. The bytes live in a
 * content-addressed store beside the chat's Pi store
 * (`<CUBED_STATE>/optchat/media/<sha256>`); a message holds only a reference
 * (`cube-media:<sha256>`) in a Pi image part, and the chat's request hook
 * puts the bytes in for the model. So the log, the view, the compactor and
 * every transcript read stay free of base64, and an image reaches the model
 * only in the turn whose messages carry it. See docs/optchat.md, "Images".
 *
 * Only PNG, JPEG, GIF and WebP are taken, recognized by their own headers
 * (never by a name or a declared type), so nothing the browser would run
 * (HTML, SVG) is ever stored or served. */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MEDIA_LIMITS, type MediaRef, type MediaType } from "./optchat-media-limits.ts";

export { MEDIA_LIMITS, MEDIA_TYPES, type MediaRef, type MediaType } from "./optchat-media-limits.ts";
/** An upload no message references is deleted after this long. */
export const UNSENT_MS = 24 * 60 * 60_000;

const PREFIX = "cube-media:";
const ID = /^[0-9a-f]{64}$/;
export const isMediaId = (id: unknown): id is string => typeof id === "string" && ID.test(id);
/** The data of a Pi image part that refers to the store. */
export const mediaData = (id: string) => `${PREFIX}${id}`;
/** The store id a Pi image part refers to, if it is a reference. */
export const mediaId = (data: string): string | null => data.startsWith(PREFIX) && isMediaId(data.slice(PREFIX.length)) ? data.slice(PREFIX.length) : null;

/** A refusal the browser shows as it is: an upload or a message that breaks a bound. */
export class MediaError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** The format and size an image's own header gives, or why it is refused. */
export function sniffImage(bytes: Uint8Array): { mimeType: MediaType; width: number; height: number } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => { throw new MediaError(why, 415); };
  let mimeType: MediaType, width = 0, height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString("latin1", 12, 16) === "IHDR") {
    mimeType = "image/png"; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    mimeType = "image/jpeg";
    // The first start-of-frame marker holds the size.
    for (let k = 2; k + 9 < b.length;) {
      if (b[k] !== 0xff) fail("not a readable jpeg image");
      const marker = b[k + 1]!;
      if (marker === 0xff) { k++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { k += 2; continue; }
      const length = b.readUInt16BE(k + 2);
      if (length < 2) fail("not a readable jpeg image");
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = b.readUInt16BE(k + 5); width = b.readUInt16BE(k + 7);
        break;
      }
      k += 2 + length;
    }
  } else if (b.length >= 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) {
    mimeType = "image/gif"; width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    mimeType = "image/webp";
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) { width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff; }
    else if (chunk === "VP8L" && b[20] === 0x2f) { const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1; }
    else if (chunk === "VP8X") { width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1; }
  } else return fail("only png, jpeg, gif and webp images can be attached");
  if (!width || !height) fail(`not a readable ${mimeType.slice(6)} image`);
  if (width > MEDIA_LIMITS.side || height > MEDIA_LIMITS.side) fail(`the image is ${width}×${height}; at most ${MEDIA_LIMITS.side} pixels a side`);
  return { mimeType, width, height };
}

/** The chat's image store: written once per content, read by id only. */
export class MediaStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /** Checks and stores an upload; the same bytes get the same id. */
  put(bytes: Uint8Array): MediaRef & { width: number; height: number; bytes: number } {
    if (!bytes.byteLength) throw new MediaError("the image is empty");
    if (bytes.byteLength > MEDIA_LIMITS.bytes) throw new MediaError(`the image is ${megabytes(bytes.byteLength)}; at most ${megabytes(MEDIA_LIMITS.bytes)}`, 413);
    const image = sniffImage(bytes);
    const id = createHash("sha256").update(bytes).digest("hex");
    const file = this.file(id);
    if (fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date());
    else {
      // Whole or not at all: a reader never sees half an image.
      const temporary = path.join(this.directory, `.${id}.${randomBytes(6).toString("hex")}.tmp`);
      fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    }
    return { id, mimeType: image.mimeType, width: image.width, height: image.height, bytes: bytes.byteLength };
  }

  /** A stored image, checked again; null when there is none. */
  get(id: string): { bytes: Buffer; mimeType: MediaType } | null {
    if (!isMediaId(id)) return null;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.file(id)); } catch { return null; }
    if (bytes.byteLength > MEDIA_LIMITS.bytes) return null;
    try { return { bytes, mimeType: sniffImage(bytes).mimeType }; } catch { return null; }
  }

  has(id: string): boolean { return isMediaId(id) && fs.existsSync(this.file(id)); }

  /** Stored ids, oldest first, with when each was last stored. */
  list(): Array<{ id: string; at: number }> {
    const out: Array<{ id: string; at: number }> = [];
    for (const name of fs.readdirSync(this.directory)) {
      if (!isMediaId(name)) continue;
      try { out.push({ id: name, at: fs.statSync(this.file(name)).mtimeMs }); } catch { /* removed meanwhile */ }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Deletes uploads that no message references and that are older than
   * `before`, and temporary files a crash left. Returns how many went. */
  sweep(referenced: ReadonlySet<string>, before: number): number {
    let removed = 0;
    for (const name of fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      const stored = ID.test(name);
      if (stored ? referenced.has(name) : !name.endsWith(".tmp")) continue;
      try {
        if (fs.statSync(file).mtimeMs >= before) continue;
        fs.rmSync(file, { force: true });
        removed++;
      } catch { /* removed meanwhile */ }
    }
    return removed;
  }

  private file(id: string): string { return path.join(this.directory, id); }
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
