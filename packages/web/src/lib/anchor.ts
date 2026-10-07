/** Comments anchor to a selection of one revision's rendered text: the
 * quote, a little text on each side, its offsets in that text and the
 * heading it falls under. On that revision the offsets find it again; on a
 * newer one the quote is looked for and placed only when one place fits
 * best, otherwise the comment shows as outdated, never on the wrong words. */
export interface Anchor { quote: string; prefix: string; suffix: string; start: number; end: number; section: string }
export type Placement = { state: "exact" | "moved"; start: number; end: number } | { state: "outdated" };

export const CONTEXT_CHARS = 64;
export const QUOTE_CHARS = 2000;

/** Where an anchor lands in `text`; `same`: the text is the revision the anchor was made on. */
export function placeAnchor(text: string, anchor: Anchor, same: boolean): Placement {
  if (same && text.slice(anchor.start, anchor.end) === anchor.quote) return { state: "exact", start: anchor.start, end: anchor.end };
  if (!anchor.quote) return { state: "outdated" };
  const found: Array<{ start: number; score: number }> = [];
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    found.push({ start: at, score: common(text.slice(Math.max(0, at - anchor.prefix.length), at), anchor.prefix, true)
      + common(text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length), anchor.suffix, false) });
  }
  if (!found.length) return { state: "outdated" };
  found.sort((a, b) => b.score - a.score);
  // Two places that fit equally well: neither is shown as the comment's.
  if (found.length > 1 && found[0]!.score === found[1]!.score) return { state: "outdated" };
  const best = found[0]!;
  return { state: same && best.start === anchor.start ? "exact" : "moved", start: best.start, end: best.start + anchor.quote.length };
}

/** Characters two strings share at their joining end. */
function common(found: string, wanted: string, before: boolean): number {
  let n = 0;
  while (n < found.length && n < wanted.length
    && (before ? found[found.length - 1 - n] === wanted[wanted.length - 1 - n] : found[n] === wanted[n])) n++;
  return n;
}

/** The document's text as the anchors count it: its text nodes in order,
 * leaving out diagrams (`data-anchor-skip`). */
export function textNodes(root: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number }> } {
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest("[data-anchor-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

/** The anchor of a selection inside `root`, or why there is none. */
export function selectionAnchor(root: HTMLElement, range: Range): Anchor | { error: string } {
  if (!root.contains(range.commonAncestorContainer)) return { error: "select text in the document" };
  const { text, nodes } = textNodes(root);
  const offset = (container: Node, at: number): number | null => {
    if (container.nodeType === Node.TEXT_NODE) {
      const entry = nodes.find(item => item.node === container);
      return entry ? entry.start + at : null;
    }
    // A boundary between elements: where the first text after it starts.
    const point = document.createRange();
    point.setStart(container, at);
    return nodes.find(entry => point.comparePoint(entry.node, 0) >= 0)?.start ?? text.length;
  };
  let start = offset(range.startContainer, range.startOffset);
  let end = offset(range.endContainer, range.endOffset);
  if (start === null || end === null) return { error: "a diagram cannot be commented on; select text around it" };
  // Leading and trailing white space is not part of what was meant.
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return { error: "select some text to comment on" };
  if (end - start > QUOTE_CHARS) return { error: `select at most ${QUOTE_CHARS} characters` };
  const first = nodes.findLast(entry => entry.start <= start)?.node;
  return {
    quote: text.slice(start, end), start, end,
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start), suffix: text.slice(end, end + CONTEXT_CHARS),
    section: first ? heading(root, first) : "",
  };
}

/** The text of the last heading before `node`. */
function heading(root: HTMLElement, node: Node): string {
  let found = "";
  for (const element of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || element.contains(node)) found = element.textContent?.trim().slice(0, 200) ?? "";
  }
  return found;
}

/** Marks [start, end) of the document's text, across element boundaries. */
export function mark(root: HTMLElement, start: number, end: number, attributes: Record<string, string>): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (const { node, start: at } of textNodes(root).nodes) {
    const from = Math.max(start, at), to = Math.min(end, at + node.data.length);
    if (from >= to) continue;
    const range = document.createRange();
    range.setStart(node, from - at);
    range.setEnd(node, to - at);
    const element = document.createElement("mark");
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    range.surroundContents(element);
    marks.push(element);
  }
  return marks;
}
