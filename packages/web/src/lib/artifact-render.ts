import { Marked, type Tokens } from "marked";
import { diagramFigure } from "./diagram.ts";
import { escapeHtml, safeUrl } from "./markdown.ts";

/** An artifact's body as HTML. It is an agent's document and may quote
 * anything, so it is data: raw HTML is printed as text, links are http(s),
 * mailto or one of cube's own `#/` pages, images become links, ```diff is
 * coloured line by line and ```mermaid becomes a placeholder that
 * `diagram.ts` fills with Pele's picture (an <img> of the SVG, which runs
 * nothing). Diagrams are skipped by the text anchors (`data-anchor-skip`):
 * their drawing changes after the text is laid out. */
export interface RenderedArtifact { html: string; diagrams: string[] }

export function renderArtifact(body: string): RenderedArtifact {
  const diagrams: string[] = [];
  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      link({ href, title, tokens }: Tokens.Link): string {
        const label = this.parser.parseInline(tokens);
        const url = safeUrl(href, { pages: true });
        if (!url) return label;
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // cube's own pages open in place; everything else in a new tab.
        const target = url.startsWith("#/") ? "" : ` target="_blank" rel="noopener noreferrer"`;
        return `<a href="${escapeHtml(url)}"${titleAttr}${target}>${label}</a>`;
      },
      image({ href, text }: Tokens.Image): string {
        const url = safeUrl(href);
        const label = escapeHtml(text || href);
        return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      },
      code({ text, lang }: Tokens.Code): string {
        const language = (lang ?? "").trim().split(/\s+/)[0]!.toLowerCase();
        if (language === "mermaid") return diagramFigure(text, "artifact", diagrams.push(text) - 1);
        if (language === "diff" || language === "patch") return `<pre class="artifact-diff"><code>${diffLines(text)}</code></pre>\n`;
        const cls = language && /^[a-z0-9+#-]{1,20}$/.test(language) ? ` class="language-${language}"` : "";
        return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
      },
    },
  });
  return { html: marked.parse(body) as string, diagrams };
}

/** One span per line, classed by its first character; the text stays text. */
function diffLines(text: string): string {
  return text.split("\n").map(line => {
    const kind = line.startsWith("+++") || line.startsWith("---") ? "meta"
      : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    return `<span class="diff-line ${kind}">${escapeHtml(line) || " "}</span>`;
  }).join("\n");
}
