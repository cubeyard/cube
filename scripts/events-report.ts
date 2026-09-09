/**
 * Summarise cubed's lifecycle events per version: how often each operation
 * ran, how often it failed, and its p50/p95/max duration — the numbers to
 * compare before and after a change (the hill-climbing loop in AGENTS.md).
 * Zero dependencies; reads GET /api/events from a running cubed, or a
 * JSON file saved from it.
 *
 *   node scripts/events-report.ts                          # last 7 days from http://127.0.0.1:7777
 *   node scripts/events-report.ts --since 24h --url http://host:7777
 *   node scripts/events-report.ts --compare v0.1.11 v0.1.12-dirty@night/x   # side by side
 *   node scripts/events-report.ts --failures                # the failures themselves, newest first
 *   node scripts/events-report.ts --file events.json        # from `curl .../api/events?limit=10000 > events.json`
 */
import fs from "node:fs";

interface Event {
  ts: number;
  kind: string;
  phase: string | null;
  op: string | null;
  cube: string | null;
  thread: string | null;
  ok: boolean;
  ms: number | null;
  detail: string | null;
  version: string;
}

const argv = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
};
const flag = (name: string) => argv.includes(name);
if (flag("-h") || flag("--help")) {
  console.log("usage: node scripts/events-report.ts [--url U] [--file F] [--since 7d] [--kind K] [--compare A B] [--failures] [--json]");
  process.exit(0);
}
const url = (opt("--url") ?? process.env.CUBED_URL ?? "http://127.0.0.1:7777").replace(/\/$/, "");
const since = opt("--since") ?? "7d";
const kindFilter = opt("--kind");
const compareAt = argv.indexOf("--compare");
const compare = compareAt >= 0 ? [argv[compareAt + 1], argv[compareAt + 2]].filter((v): v is string => !!v) : [];

async function load(): Promise<Event[]> {
  const file = opt("--file");
  if (file) return (JSON.parse(fs.readFileSync(file, "utf8")) as { events: Event[] }).events;
  const res = await fetch(`${url}/api/events?limit=${LIMIT}&since=${encodeURIComponent(since)}${kindFilter ? `&kind=${encodeURIComponent(kindFilter)}` : ""}`);
  if (!res.ok) throw new Error(`GET /api/events -> ${res.status}`);
  return ((await res.json()) as { events: Event[] }).events;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

interface Stat { n: number; failed: number; durations: number[] }

function summarise(events: Event[]): Map<string, Map<string, Stat>> {
  // version -> "kind.phase" -> stat
  const out = new Map<string, Map<string, Stat>>();
  for (const e of events) {
    const byOp = out.get(e.version) ?? new Map<string, Stat>();
    out.set(e.version, byOp);
    const key = e.phase ? `${e.kind}.${e.phase}` : e.kind;
    const stat = byOp.get(key) ?? { n: 0, failed: 0, durations: [] };
    byOp.set(key, stat);
    stat.n += 1;
    if (!e.ok) stat.failed += 1;
    if (e.ms !== null) stat.durations.push(e.ms);
  }
  for (const byOp of out.values()) for (const stat of byOp.values()) stat.durations.sort((a, b) => a - b);
  return out;
}

const fmtMs = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

function printVersion(version: string, byOp: Map<string, Stat>): void {
  console.log(`\n${version}`);
  console.log(`  ${"operation".padEnd(24)} ${"runs".padStart(5)} ${"fail".padStart(5)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`);
  for (const [key, s] of [...byOp.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const d = s.durations;
    console.log(
      `  ${key.padEnd(24)} ${String(s.n).padStart(5)} ${String(s.failed).padStart(5)} ${(d.length ? fmtMs(percentile(d, 50)) : "-").padStart(8)} ${(d.length ? fmtMs(percentile(d, 95)) : "-").padStart(8)} ${(d.length ? fmtMs(d[d.length - 1]!) : "-").padStart(8)}`,
    );
  }
}

function printCompare(a: string, b: string, all: Map<string, Map<string, Stat>>): void {
  const left = all.get(a);
  const right = all.get(b);
  if (!left || !right) {
    console.log(`versions seen: ${[...all.keys()].join(", ") || "none"}`);
    throw new Error(`--compare needs two recorded versions (missing: ${!left ? a : b})`);
  }
  console.log(`\n${"operation".padEnd(24)} ${a.slice(0, 22).padStart(22)} ${b.slice(0, 22).padStart(22)} ${"Δ p50".padStart(9)}`);
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of [...keys].sort()) {
    const l = left.get(key);
    const r = right.get(key);
    const lp = l?.durations.length ? percentile(l.durations, 50) : null;
    const rp = r?.durations.length ? percentile(r.durations, 50) : null;
    const cell = (s: Stat | undefined, p: number | null) => (s ? `${s.n}× ${s.failed ? `${s.failed}✗ ` : ""}${p === null ? "" : fmtMs(p)}` : "-");
    const delta = lp !== null && rp !== null ? `${rp >= lp ? "+" : ""}${Math.round(((rp - lp) / Math.max(lp, 1)) * 100)}%` : "";
    console.log(`${key.padEnd(24)} ${cell(l, lp).padStart(22)} ${cell(r, rp).padStart(22)} ${delta.padStart(9)}`);
  }
}

const LIMIT = 10_000;
const events = await load();
if (events.length >= LIMIT) {
  console.error(`note: the server returned the newest ${LIMIT} events only — the window is truncated; narrow --since or --kind before comparing`);
}
if (flag("--json")) {
  const summary: Record<string, Record<string, { n: number; failed: number; p50: number; p95: number; max: number }>> = {};
  for (const [version, byOp] of summarise(events)) {
    summary[version] = {};
    for (const [key, s] of byOp) {
      summary[version][key] = { n: s.n, failed: s.failed, p50: percentile(s.durations, 50), p95: percentile(s.durations, 95), max: s.durations[s.durations.length - 1] ?? 0 };
    }
  }
  console.log(JSON.stringify(summary));
} else if (flag("--failures")) {
  const failures = events.filter((e) => !e.ok);
  console.log(`${failures.length} failure(s) since ${since}`);
  for (const e of failures) {
    const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19);
    console.log(`  ${when}  ${e.version}  ${e.phase ? `${e.kind}.${e.phase}` : e.kind}  ${e.thread ?? e.cube ?? ""}  ${e.detail ?? ""}`);
  }
} else if (compare.length === 2) {
  printCompare(compare[0]!, compare[1]!, summarise(events));
} else {
  const all = summarise(events);
  console.log(`${events.length} event(s) since ${since}, ${all.size} version(s)`);
  for (const [version, byOp] of all) printVersion(version, byOp);
}
