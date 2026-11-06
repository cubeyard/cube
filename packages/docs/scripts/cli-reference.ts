// berth's and the guest cube's usage strings are read from their Rust source,
// so the docs build needs no Rust toolchain.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const docs = path.resolve(import.meta.dirname, "..");
const root = path.resolve(docs, "../..");
const output = path.resolve(process.argv[2] ?? path.join(docs, "src/content/docs/reference/cli.md"));

function source(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function cubedHelp(): string {
  return execFileSync(process.execPath, [path.join(root, "packages/server/src/index.ts"), "--help"], { encoding: "utf8", timeout: 60_000 });
}

function rustString(file: string, name: string): string {
  const text = source(file);
  const match = new RegExp(`const ${name}: &str = "`).exec(text);
  if (!match) throw new Error(`${file}: no string constant ${name}`);
  let at = match.index + match[0].length;
  let value = "";
  for (; at < text.length; at++) {
    const char = text[at]!;
    if (char === '"') return value;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = text[++at];
    if (next === "\n") {
      while (/\s/.test(text[at + 1] ?? "")) at++;
    } else if (next === "n") value += "\n";
    else if (next === "t") value += "\t";
    else if (next === '"' || next === "\\" || next === "'") value += next;
    else throw new Error(`${file}: ${name} has an escape the reference does not read: \\${next}`);
  }
  throw new Error(`${file}: ${name} does not end`);
}

function block(text: string): string {
  return ["```text wrap", text.trimEnd(), "```"].join("\n");
}

const sections = [
  {
    heading: "cubed",
    intro: "The control plane: the web UI, the chat, threads and their agents. Run it on the host that keeps cube's state.",
    from: "packages/server/src/index.ts",
    text: cubedHelp(),
  },
  {
    heading: "berth",
    intro: "The runner that hosts thread machines. Homebrew's `cube-berth` service and `cubed runners init-local` run it for you; you run it by hand only for a runner on another machine or for maintenance.",
    from: "packages/berth/src/main.rs",
    text: rustString("packages/berth/src/main.rs", "USAGE"),
  },
  {
    heading: "cube (inside a thread machine)",
    intro: "The command a thread's agent runs in its own machine. It is not installed on your computer.",
    from: "packages/keel/agent/src/cli.rs",
    text: rustString("packages/keel/agent/src/cli.rs", "USAGE"),
  },
  {
    heading: "cube hooks",
    intro: "",
    from: "packages/keel/agent/src/hooks.rs",
    text: rustString("packages/keel/agent/src/hooks.rs", "USAGE"),
  },
];

const page = [
  "---",
  "title: command line",
  "editUrl: false",
  "description: The help text of cubed, berth and the cube command in a thread machine, as the programs print it.",
  "tableOfContents:",
  "  maxHeadingLevel: 2",
  "---",
  "",
  "<!-- Written by packages/docs/scripts/cli-reference.ts from the source at build time. Do not edit. -->",
  "",
  "Each block below is the program's own help text, read from the source this site was built from.",
  "",
  ...sections.flatMap(({ heading, intro, from, text }) => [
    `## ${heading}`,
    "",
    ...(intro ? [intro, ""] : []),
    block(text),
    "",
    `Source: [\`${from}\`](gh:${from}).`,
    "",
  ]),
].join("\n");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, page);
console.log(`cli reference: ${path.relative(process.cwd(), output)} (${sections.length} help texts)`);
