/** OptChat's memory: the log of messages, the binary tree of one-line
 * summaries over it and the view that tiles the whole chat under a byte
 * budget. Pure and synchronous; the service persists messages (as Pi
 * entries) and nodes, and the compactor builds nodes. See docs/optchat.md. */

export const NODE = 512;
export const VIEW = 128_000;
export const CAP = 30_000;

export type MessageKind = "user" | "talk" | "tool" | "echo" | "note";
export type LogMessage = { kind: MessageKind; text: string; date: number };
/** A view part: tree node `(l, i)`, covering messages `[i·2^l, (i+1)·2^l)`. */
export type Part = { l: number; i: number };

export const PLACEHOLDER = "(not summarized yet: zoom it)";

const encoder = new TextEncoder();
export const bytes = (text: string) => encoder.encode(text).length;
const flat = (text: string) => text.replace(/\s*\n\s*/g, " ");
const key = (l: number, i: number) => `${l}:${i}`;
export const start = (part: Part) => part.i * 2 ** part.l;
export const end = (part: Part) => (part.i + 1) * 2 ** part.l;

/** The text of one message as the tree sees it. */
export const messageLine = (message: LogMessage) => `${message.kind}: ${message.text}`;

/** A long tool result keeps its head and tail, with a note of what was cut. */
export function capText(text: string, cap = CAP): string {
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 64) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

/** The first `limit` bytes of `text`, without splitting a character. */
export function cutBytes(text: string, limit: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= limit) return text;
  return new TextDecoder().decode(encoded.subarray(0, limit)).replace(/�$/, "");
}

export type Job = { l: number; i: number };

export class Memory {
  readonly messages: LogMessage[] = [];
  readonly view: Part[] = [];
  private readonly nodes = new Map<string, string>();
  /** Per level, the lowest index that may still be unbuilt. */
  private readonly low: number[] = [];
  private size = 0;
  private readonly budget: number;
  private readonly limit: number;
  /** Called after every fit, so waiters can check `settled()`. */
  onChange: () => void = () => {};
  constructor(options: { view?: number; node?: number } = {}) {
    this.budget = options.view ?? VIEW;
    this.limit = options.node ?? NODE;
  }

  get length(): number { return this.messages.length; }
  get nodeLimit(): number { return this.limit; }
  built(l: number, i: number): boolean { return this.nodes.has(key(l, i)); }
  node(l: number, i: number): string | undefined { return this.nodes.get(key(l, i)); }
  private partText(part: Part): string { return this.node(part.l, part.i) ?? PLACEHOLDER; }

  /** A new message: appended to the log and to the view as its own line. */
  append(message: LogMessage): void {
    this.messages.push(message);
    const part = { l: 0, i: this.messages.length - 1 };
    this.view.push(part);
    this.size += bytes(this.partText(part));
    this.fit();
  }

  /** Restores a stored view over the first messages of the log, so a reopen
   * goes on from the view it had instead of folding a different one. Refused
   * (false) unless the parts are built and tile exactly those messages. */
  restore(messages: readonly LogMessage[], parts: readonly Part[]): boolean {
    if (this.messages.length) return false;
    let at = 0;
    for (const part of parts) {
      if (start(part) !== at || !this.built(part.l, part.i)) return false;
      at = end(part);
    }
    if (at !== messages.length) return false;
    this.messages.push(...messages);
    this.view.push(...parts.map(part => ({ ...part })));
    this.size = parts.reduce((sum, part) => sum + bytes(this.partText(part)), 0);
    this.fit();
    return true;
  }

  /** A built node. Nodes are immutable: a second build of the same node is ignored. */
  setNode(l: number, i: number, text: string): void {
    if (this.built(l, i)) return;
    this.nodes.set(key(l, i), text);
    for (const part of this.view) {
      if (part.l === l && part.i === i) this.size += bytes(text) - bytes(PLACEHOLDER);
    }
    this.fit();
  }

