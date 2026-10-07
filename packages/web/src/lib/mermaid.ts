/** Mermaid diagrams of an artifact, drawn one at a time and shown as an
 * <img> of the SVG: an image document runs no script, loads nothing and has
 * no links, whatever the diagram source says. Mermaid itself also runs with
 * `securityLevel: "strict"` (labels are text, click handlers are off) and is
 * loaded only when a page has a diagram. */
import { DIAGRAM_CHARS } from "./artifact-render.ts";

type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

function load(dark: boolean): Promise<Mermaid> {
  loading ??= import("mermaid").then(module => module.default);
  return loading.then(mermaid => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", maxTextSize: DIAGRAM_CHARS, maxEdges: 500,
      htmlLabels: false, flowchart: { htmlLabels: false }, theme: dark ? "dark" : "neutral",
      fontFamily: "Archivo Variable, system-ui, sans-serif",
    });
    return mermaid;
  });
}

/** The SVG of one diagram as a data URL, or the parser's complaint. */
export function drawDiagram(source: string, dark: boolean): Promise<{ url: string; width: number } | { error: string }> {
  const run = queue.then(async () => {
    if (source.length > DIAGRAM_CHARS) return { error: `diagram too large to draw (at most ${DIAGRAM_CHARS} characters)` };
    const mermaid = await load(dark);
    try {
      const { svg } = await mermaid.render(`artifact-diagram-${++serial}`, source);
      const width = Number(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/.exec(svg)?.[1] ?? 0);
      return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width };
    } catch (error) {
      // Mermaid leaves its error drawing in the page; take it out again.
      document.getElementById(`dartifact-diagram-${serial}`)?.remove();
      return { error: `diagram could not be drawn: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200)}` };
    }
  });
  queue = run.catch(() => {});
  return run;
}
