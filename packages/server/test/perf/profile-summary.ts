/** Summarizes a V8 .cpuprofile (node --cpu-prof): self time by function and
 * the total (inclusive) time of the functions that call into it.
 *
 *   node packages/server/test/perf/profile-summary.ts FILE.cpuprofile [top]
 */
import fs from "node:fs";

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };
const profile = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { nodes: Node[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] };
const top = Number(process.argv[3] ?? 30);
const byId = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
// Time per sample from the deltas.
const self = new Map<number, number>();
profile.samples.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0)));
const key = (node: Node) => `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.replace(/^.*\/(packages|node_modules)\//, "$1/").replace(/^file:\/\//, "")}:${node.callFrame.lineNumber + 1}`;
const selfBy = new Map<string, number>(), totalBy = new Map<string, number>();
for (const [id, micros] of self) {
  const node = byId.get(id)!;
  selfBy.set(key(node), (selfBy.get(key(node)) ?? 0) + micros);
  const seen = new Set<string>();
  for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
    const k = key(byId.get(at)!);
    if (seen.has(k)) continue;
    seen.add(k);
    totalBy.set(k, (totalBy.get(k) ?? 0) + micros);
  }
}
const wall = (profile.endTime - profile.startTime) / 1000;
const busy = [...self.entries()].filter(([id]) => !["(idle)", "(program)", "(garbage collector)"].includes(byId.get(id)!.callFrame.functionName)).reduce((sum, [, micros]) => sum + micros, 0) / 1000;
const ms = (micros: number) => (micros / 1000).toFixed(0).padStart(7);
console.log(`profile: ${wall.toFixed(0)} ms wall, ${busy.toFixed(0)} ms in JS (idle, program and GC apart): GC ${ms(selfBy.get(key({ id: 0, callFrame: { functionName: "(garbage collector)", url: "", lineNumber: -1 } })) ?? 0)} ms`);
console.log("\nself time (ms):");
for (const [name, micros] of [...selfBy].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms(micros)}  ${name}`);
console.log("\ninclusive time, cube's own code (ms):");
for (const [name, micros] of [...totalBy].filter(([name]) => name.includes("packages/server/src")).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms(micros)}  ${name}`);
