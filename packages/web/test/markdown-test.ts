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

// An image the thread read is shown, from the source the caller resolves; every other stays a link or text.
const resolve = (href: string) => href === "/workspace/a.png" ? "/api/threads/t/media/m7.0.0" : null;
const shown = renderMarkdown('![a "shot" <b>](/workspace/a.png) ![other](/workspace/b.png) ![remote](https://tracker.example/p.png)', resolve);
assert.equal((shown.match(/<img /g) ?? []).length, 1, "only the resolved image is fetched");
assert.match(shown, /<button type="button" class="message-image markdown-image" data-image="\/api\/threads\/t\/media\/m7.0.0" data-label="a &quot;shot&quot; &lt;b&gt;" aria-label="view a &quot;shot&quot; &lt;b&gt; larger"><img src="\/api\/threads\/t\/media\/m7.0.0" alt="a &quot;shot&quot; &lt;b&gt;"/);
assert.match(shown, /> other <a href="https:\/\/tracker.example\/p.png"/, "an unresolved path is its text");
const linked = renderMarkdown("[![a](/workspace/a.png)](https://example.com/page)", resolve);
assert.match(linked, /^<p><button [^]*<\/button> <a href="https:\/\/example.com\/page" target="_blank" rel="noopener noreferrer">https:\/\/example.com\/page<\/a><\/p>/, "a linked image is a key beside its link, not inside it");
assert.doesNotMatch(renderMarkdown("![a](/workspace/a.png)"), /<img/, "no resolver, no image");
assert.doesNotMatch(renderMarkdown("![a](/workspace/a.png)"), /media/, "the resolver of one render does not outlive it");
console.log("ok: agent markdown renders without raw html, script links or remote images, and shows only the images the thread read");
