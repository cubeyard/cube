/** Mermaid diagrams in artifacts and the chat, drawn by Pele
 * (https://pele.run): a local library, loaded only when a page has a
 * diagram (and each diagram type's code only when one is drawn), so a
 * diagram's source never leaves the browser. Each one is shown
 * as an <img> of the SVG: an image document runs no script, loads nothing
 * and has no links, whatever the source says; Pele also draws with links and
 * images off and labels as text. The picture takes its colours from the
 * page's tokens around the figure, written into the SVG (an image does not
 * inherit the page's CSS), and draws in a system font, the one the image
 * can use and the one its labels are measured in.
 *
 * Renderers emit `diagramFigure` placeholders (the source folded under
 * them); `drawDiagrams` fills them in. A drawing is kept by its source,
 * theme and place, so the chat, which renders a message again at every
 * streamed frame, shows a drawn diagram at once instead of drawing it again. */
import { escapeHtml } from "./markdown.ts";

/** The longest source drawn and the most flowchart edges, as cubed checks an artifact (artifact-diagrams.ts). */
export const DIAGRAM_CHARS = 20_000;
export const DIAGRAM_EDGES = 500;

/** Where a figure is drawn: its colours come from the tokens there. */
export type DiagramPlace = "artifact" | "chat";
type Drawn = { url: string; width: number } | { error: string };

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const KEPT = 64;
const drawings = new Map<string, Drawn>();
const drawing = new Map<string, Promise<Drawn>>();
let pele: Promise<typeof import("pele/lazy")> | null = null;
let serial = 0;

const dark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
const keyOf = (place: DiagramPlace, source: string) => `${place}|${dark() ? "dark" : "light"}|${source}`;

/** A figure for one ```mermaid fence: its drawing when one is kept, else a
 * note until `drawDiagrams` draws it. `complete: false` is a fence still
 * being streamed: its source is shown as it grows, drawn once it closes. */
export function diagramFigure(source: string, place: DiagramPlace, index: number, options: { complete?: boolean } = {}): string {
  const folded = `<details class="diagram-source"><summary>diagram source</summary><pre><code>${escapeHtml(source)}</code></pre></details>`;
  if (options.complete === false) {
    return `<figure class="diagram-figure" data-anchor-skip><div class="diagram-picture"><p class="diagram-note">diagram drawn when its block is complete</p></div>`
      + `<pre class="diagram-growing"><code>${escapeHtml(source)}</code></pre></figure>\n`;
  }
  const attributes = `class="diagram-figure" data-anchor-skip data-diagram="${index}" data-diagram-place="${place}"`;
  if (source.length > DIAGRAM_CHARS) {
    return `<figure ${attributes}><div class="diagram-picture"><p class="diagram-note bad">diagram too large to draw (${source.length} characters; at most ${DIAGRAM_CHARS})</p></div>`
      + folded.replace("<details", "<details open") + `</figure>\n`;
  }
  const kept = drawings.get(keyOf(place, source));
  if (kept) return `<figure ${attributes}><div class="diagram-picture">${pictureHtml(kept, index)}</div>${"error" in kept ? folded.replace("<details", "<details open") : folded}</figure>\n`;
  return `<figure ${attributes}><div class="diagram-picture" aria-busy="true"><p class="diagram-note">drawing diagram…</p></div>${folded}</figure>\n`;
}

function pictureHtml(drawn: Drawn, index: number): string {
  if ("error" in drawn) return `<p class="diagram-note bad">${escapeHtml(drawn.error)}</p>`;
  const width = drawn.width ? ` style="max-width: min(100%, ${Math.ceil(drawn.width)}px)"` : "";
  return `<img src="${escapeHtml(drawn.url)}" alt="diagram ${index + 1}; its source is below"${width}>`;
}

/** Draws every figure under `root` that waits for its drawing, one at a
 * time; a figure the page replaced meanwhile gets the kept drawing. */
