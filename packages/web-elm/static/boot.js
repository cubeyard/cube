// The platform edges Elm cannot reach: one EventSource, localStorage and the
// text selection. Everything else is Elm (src/Main.elm).
const SEEN = "cube-elm.seen";
const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN) || "{}"); } catch { return {}; } };
const app = Elm.Main.init({ flags: { now: Date.now(), seen: readSeen() } });

let source = null;
const close = () => { if (source) source.close(); source = null; };
app.ports.streamClose.subscribe(close);
function open(url) {
  close();
  const stream = new EventSource(url);
  source = stream;
  const state = value => { if (source === stream) app.ports.streamState.send({ url, state: value }); };
  const again = () => setTimeout(() => { if (source === stream) open(url); }, 1500);
  stream.onopen = () => state("open");
  stream.onmessage = event => { if (source === stream) app.ports.streamFrame.send({ url, transcript: JSON.parse(event.data) }); };
  stream.onerror = async () => {
    if (stream.readyState !== EventSource.CLOSED) return state("lost");
    // EventSource gives up on any answer but a stream and carries no reason:
    // the history route says whether cubed refuses (a 4xx) or is only away.
    let answer;
    try { answer = await fetch(url.replace("/stream?", "/history?")); }
    catch { state("lost"); return again(); }
    if (answer.ok || answer.status >= 500) { state("lost"); return again(); }
    const body = await answer.json().catch(() => null);
    state(`ended: ${body?.error || "the stream was refused"}`);
  };
}
app.ports.streamOpen.subscribe(open);

app.ports.saveSeen.subscribe(seen => { try { localStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* private mode */ } });
window.addEventListener("storage", event => { if (event.key === SEEN) app.ports.seenChanged.send(readSeen()); });

// A comment's anchor: the selected quote, 64 characters around it, its
// offsets in the document's text and the heading above it.
document.addEventListener("selectionchange", () => {
  const root = document.getElementById("artifact-body");
  const selection = document.getSelection();
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const text = root.textContent || "";
  const start = before.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return;
  const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(heading => heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING);
  app.ports.selectionMade.send({ quote, prefix: text.slice(Math.max(0, start - 64), start), suffix: text.slice(start + quote.length, start + quote.length + 64),
    start, end: start + quote.length, section: headings.at(-1)?.textContent ?? "" });
});
