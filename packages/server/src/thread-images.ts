/** Images in a thread's transcript: what a tool returned (Claude Code's Read
 * of a screenshot) or a message carried. The bytes stay where the agent
 * stored them, in the thread's own store on the cubed host (`claude.sqlite`
 * or `pi.sqlite`), so they outlive the thread's machine and its disk. A
 * transcript event names each image by its place in that store, never by a
 * workspace path and never with its base64:
 *
 * - Claude Code: `m<seq>.<block>.<part>`, part `<part>` of the tool_result
 *   block `<block>` in stored message `<seq>`;
 * - Pi: `<entry>.<message>.<part>`, part `<part>` of message `<message>` in
 *   root conversation entry `<entry>`.
 *
 * Stored rows are only ever appended, so a reference always names the same
 * bytes. `readThreadImage` serves one: only from a row the transcript shows,
 * only an image whose own header is PNG, JPEG, GIF or WebP (the declared type
 * is not trusted), at most `THREAD_IMAGE_LIMITS.bytes`. Anything else is
 * absent, and the browser shows the image as unavailable. */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { MEDIA_TYPES, sniffImage, type MediaType } from "./optchat-media.ts";
import type { MessageImage } from "./thread-events.ts";

/** One image's bytes (above the Claude Code mod's 3,932,160 and every
 * provider's per-image limit), and the images one event names; the rest of
 * an event's images are counted in its text instead. */
export const THREAD_IMAGE_LIMITS = { bytes: 5 * 1024 * 1024, perEvent: 16 } as const;

/** Canonical numbers only, so one image has one reference. */
const N = "(0|[1-9]\\d{0,14})";
const CLAUDE_REF = new RegExp(`^m${N}\\.${N}\\.${N}$`);
const PI_REF = new RegExp(`^${N}\\.${N}\\.${N}$`);
/** Pi's root conversation and the entry kinds a thread shows (pi-thread-events.ts). */
const PI_ROOT = 1;
const PI_SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);
/** The longest base64 that can decode to at most the byte limit. */
const MAX_BASE64 = Math.ceil(THREAD_IMAGE_LIMITS.bytes / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const isThreadImageRef = (ref: unknown): ref is string => typeof ref === "string" && (CLAUDE_REF.test(ref) || PI_REF.test(ref));

/** The image an event shows for a stored image part, or null when the part
 * is not one cube serves (another type, no inline data). */
export function shownImage(ref: string, mimeType: unknown, data: unknown): MessageImage | null {
  if (typeof data !== "string" || !data || typeof mimeType !== "string" || !(MEDIA_TYPES as readonly string[]).includes(mimeType)) return null;
  return { id: ref, mimeType };
}

/** "[2 more images]": the images an event does not name, and the ones it cannot show. */
export function imageNote(count: number, more = false): string {
  return count ? `[${count}${more ? " more" : ""} ${count === 1 ? "image" : "images"}]` : "";
}

/** The bytes of a stored image part, checked, or null. `store` is the
 * thread's own store file; `agent` says which. */
export function readThreadImage(store: { agent: "pi" | "claude-code"; file: string }, ref: string): { bytes: Buffer; mimeType: MediaType } | null {
  const claude = store.agent === "claude-code" ? CLAUDE_REF.exec(ref) : null;
  const pi = store.agent === "pi" ? PI_REF.exec(ref) : null;
  if (!claude && !pi) return null;
  if (!fs.existsSync(store.file)) return null;
  let data: unknown;
  const db = new DatabaseSync(store.file, { readOnly: true, timeout: 5000 });
  try {
    if (claude) {
      const row = db.prepare("SELECT data FROM message WHERE seq = ?").get(Number(claude[1])) as { data: string } | undefined;
      data = row && claudePart(JSON.parse(row.data) as Record<string, unknown>, Number(claude[2]), Number(claude[3]));
    } else {
      const row = db.prepare("SELECT record FROM entries WHERE id = ? AND conversation_id = ?").get(Number(pi![1]), PI_ROOT) as { record: string } | undefined;
      data = row && piPart(JSON.parse(row.record) as EntryRecord, Number(pi![2]), Number(pi![3]));
    }
  } catch { return null; }
  finally { db.close(); }
  if (typeof data !== "string" || data.length > MAX_BASE64 || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.byteLength || bytes.byteLength > THREAD_IMAGE_LIMITS.bytes) return null;
  try { return { bytes, mimeType: sniffImage(bytes).mimeType }; } catch { return null; }
}

/** The base64 of a Claude Code tool result's image, in a main-thread user
 * message as claude-thread-events.ts shows it. */
function claudePart(data: Record<string, unknown>, blockIndex: number, partIndex: number): unknown {
  if (data.type !== "user" || data.parent_tool_use_id != null) return null;
  const blocks = (data.message as { content?: unknown } | undefined)?.content;
  const block = Array.isArray(blocks) ? blocks[blockIndex] as { type?: unknown; tool_use_id?: unknown; content?: unknown } | undefined : undefined;
  if (block?.type !== "tool_result" || !block.tool_use_id || !Array.isArray(block.content)) return null;
  const part = block.content[partIndex] as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | undefined;
  if (part?.type !== "image" || part.source?.type !== "base64") return null;
  return shownImage("", part.source.media_type, part.source.data) ? part.source.data : null;
}

/** The base64 of an inline image part of a shown Pi message. */
function piPart(entry: EntryRecord, messageIndex: number, partIndex: number): unknown {
  if (!PI_SHOWN.has(entry.kind)) return null;
  const message = entry.model?.[messageIndex];
  if (!message || (message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return null;
  const part = message.content[partIndex];
  if (part?.type !== "image") return null;
  return shownImage("", part.mimeType, part.data) ? part.data : null;
}
