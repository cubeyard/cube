/** What the reader sees of a conversation, recorded at every painted frame
 * after a DOM change (a MutationObserver marks the change, the next
 * animation frame reads it: the state the browser paints, not the steps of
 * one update), and the invariants a send must keep across the whole record. */
import assert from "node:assert/strict";
import type { Page } from "playwright";

export type Seen = {
  at: number;
  /** The user's messages in the transcript, in order; `…` marks one still sending. */
  users: string[];
  /** Agent rows' text, in order. */
  agent: string[];
  draft: string;
  /** The chat lamp or the composer says a run is on. */
  busy: boolean;
  working: boolean;
  error: string | null;
  reconnecting: boolean;
  /** Pixels between the transcript's end and its view. */
  gap: number;
  mark?: string;
};

/** Runs in the page before the app: records a `Seen` whenever it changes. */
function install(): void {
  const w = window as unknown as { __seen: Seen[]; __mark: (mark: string) => void };
  w.__seen = [];
  let last = "";
  const record = (mark?: string) => {
    const transcript = document.querySelector(".transcript");
    const users = [...document.querySelectorAll(".transcript .conversation-message.user")]
      .map(article => `${article.classList.contains("sending") ? "…" : ""}${article.querySelector(".message-copy")?.textContent ?? ""}`);
    const agent = [...document.querySelectorAll(".transcript .conversation-message.assistant .message-copy, .transcript .tool-strip summary")]
      .map(node => (node.textContent ?? "").trim());
    const seen: Seen = {
      at: Math.round(performance.now()),
      users, agent,
      draft: (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.value ?? "",
      busy: document.querySelector(".composer")?.getAttribute("aria-busy") === "true",
      working: !!document.querySelector(".transcript .working-line"),
      error: document.querySelector(".conversation-error")?.textContent ?? null,
      reconnecting: !!document.querySelector(".conversation-note"),
      gap: transcript ? Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) : 0,
      ...mark ? { mark } : {},
    };
    const key = JSON.stringify({ ...seen, at: 0, gap: 0, mark: undefined });
    if (key === last && !mark) return;
    last = key;
    w.__seen.push(seen);
  };
  let scheduled = false;
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; record(); });
  };
  w.__mark = mark => record(mark);
  // Text typed into a field changes no DOM node; input events count too.
  document.addEventListener("input", changed, true);
  new MutationObserver(changed).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

export async function monitor(page: Page): Promise<{ mark(label: string): Promise<void>; since(label: string): Promise<Seen[]> }> {
  await page.addInitScript(install);
  return {
    async mark(label) { await page.evaluate(mark => (window as unknown as { __mark: (mark: string) => void }).__mark(mark), label); },
    async since(label) {
      const all = await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);
      const start = all.findIndex(seen => seen.mark === label);
      assert.ok(start >= 0, `mark ${label} recorded`);
      return all.slice(start);
    },
  };
}

const copies = (seen: Seen, text: string) => seen.users.filter(user => user.replace(/^…/, "") === text).length;

/** A send, from the Enter key on: the message is in the field or the
 * transcript in every state the reader could see; in the transcript from the
 * first state after the key, and never twice; once there, it stays. The chat
 * reads busy from the send until it settles, and turns idle once. */
export function assertSend(record: Seen[], text: string, options: { settled?: boolean } = {}): void {
  const after = record.slice(1);
  assert.ok(after.length > 0, "the send changed what the reader sees");
  const describe = (seen: Seen) => JSON.stringify(seen);
  assert.equal(copies(after[0]!, text), 1, `the message shows at once: ${describe(after[0]!)}`);
  for (const seen of after) {
    assert.equal(copies(seen, text), 1, `the message shows once, and stays: ${describe(seen)}`);
  }
  const firstBusy = after.findIndex(seen => seen.busy);
  assert.equal(firstBusy, 0, `busy at once: ${describe(after[0]!)}`);
  const idle = after.findIndex(seen => !seen.busy);
  if (idle >= 0) {
    assert.ok(after.slice(idle).every(seen => !seen.busy), `no busy, idle, busy flicker: ${after.slice(idle).map(describe).join("\n")}`);
  }
  if (options.settled !== false) {
    const end = after.at(-1)!;
    assert.equal(end.busy, false, `settled: ${describe(end)}`);
    assert.ok(!end.users.some(user => user.startsWith("…")), `no message left sending: ${describe(end)}`);
  }
}

/** A state after which the record must hold `check`, for every state. */
export function assertAlways(record: Seen[], check: (seen: Seen) => boolean, what: string): void {
  const bad = record.find(seen => !check(seen));
  assert.ok(!bad, `${what}: ${JSON.stringify(bad)}`);
}
