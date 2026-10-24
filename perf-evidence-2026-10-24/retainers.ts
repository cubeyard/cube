// Usage: node retainers.ts BASE_URL THREAD_ID OUT.heapsnapshot
// chat -> thread -> chat, 4 times; GC; heap snapshot; shortest retainer path
// from a GC root to a detached element.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/home/agent/perfwt/packages/web/package.json");
const { chromium } = require("playwright");
const [base, threadId, out] = process.argv.slice(2);
if (!process.env.SNAP_ONLY) {
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage();
const cdp = await page.context().newCDPSession(page);
await page.goto(`${base}/#/chat`);
await page.waitForTimeout(3000);
for (let i = 0; i < 4; i++) {
  await page.evaluate((h) => { location.hash = h; }, `#/t/${threadId}`); await page.waitForTimeout(1200);
  await page.evaluate(() => { location.hash = "#/chat"; }); await page.waitForTimeout(1200);
}
await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
const chunks: string[] = [];
cdp.on("HeapProfiler.addHeapSnapshotChunk", (e: { chunk: string }) => chunks.push(e.chunk));
await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
fs.writeFileSync(out, chunks.join(""));
await browser.close();
}
const snap = JSON.parse(fs.readFileSync(out, "utf8"));
const m = snap.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length;
const nTypes = m.node_types[0], eTypes = m.edge_types[0];
const N = snap.nodes, E = snap.edges, S = snap.strings;
const count = N.length / nf;
const firstEdge = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) { firstEdge[i] = e; e += N[i * nf + m.node_fields.indexOf("edge_count")] * ef; }
firstEdge[count] = E.length;
const name = (i: number) => S[N[i * nf + 1]];
const type = (i: number) => nTypes[N[i * nf]];
// BFS from root (node 0), skipping weak edges; record parent edges.
const parent = new Int32Array(count).fill(-1), pedge = new Int32Array(count).fill(-1);
parent[0] = 0; const q = [0];
for (let h = 0; h < q.length; h++) {
  const n = q[h];
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += ef) {
    const et = eTypes[E[e]]; if (et === "weak" || et === "shortcut") continue;
    const to = E[e + 2] / nf; if (parent[to] !== -1) continue;
    parent[to] = n; pedge[to] = e; q.push(to);
  }
}
const detached = [];
for (let i = 0; i < count; i++) if (N[i * nf + 5] !== 1 && name(i).startsWith('<div class="transcript-page"') && parent[i] !== -1) detached.push(i);
console.log("detached divs reachable:", detached.length);
const edgeName = (e: number) => { const et = eTypes[E[e]]; const v = E[e + 1]; return et === "element" || et === "hidden" ? `[${v}]` : S[v]; };
for (const start of detached.slice(0, 2)) {
  const path = []; let n = start;
  while (n !== 0 && path.length < 80) { path.push(`${type(n)}:${name(n).slice(0, 60)} <-${edgeName(pedge[n])}-`); n = parent[n]; }
  console.log(path.join("\n"));
}
