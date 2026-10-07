/** An artifact's body renders as data, and comment anchors land on the
 * words they were made on or nowhere. */
import assert from "node:assert/strict";
import { renderArtifact } from "../src/lib/artifact-render.ts";
import { placeAnchor, type Anchor } from "../src/lib/anchor.ts";
import { renderMarkdown } from "../src/lib/markdown.ts";

// Hostile content stays text; only safe links survive.
const hostile = renderArtifact([
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<iframe src=https://evil.example></iframe>",
  "[js](javascript:alert(1)) [data](data:text/html,<b>x</b>) [vb](vbscript:x) [rel](/api/artifacts) [page](#/a/123) [out](https://example.com)",
  "![pixel](https://tracker.example/p.png)",
  "```mermaid\ngraph TD\n  A-->B\n  click A \"javascript:alert(1)\"\n</code></pre><script>alert(2)</script>\n```",
  "```diff\n--- a\n+++ b\n@@ -1 +1 @@\n-<b>old</b>\n+new\n```",
  "```js\" onmouseover=\"alert(1)\nlet x = 1;\n```",
].join("\n\n"));
const html = hostile.html;
assert.doesNotMatch(html, /<script/i);
assert.doesNotMatch(html, /<img/i);
assert.doesNotMatch(html, /<iframe/i);
assert.doesNotMatch(html, /href="(javascript|data|vbscript):/i);
assert.doesNotMatch(html, /href="\/api/, "a relative path is no link");
assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(html, /<a href="#\/a\/123">page<\/a>/, "cube's own pages open in place");
assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">out<\/a>/);
assert.match(html, /<a href="https:\/\/tracker.example\/p.png" target="_blank" rel="noopener noreferrer">pixel<\/a>/, "an image is a link, never fetched");
assert.equal(hostile.diagrams.length, 1);
assert.match(hostile.diagrams[0]!, /click A/);
assert.match(html, /<figure class="artifact-diagram" data-anchor-skip data-diagram="0">/);
assert.match(html, /&lt;\/code&gt;&lt;\/pre&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/, "a diagram's source is escaped");
assert.match(html, /<span class="diff-line meta">--- a<\/span>/);
assert.match(html, /<span class="diff-line hunk">@@ -1 \+1 @@<\/span>/);
assert.match(html, /<span class="diff-line del">-&lt;b&gt;old&lt;\/b&gt;<\/span>/);
assert.match(html, /<span class="diff-line add">\+new<\/span>/);
assert.doesNotMatch(html, /onmouseover="/, "a code fence's language cannot add attributes");
assert.match(renderArtifact("```mermaid\n" + "A-->B\n".repeat(4000) + "```").html, /diagram too large to draw/);
// The chat's own markdown links artifacts too, and still refuses the rest.
assert.match(renderMarkdown("[review](#/a/abc)"), /<a href="#\/a\/abc">review<\/a>/);
assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /href=/);

// Anchors: exact on their revision, found again when one place fits best, outdated otherwise.
const text = "intro. the store keeps every revision. later, the store keeps every revision too.";
const at = text.indexOf("the store keeps every revision");
const anchor: Anchor = { quote: "the store keeps every revision", prefix: "intro. ", suffix: ". later", start: at, end: at + 30, section: "" };
assert.deepEqual(placeAnchor(text, anchor, true), { state: "exact", start: at, end: at + 30 });
const edited = `new first line. ${text}`;
assert.deepEqual(placeAnchor(edited, anchor, false), { state: "moved", start: at + 16, end: at + 46 }, "the context picks the first of two");
assert.deepEqual(placeAnchor(edited, anchor, true), { state: "moved", start: at + 16, end: at + 46 }, "offsets that no longer fit are not trusted");
assert.deepEqual(placeAnchor("the store forgets", anchor, false), { state: "outdated" });
const twins = "a quote here. a quote here.";
assert.deepEqual(placeAnchor(twins, { quote: "a quote here", prefix: "zz", suffix: "qq", start: 50, end: 62, section: "" }, false), { state: "outdated" }, "two equal places: neither");
console.log("ok: artifact render: hostile content inert, safe links, diagrams and diffs; anchors exact, moved, outdated, ambiguous");
