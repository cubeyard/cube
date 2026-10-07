import { Marked, type Tokens } from "marked";

/** Agent prose as GitHub-flavoured markdown. The text is model output and
 * may quote anything it read, so raw HTML is printed as text, links are
 * limited to http(s) and mailto, and images become plain links: the browser
 * never fetches a URL the transcript names. The one exception is an image
 * the caller's `picture` resolves (one the thread itself read, served from
 * the thread's own store): that is shown, as a key that opens it larger. */
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
      const url = safeUrl(href, { pages: true });
      if (!url) return label;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      // cube's own pages (an artifact an agent links) open in place.
      const target = url.startsWith("#/") ? "" : ' target="_blank" rel="noopener noreferrer"';
      // A shown image is a key of its own, never inside a link; the link follows it.
      if (label.includes(SHOWN_IMAGE)) return `${label} <a href="${escapeHtml(url)}"${titleAttr}${target}>${escapeHtml(href)}</a>`;
      return `<a href="${escapeHtml(url)}"${titleAttr}${target}>${label}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      const shown = picture?.(href);
      if (shown) {
        const label = escapeHtml(text || "image");
        return `<button type="button" class="${SHOWN_IMAGE}" data-image="${escapeHtml(shown)}" data-label="${label}" aria-label="view ${label} larger">`
          + `<img src="${escapeHtml(shown)}" alt="${label}" loading="lazy" decoding="async"><span class="message-image-missing">image unavailable · retry</span></button>`;
      }
      const url = safeUrl(href);
      const label = escapeHtml(text || href);
      return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
  },
});

const SHOWN_IMAGE = "message-image markdown-image";

/** The image source a markdown image's target resolves to, during one render. */
let picture: ((href: string) => string | null) | undefined;

export function renderMarkdown(text: string, pictures?: (href: string) => string | null): string {
  picture = pictures;
  try { return marked.parse(text) as string; }
  finally { picture = undefined; }
}

/** `pages`: also cube's own hash routes (`#/a/<id>`, `#/t/<id>`, …). */
export function safeUrl(href: string, options: { pages?: boolean } = {}): string | null {
  if (options.pages && /^#\/[A-Za-z0-9/_?=&.-]*$/.test(href)) return href;
  try {
    const url = new URL(href, "https://invalid.example/");
    if (url.origin === "https://invalid.example") return null;
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