  /** Merges the most due pair until the view fits its budget, or no parent is built. */
  private fit(): void {
    const total = this.messages.length;
    while (this.size > this.budget) {
      let best = -1, due = -Infinity;
      for (let k = 0; k + 1 < this.view.length; k++) {
        const a = this.view[k]!, b = this.view[k + 1]!;
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !this.built(a.l + 1, a.i / 2)) continue;
        const weight = (total - start(a)) / 2 ** (a.l + 2);
        if (weight > due) { due = weight; best = k; }
      }
      if (best < 0) break;
      const a = this.view[best]!, b = this.view[best + 1]!;
      const parent = { l: a.l + 1, i: a.i / 2 };
      this.size += bytes(this.partText(parent)) - bytes(this.partText(a)) - bytes(this.partText(b));
      this.view.splice(best, 2, parent);
    }
    this.onChange();
  }

  /** Every line of the view is a summary: a turn may start. */
  settled(): boolean { return this.view.every(part => this.built(part.l, part.i)); }

  /** The first message whose view line is not built yet. */
  private first(): number {
    for (const part of this.view) if (!this.built(part.l, part.i)) return start(part);
    return this.messages.length;
  }

  /** Nodes that may be built now, in order: their sources exist and every
   * view line before their end is a summary, so the compactor never sees a
   * placeholder. Messages are compressed one at a time, in order. */
  ready(busy: ReadonlySet<string>, limit: number): Job[] {
    const jobs: Job[] = [];
    const total = this.messages.length, first = this.first();
    for (let l = 0; 2 ** l <= total; l++) {
      while ((this.low[l] ?? 0) * 2 ** l < total && this.built(l, this.low[l] ?? 0)) this.low[l] = (this.low[l] ?? 0) + 1;
      for (let i = this.low[l] ?? 0; (i + 1) * 2 ** l <= total; i++) {
        if (jobs.length + busy.size >= limit) return jobs;
        const last = l === 0 ? i : (i + 1) * 2 ** l;
        if (last > first) break;
        if (this.built(l, i) || busy.has(key(l, i))) continue;
        if (l > 0 && !(this.built(l - 1, 2 * i) && this.built(l - 1, 2 * i + 1))) continue;
        jobs.push({ l, i });
      }
    }
    return jobs;
  }

  /** What building node `(l, i)` takes: the free text, when the source
   * already fits, or the source the compactor shrinks. */
  source(l: number, i: number): { free: string } | { message: string } | { merge: [string, string] } {
    if (l === 0) {
      const line = messageLine(this.messages[i]!);
      return bytes(line) <= this.limit ? { free: line } : { message: line };
    }
    const a = this.node(l - 1, 2 * i)!, b = this.node(l - 1, 2 * i + 1)!;
    const joined = `${a}\n${b}`;
    return bytes(joined) <= this.limit ? { free: joined } : { merge: [flat(a), flat(b)] };
  }

  /** The compactor's context for node `(l, i)`: the bare text of the view
   * lines before it (level 0) or up to its last message (a merge). No ids. */
  context(l: number, i: number): string[] {
    const limit = l === 0 ? i : end({ l, i });
    return this.view.filter(part => end(part) <= limit).map(part => flat(this.partText(part)));
  }

  /** The view as every call sees it. `parts` defaults to the current view. */
  render(parts: readonly Part[] = this.view): string {
    const lines = parts.map(part => `${start(part)}+${2 ** part.l}|${flat(this.partText(part))}`);
    return `<chat>\n${lines.join("\n")}${lines.length ? "\n" : ""}</chat>`;
  }

  /** The `zoom` tool: a line opened into its two halves; n = 1 the whole message. */
  zoom(id: number, n: number): string {
    const total = this.messages.length;
    const valid = Number.isSafeInteger(id) && Number.isSafeInteger(n) && id >= 0 && n >= 1 && (n & (n - 1)) === 0 && id % n === 0 && id + n <= total;
    if (!valid) return `No line ${id}+${n}.`;
    if (n === 1) return `${id}+0|${messageLine(this.messages[id]!)}`;
    const l = Math.log2(n) - 1, i = (2 * id) / n;
    return [{ l, i }, { l, i: i + 1 }].map(part => `${start(part)}+${2 ** part.l}|${flat(this.partText(part))}`).join("\n");
  }
}
