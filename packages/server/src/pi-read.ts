/** Image-aware Pi read, retaining upstream's path resolution and text paging.
 * No host files: bytes come only from the invocation's WorkspaceEnv. */
import { crc32 } from "node:zlib";
import type { ImageContent, Models } from "@earendil-works/pi-ai";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { sniffImage } from "./optchat-media.ts";

/** Conservative unresized provider limits; WorkspaceEnv also caps bytes at 2 MiB. */
export const PI_IMAGE_SIDE = 2000;
export function checkedPiImage(bytes: Uint8Array): ImageContent {
  if (bytes.length > 2 * 1024 * 1024) throw new Error("image exceeds 2 MiB; resize it with bash and read the smaller copy");
  const b = Buffer.from(bytes);
  let info: ReturnType<typeof sniffImage>;
  try { info = sniffImage(b); }
  catch (error) {
    // The shared sniffer also serves chat uploads; Read is not an upload.
    throw new Error(`cannot read image: ${error instanceof Error ? error.message.replace("can be attached", "are supported") : String(error)}`);
  }
  const { mimeType, width, height } = info;
  if (width > PI_IMAGE_SIDE || height > PI_IMAGE_SIDE) throw new Error(`image is ${width}×${height}; resize to at most ${PI_IMAGE_SIDE} pixels a side with bash`);
  const whole = mimeType === "image/png" ? b.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
    : mimeType === "image/jpeg" ? b.subarray(-2).equals(Buffer.from([0xff, 0xd9]))
    : mimeType === "image/gif" ? b.at(-1) === 0x3b
    : b.length >= 12 && b.readUInt32LE(4) + 8 === b.length;
  // Conservatively require a terminal marker/exact container length. Some
  // decoders accept trailing bytes; do not misreport those as truncation.
  if (!whole) throw new Error("image end marker or declared length does not match the file; it may be incomplete or contain trailing bytes — finish writing or re-encode it with bash before reading");
  if (mimeType === "image/png") {
    let data = false;
    let offset = 8;
    while (offset + 12 <= b.length) {
      const length = b.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > b.length || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new Error("malformed PNG chunk or checksum");
      const kind = b.toString("ascii", offset + 4, offset + 8);
      if (offset === 8 && (kind !== "IHDR" || length !== 13)) throw new Error("malformed PNG header");
      if (kind === "IDAT" && length) data = true;
      if (kind === "IEND" && (end !== b.length || length !== 0)) throw new Error("malformed PNG end");
      offset = end;
    }
    if (!data || offset !== b.length) throw new Error("malformed PNG data");
  } else if (mimeType === "image/jpeg") {
    let scan = false;
    for (let offset = 2; offset + 4 <= b.length;) {
      if (b[offset] !== 0xff) throw new Error("malformed JPEG marker");
      const marker = b[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      // TEM and restart markers stand alone; unlike other markers they have
      // no following segment length (the shared dimension sniffer agrees).
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = b.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > b.length) throw new Error("malformed JPEG segment");
      if (marker === 0xda) { scan = true; break; }
      offset += 2 + length;
    }
    if (!scan) throw new Error("malformed JPEG: no image scan");
  }
  return { type: "image", mimeType, data: b.toString("base64") };
}

class ImageRead {
  readonly content: ImageContent;
  constructor(content: ImageContent) { this.content = content; }
}

export function createPiReadTool(models: Models) {
  const upstream = createReadTool();
  return {
    ...upstream,
    replay: "safe" as const,
    description: upstream.description + " PNG, JPEG, GIF and WebP files are delivered as typed images to vision-capable models (at most 2 MiB and 2000 pixels per side). Image reads ignore line offset/limit. Text is detected from bytes, not extensions; non-UTF-8 or NUL-containing files are refused.",
    execute: (async (args, api, context) => {
      if (!api.env) throw new Error("read requires the thread workspace");
      const env = api.env;
      // Interpose only the binary read. Upstream still owns path variants, line
      // selection and diagnostics, and consumes exactly the bytes checked here.
      const wrapped: ExecutionEnv = new Proxy(env, {
        get(target, property) {
          if (property === "readBinaryFile") return async (file: string, readContext: typeof context) => {
            const result = await target.readBinaryFile(file, readContext);
            if (!result.ok) return result;
            const b = Buffer.from(result.value);
            const signature = b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || (b[0] === 0xff && b[1] === 0xd8)
              || ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6))
              || (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP");
            if (signature) {
              const image = checkedPiImage(b);
              const agent = await api.agent(context);
              const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
              if (!model) throw new Error("the selected model is unavailable in the model catalog; reconnect its provider or select an available vision-capable model and read again");
              if (!model.input.includes("image")) throw new Error("the selected model does not support image input; select a vision-capable model and read again");
              throw new ImageRead(image);
            } else {
              // Do not present arbitrary binary data as replacement-character text.
              try { new TextDecoder("utf-8", { fatal: true }).decode(b); }
              catch { throw new Error("not a supported image or UTF-8 text file; inspect it with bash"); }
              if (b.includes(0)) throw new Error("binary file is not a supported image; inspect it with bash");
            }
            return result;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try { return await upstream.execute(args, { ...api, env: wrapped }, context); }
      catch (result) {
        // Escape the text-only upstream tool before it can decode image bytes.
        // Only our private completion signal is caught; file errors propagate.
        if (result instanceof ImageRead) return { content: [result.content] };
        throw result;
      }
    }) satisfies typeof upstream.execute,
  };
}
