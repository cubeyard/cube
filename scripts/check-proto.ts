/** `pnpm proto:check`: the committed TypeScript types are what buf
 * generates from packages/runner-protocol/proto/runner.proto now. With
 * `--write` (`pnpm proto:generate`) it regenerates them instead. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const root = path.join(import.meta.dirname, "..");
const proto = path.join(root, "packages/runner-protocol/proto");
const committed = path.join(root, "packages/server/src/gen");
const buf = path.join(root, "node_modules/.bin/buf");
const template = parse(fs.readFileSync(path.join(proto, "buf.gen.yaml"), "utf8")) as { plugins: Array<{ out: string }> };
const env = { ...process.env, PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}` };

const output = process.argv.includes("--write") ? committed : fs.mkdtempSync(path.join(os.tmpdir(), "cube-proto-"));
if (output === committed) fs.rmSync(committed, { recursive: true, force: true });
const plugins = template.plugins.map(plugin => ({ ...plugin, out: output }));
execFileSync(buf, ["generate", "--template", JSON.stringify({ ...template, plugins })], { cwd: proto, env, stdio: "inherit" });
if (output === committed) { console.log(`generated ${path.relative(root, committed)}`); process.exit(0); }

const names = (directory: string) => fs.readdirSync(directory).sort();
const stale = [...new Set([...names(committed), ...names(output)])].filter(name => {
  const a = path.join(committed, name), b = path.join(output, name);
  return !fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b));
});
fs.rmSync(output, { recursive: true, force: true });
if (stale.length) {
  console.error(`proto: ${stale.join(", ")} in packages/server/src/gen differ from runner.proto; run pnpm proto:generate`);
  process.exit(1);
}
console.log(`proto: packages/server/src/gen matches runner.proto (${names(committed).join(", ")})`);
