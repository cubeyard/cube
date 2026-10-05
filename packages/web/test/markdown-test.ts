/** Agent prose renders as markdown without letting the transcript inject
 * markup, scripts or remote fetches into the page. */
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/lib/markdown.ts";

const html = renderMarkdown("## title\n\n**bold** and `code`\n\n- one\n- two\n\n```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |");
assert.match(html, /<h2>title<\/h2>/);
assert.match(html, /<strong>bold<\/strong> and <code>code<\/code>/);
assert.match(html, /<ul>\s*<li>one<\/li>/);
assert.match(html, /<pre><code class="language-ts">const a = 1 &lt; 2;/);
assert.match(html, /<table>/);
assert.match(renderMarkdown("one\ntwo"), /one<br>two/, "a single newline stays a line break");

const hostile = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> <b>raw</b>\n\n![pixel](https://tracker.example/p.png)');
assert.doesNotMatch(hostile, /<script|<img|<b>/, "raw html is printed, never parsed");
assert.match(hostile, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.match(hostile, /<a href="https:\/\/tracker.example\/p.png" target="_blank" rel="noopener noreferrer">pixel<\/a>/, "an image is a link, not a fetch");

assert.match(renderMarkdown("[docs](https://example.com)"), /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);
assert.equal(renderMarkdown("[x](javascript:alert(1))").includes("href"), false, "script urls lose their link");
assert.equal(renderMarkdown("[x](data:text/html,hi)").includes("href"), false);
assert.equal(renderMarkdown("[x](/api/threads)").includes("href"), false, "no links into cubed's own api");
console.log("ok: agent markdown renders without raw html, script links or remote images");
