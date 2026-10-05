import { Marked, type Tokens } from "marked";

/** Agent prose as GitHub-flavoured markdown. The text is model output and
 * may quote anything it read, so raw HTML is printed as text, links are
 * limited to http(s) and mailto, and images become plain links: the browser
 * never fetches a URL the transcript names. */
const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const label = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      if (!url) return label;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      const url = safeUrl(href);
      const label = escapeHtml(text || href);
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

function safeUrl(href: string): string | null {
  try {
    const url = new URL(href, "https://invalid.example/");
    if (url.origin === "https://invalid.example") return null;
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