export async function drawDiagrams(root: HTMLElement | null | undefined): Promise<void> {
  for (;;) {
    const figure = root?.querySelector<HTMLElement>("figure[data-diagram] > .diagram-picture[aria-busy]")?.parentElement;
    if (!figure || !root) return;
    const place = figure.dataset.diagramPlace === "chat" ? "chat" : "artifact";
    const source = figure.querySelector(".diagram-source code")?.textContent ?? "";
    const key = keyOf(place, source);
    let pending = drawing.get(key);
    if (!pending) {
      pending = drawings.has(key) ? Promise.resolve(drawings.get(key)!) : draw(source, figure);
      drawing.set(key, pending);
    }
    const drawn = await pending;
    drawing.delete(key);
    keep(key, drawn);
    // Every figure of this source waiting here now, the one asked for or the page's newer copy of it.
    for (const waiting of root.querySelectorAll<HTMLElement>("figure[data-diagram] > .diagram-picture[aria-busy]")) {
      const owner = waiting.parentElement!;
      if (keyOf(owner.dataset.diagramPlace === "chat" ? "chat" : "artifact", owner.querySelector(".diagram-source code")?.textContent ?? "") !== key) continue;
      fill(owner, waiting, drawn);
    }
    // A figure that was not filled (it left the page) is not asked again.
    if (figure.isConnected && figure.querySelector(".diagram-picture[aria-busy]")) return;
  }
}

function fill(figure: HTMLElement, picture: HTMLElement, drawn: Drawn): void {
  picture.removeAttribute("aria-busy");
  if ("error" in drawn) {
    const note = document.createElement("p");
    note.className = "diagram-note bad";
    note.textContent = drawn.error;
    picture.replaceChildren(note);
    figure.querySelector("details.diagram-source")?.setAttribute("open", "");
  } else {
    // An image of the SVG: nothing in it runs, loads or links.
    const image = document.createElement("img");
    image.src = drawn.url;
    image.alt = `diagram ${Number(figure.dataset.diagram) + 1}; its source is below`;
    if (drawn.width) image.style.maxWidth = `min(100%, ${Math.ceil(drawn.width)}px)`;
    picture.replaceChildren(image);
  }
}

function keep(key: string, drawn: Drawn): void {
  drawings.delete(key);
  drawings.set(key, drawn);
  if (drawings.size > KEPT) drawings.delete(drawings.keys().next().value!);
}

/** The page's tokens Pele's variables take, read where the figure is. */
const TOKENS: [pele: string, page: string][] = [
  ["--pele-bg", "--s3"], ["--pele-fg", "--ink"], ["--pele-muted", "--ink-3"], ["--pele-line", "--ink-2"],
  ["--pele-surface", "--s4"], ["--pele-surface-alt", "--s1"], ["--pele-border", "--line-2"],
  ["--pele-accent", "--signal"], ["--pele-critical", "--bad"], ["--pele-error", "--bad"],
];

function theme(figure: HTMLElement): string {
  const style = getComputedStyle(figure);
  const values = TOKENS.map(([name, token]) => [name, style.getPropertyValue(token).trim()] as const)
    // Colours only: a token is the page's own, but nothing else reaches the style sheet.
    .filter(([, value]) => /^[#\w\s(),.%-]{1,64}$/.test(value));
  return `.pele{${values.map(([name, value]) => `${name}:${value}`).join(";")};--pele-font:${FONT};--pele-radius:4px}`;
}

async function draw(source: string, figure: HTMLElement): Promise<Drawn> {
  if (source.length > DIAGRAM_CHARS) return { error: `diagram too large to draw (at most ${DIAGRAM_CHARS} characters)` };
  try {
    pele ??= import("pele/lazy");
    const { renderAsync, PeleError } = await pele;
    try {
      const width = figure.querySelector<HTMLElement>(".diagram-picture")?.clientWidth ?? 0;
      // `pele/lazy` loads each diagram type's code the first time one is drawn.
      const { svg, width: natural } = await renderAsync(source, {
        limit: DIAGRAM_CHARS, maxEdges: DIAGRAM_EDGES, links: false, images: false, fontFamily: FONT,
        idPrefix: `diagram-${++serial}`, ...width > 0 ? { maxWidth: width } : {},
      });
      // The theme goes in as the root's first child; the root tag's attributes are Pele's escaped ones.
      const themed = svg.replace(/^<svg\b[^>]*>/, open => `${open}<style>${theme(figure)}</style>`);
      return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`, width: natural };
    } catch (error) {
      if (!(error instanceof PeleError)) throw error;
      const where = error.line > 0 ? ` (line ${error.line}${error.column > 0 ? `, column ${error.column}` : ""})` : "";
      return { error: `diagram could not be drawn${where}: ${firstLine(error.message, error.snippet)}` };
    }
  } catch (error) {
    pele = null;
    return { error: `diagram could not be drawn: ${firstLine(error instanceof Error ? error.message : String(error), "")}` };
  }
}

/** Pele's message without the source lines it repeats, cut short. */
function firstLine(message: string, snippet: string): string {
  const marked = snippet.split("\n");
  return message.split("\n").filter(line => line.trim() && !marked.includes(line)).map(line => line.trim()).join(" ").slice(0, 240);
}
