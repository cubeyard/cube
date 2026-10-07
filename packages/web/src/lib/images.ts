/** Images pasted or picked into the chat's composer. The host checks every
 * upload again (format by its own header, size, sides); these bounds only
 * spare a doomed upload and shrink a large screenshot before it leaves. */
import { MEDIA_LIMITS, MEDIA_TYPES } from "../../../server/src/optchat-media-limits.ts";

export { MEDIA_LIMITS };
export const ACCEPT = MEDIA_TYPES.join(",");
/** A shrunk image's longest side: what vision models read at full detail. */
const SHRUNK_SIDE = 2048;

/** The image files a paste carries, or none when it carries text: a paste of
 * text (with or without a picture of it, as office apps put on the
 * clipboard) stays an ordinary text paste. */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data || data.getData("text/plain")) return [];
  return [...data.files].filter(file => file.type.startsWith("image/"));
}

/** A file as the host takes it: a supported type, at most the bounds; a
 * larger one is drawn again smaller (`shrink`, browser only). */
export async function prepareImage(file: Blob, shrink: (file: Blob) => Promise<Blob> = shrinkImage): Promise<Blob> {
  if (!(MEDIA_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(file.type === "image/svg+xml" ? "svg images cannot be attached" : "only png, jpeg, gif and webp images can be attached");
  }
  if (file.size <= MEDIA_LIMITS.bytes) return file;
  const smaller = await shrink(file);
  if (smaller.size > MEDIA_LIMITS.bytes) throw new Error(`the image is ${megabytes(file.size)}, too large even shrunk; at most ${megabytes(MEDIA_LIMITS.bytes)}`);
  return smaller;
}

/** Draws an image at most SHRUNK_SIDE a side, as png, or jpeg when png is still too large. */
async function shrinkImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("the image could not be read"); });
  try {
    const scale = Math.min(1, SHRUNK_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("the image could not be shrunk")), type, quality));
    const png = await encode("image/png");
    return png.size <= MEDIA_LIMITS.bytes ? png : await encode("image/jpeg", 0.85);
  } finally { bitmap.close(); }
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
