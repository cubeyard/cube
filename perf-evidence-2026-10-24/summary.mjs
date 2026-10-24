// node summary.mjs results.json... : the send, older, idle, leak and api figures side by side.
import fs from "node:fs";
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("==", file);
  if (r.send) for (const s of r.send) console.log(`send older=${s.olderPages} rows=${s.rows} echo=${s.echoMs} turn=${s.turnMs} task=${s.taskMs} script=${s.scriptMs} layout=${s.layoutMs} longest=${s.main?.maxLongTaskMs} tbt=${s.main?.tbtMs}`);
  if (r.older) console.log("older", JSON.stringify(r.older).slice(0, 600));
  if (r.idle) for (const [k, v] of Object.entries(r.idle)) console.log(`idle ${k} task=${v.taskMs} script=${v.scriptMs} bytes=${JSON.stringify(v.server ?? v.bytes ?? "").slice(0, 160)}`);
  if (r.leak) for (const [k, v] of Object.entries(r.leak.byRoute)) console.log(`leak ${k} nodes/visit=${v.nodesPerCycle} listeners=${v.listenersPerCycle} heapKB=${v.heapKBPerCycle}`);
  if (r.leak) console.log("leak rounds", JSON.stringify(r.leak.rounds.at(0)), JSON.stringify(r.leak.rounds.at(-1)));
  if (r.api) console.log("api", JSON.stringify(r.api).slice(0, 700));
}
