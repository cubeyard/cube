// Spike for the authorization plan, step 2: the recording as a fixture
// corpus. The recording holds placeholders only (taken before
// substitution); this replaces the run's placeholder with a fixed one, also
// inside `Authorization: Basic`, drops cookies, fixes the VM id, makes time
// relative, labels each request with its scenario and adds the actions
// facts.ts derives. Bodies are kept (the repository is a disposable one).
//
//   node redact.ts <capture.jsonl> <capture.scenarios.json> <github-ops.json> <out.jsonl>
import fs from "node:fs";
import { classify, compile, type Recorded } from "./facts.ts";

const [input, scenariosFile, opsFile, output] = process.argv.slice(2);
const { placeholder, scenarios } = JSON.parse(fs.readFileSync(scenariosFile, "utf8")) as
  { placeholder: string; scenarios: { name: string; from: number; to: number }[] };
const FIXED = "cube_ph_github_0000000000000000000000";
const ops = compile(JSON.parse(fs.readFileSync(opsFile, "utf8")));
const scrub = (text: string) => text.split(placeholder).join(FIXED);
const rows = fs.readFileSync(input, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Recorded & { time: number });
const first = rows[0]?.time ?? 0;
const out: string[] = [];
for (const [index, row] of rows.entries()) {
  const headers = row.headers.filter(([name]) => name.toLowerCase() !== "cookie").map(([name, value]): [string, string] => {
    const basic = /^basic (.+)$/i.exec(value);
    if (name.toLowerCase() === "authorization" && basic) {
      return [name, `Basic ${Buffer.from(scrub(Buffer.from(basic[1], "base64").toString("latin1")), "latin1").toString("base64")}`];
    }
    return [name, scrub(value)];
  });
  const body = Buffer.from(row.body, "base64");
  const scrubbed = body.includes(placeholder) ? Buffer.from(scrub(body.toString("latin1")), "latin1") : body;
  const request: Recorded = { scheme: row.scheme, host: row.host, port: row.port, method: row.method, target: scrub(row.target),
    headers, bodyLength: scrubbed.length, body: scrubbed.toString("base64") };
  const scenario = scenarios.find(s => row.time >= s.from - 50 && row.time <= s.to + 50)?.name
    ?? (row.time < (scenarios[0]?.from ?? 0) ? "machine-checkout" : "unlabelled");
  const line = JSON.stringify({ seq: index, ms: row.time - first, scenario, request, actions: classify(request, ops) });
  if (line.includes(placeholder)) throw new Error("placeholder left in the corpus");
  out.push(line);
}
fs.writeFileSync(output, `${out.join("\n")}\n`);
console.log(`${out.length} requests -> ${output}`);
