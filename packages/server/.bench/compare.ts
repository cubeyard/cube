/** Before/after: the old whole-store reads vs the page reader, on the bench stores. */
import fs from "node:fs";
import path from "node:path";
import { readStorage } from "../src/durable-agent.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { render } from "../src/claude-thread-events.ts";
import { pageOf, readClaudeHistory, readPiHistory } from "../src/thread-history.ts";

const data = process.argv[2] ?? "/workspace/packages/server/.bench/data";
const t = async (label: string, read: () => Promise<unknown>, n = 3) => {
  const times: number[] = [];
  for (let k = 0; k < n; k++) { const s = performance.now(); await read(); times.push(performance.now() - s); }
  console.log(`${label}: ${times.map(ms => ms.toFixed(1)).join(" / ")} ms`);
};
const pi = path.join(data, "pi", "pi.sqlite");
const claude = path.join(data, "claude");
const rss = () => `${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB rss`;
console.log(`pi ${(fs.statSync(pi).size / 2 ** 20).toFixed(1)} MiB; claude ${(fs.statSync(path.join(claude, "claude.sqlite")).size / 2 ** 20).toFixed(1)} MiB`);
if (process.argv[3] !== "new") {
  await t("before pi  (snapshot copy + whole transcript), limit 12", async () => pageOf((await readStorage(pi, storage => storedPiTranscript(storage, null, null)))!, {}));
  await t("before claude (whole store + render), limit 12", async () => pageOf(render(ClaudeAgent.stored(claude)!, null, null, path.join(claude, "claude")), {}));
  console.log(rss());
}
if (process.argv[3] !== "old") {
  await t("after pi, first read (index built)", () => readPiHistory(pi, null, null, {}), 1);
  await t("after pi, limit 12", () => readPiHistory(pi, null, null, {}));
  await t("after pi, before 100 limit 40", () => readPiHistory(pi, null, null, { before: 100, limit: 40 }));
  await t("after claude, first read (index built)", () => readClaudeHistory(path.join(claude, "claude.sqlite"), path.join(claude, "claude"), null, null, {}), 1);
  await t("after claude, limit 12", () => readClaudeHistory(path.join(claude, "claude.sqlite"), path.join(claude, "claude"), null, null, {}));
  await t("after claude, before 100 limit 40", () => readClaudeHistory(path.join(claude, "claude.sqlite"), path.join(claude, "claude"), null, null, { before: 100, limit: 40 }));
  console.log(rss());
}
