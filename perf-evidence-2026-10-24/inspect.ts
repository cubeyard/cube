import fs from "node:fs";
const snap = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const m = snap.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length;
const nT = m.node_types[0], eT = m.edge_types[0], N = snap.nodes, E = snap.edges, S = snap.strings;
const count = N.length / nf, first = new Uint32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) { first[i] = e; e += N[i * nf + 4] * ef; } first[count] = E.length;
const name = (i: number) => S[N[i * nf + 1]], type = (i: number) => nT[N[i * nf]];
const edges = (n: number) => { const r: [string, string, number][] = []; for (let e = first[n]; e < first[n + 1]; e += ef) { const et = eT[E[e]]; r.push([et, et === "element" || et === "hidden" ? String(E[e + 1]) : S[E[e + 1]], E[e + 2] / nf]); } return r; };
// find object named "threadId" edge holder: walk from the closure "refresh"
let threadIdSig = -1;
for (let i = 0; i < count; i++) if (type(i) === "closure" && name(i) === "refresh") {
  const ctx = edges(i).find(x => x[1] === "context"); if (!ctx) continue;
  const t = edges(ctx[2]).find(x => x[1] === "threadId" && type(x[2]) === "object"); if (t) { threadIdSig = t[2]; break; }
}
console.log("threadId signal fields:", edges(threadIdSig).filter(x => x[0] === "property").map(x => `${x[1]}=${type(x[2])}:${name(x[2]).slice(0, 40)}`).join(" "));
const reactions = edges(threadIdSig).find(x => x[1] === "reactions")![2];
const items = edges(reactions).filter(x => x[0] === "element");
console.log("reactions:", items.length);
for (const [, idx, r] of items) {
  const props = edges(r).filter(x => x[0] === "property");
  const fn = props.find(x => x[1] === "fn");
  let src = "";
  if (fn) { const sh = edges(fn[2]).find(x => x[1] === "shared"); const info = sh ? edges(sh[2]).find(x => x[1] === "script_or_debug_info" || x[1] === "function_data") : null; src = name(fn[2]) + " " + (sh ? name(sh[2]) : ""); }
  console.log(`[${idx}] ${props.map(x => `${x[1]}=${type(x[2]) === "number" || type(x[2]) === "hidden" ? name(x[2]) : type(x[2])}`).join(" ")} fn:${src}`);
}
for (const [, idx, r] of items.slice(1)) { const v = edges(r).find(x => x[1] === "v")!; const f = edges(r).find(x => x[1] === "f")!; const p = edges(r).find(x => x[1] === "parent")!; console.log(idx, JSON.stringify(name(v[2]).slice(0, 80)), "f=", name(f[2]), "parent:", edges(p[2]).filter(x=>x[0]==="property").map(x=>x[1]).join(",")); }
