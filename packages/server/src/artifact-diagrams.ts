/** The Mermaid diagrams of an artifact body, checked before a revision is
 * written: each ```mermaid fence must be one Pele (https://pele.run, the
 * library the page draws with) can parse and draw, or the write is refused
 * with every problem, so the writing agent can fix the diagram instead of the
 * user finding a broken one.
 *
 * The fences are found as the page finds them (`marked` with the same pinned
 * version and options as `renderArtifact`), and drawn with the options the
 * page uses (no links, no images, the same size bounds). Pele runs locally,
 * in a worker thread with a deadline and a heap cap, so a pathological
 * diagram costs at most that and never stalls cubed: nothing is sent to any
 * service. */
import { Worker } from "node:worker_threads";
import { Lexer, type Token, type Tokens } from "marked";

/** The longest diagram source drawn (Pele's `limit`); the page has the same bound. */
export const DIAGRAM_CHARS = 20_000;
/** Pele's `maxEdges` for flowcharts; the page draws with the same. */
export const DIAGRAM_EDGES = 500;
/** Diagrams one revision may hold. */
export const DIAGRAMS_PER_BODY = 50;
/** How long checking one body's diagrams may take, all together. */
export const DIAGRAM_CHECK_MS = 5_000;

export interface MermaidFence {
  /** 1-based, in document order. */
  index: number;
  source: string;
  /** The line of the body the fence opens on (1-based), or null when it cannot be told (a fence nested in a list). */
  line: number | null;
}

/** Why one diagram was refused. `line`/`column` are within the diagram's
 * source (0 when Pele gives no position); `bodyLine` is the same line in
 * the whole body, when the fence's place is known. */
export interface DiagramProblem {
  diagram: number;
  code: "syntax" | "semantic" | "limit" | "unsupported-diagram" | "render";
  message: string;
  line: number; column: number; snippet: string;
  fenceLine: number | null; bodyLine: number | null;
}

const MESSAGE_CHARS = 600;
const SNIPPET_CHARS = 240;

export function mermaidFences(body: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  let from = 0;
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "code") {
        const code = token as Tokens.Code;
        // The page's rule (artifact-render.ts): the first word of the info string.
        if ((code.lang ?? "").trim().split(/\s+/)[0]!.toLowerCase() !== "mermaid") continue;
        // Its raw text, in document order; a fence in a list item or quote is lexed without
        // its indent or `>`, so then its opening line followed by its first line.
        let start = -1;
        const at = body.indexOf(code.raw, from);
        if (at >= 0) {
          start = at + code.raw.length - code.raw.trimStart().length;
          from = at + code.raw.length;
        } else {
          const first = code.text.split("\n", 1)[0]!.trim();
          for (const match of body.slice(from).matchAll(OPENING)) {
            const next = body.slice(from + match.index + match[0].length).split("\n", 2)[1] ?? "";
            if (next.replace(/^[\s>]*/, "").trim() !== first) continue;
            start = from + match.index + match[0].length - match[0].trimStart().length;
            from = start + match[0].trimStart().length;
            break;
          }
        }
        fences.push({ index: fences.length + 1, source: code.text, line: start >= 0 ? lineAt(body, start) : null });
        continue;
      }
      const nested = token as { tokens?: Token[]; items?: Tokens.ListItem[] };
      if (token.type === "list") for (const item of nested.items ?? []) visit(item.tokens);
      else if (nested.tokens) visit(nested.tokens);
    }
  };
  visit(new Lexer({ gfm: true, breaks: false }).lex(body));
  return fences;
}

/** A fence opening line naming mermaid, inside any list or quote markers. */
const OPENING = /^[ \t>*+\-\d.)]*(?:```+|~~~+)[ \t]*mermaid\b[^\n]*/gim;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

let queue: Promise<unknown> = Promise.resolve();

/** Every problem with the body's diagrams; empty when there are none or all draw.
 * Rejects only when the check itself could not run (then nothing should be written). */
export function checkDiagrams(body: string, options: { deadlineMs?: number } = {}): Promise<DiagramProblem[]> {
  const fences = mermaidFences(body);
  if (!fences.length) return Promise.resolve([]);
  if (fences.length > DIAGRAMS_PER_BODY) {
    return Promise.resolve([{ diagram: DIAGRAMS_PER_BODY + 1, code: "limit", message: `${fences.length} diagrams; a revision holds at most ${DIAGRAMS_PER_BODY}`,
      line: 0, column: 0, snippet: "", fenceLine: fences[DIAGRAMS_PER_BODY]!.line, bodyLine: null }]);
  }
  const problems: DiagramProblem[] = [];
  const drawn: MermaidFence[] = [];
  for (const fence of fences) {
    if (fence.source.length > DIAGRAM_CHARS) {
      problems.push({ diagram: fence.index, code: "limit", message: `the diagram is ${fence.source.length} characters; at most ${DIAGRAM_CHARS}`,
        line: 0, column: 0, snippet: "", fenceLine: fence.line, bodyLine: null });
    } else drawn.push(fence);
  }
  if (!drawn.length) return Promise.resolve(problems);
  // One check at a time: concurrent writes wait rather than each starting a worker.
  const run = queue.then(() => inWorker(drawn, options.deadlineMs ?? DIAGRAM_CHECK_MS)).then(found => [...problems, ...found].sort((a, b) => a.diagram - b.diagram));
  queue = run.catch(() => {});
  return run;
}

function inWorker(fences: MermaidFence[], deadlineMs: number): Promise<DiagramProblem[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./artifact-diagrams-worker.ts", import.meta.url), {
      workerData: { fences: fences.map(({ index, source }) => ({ index, source })), limit: DIAGRAM_CHARS, maxEdges: DIAGRAM_EDGES },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
    });
    let settled = false;
    const finish = (outcome: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); outcome(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`the diagrams took longer than ${deadlineMs / 1000} s to check; make them smaller or fewer`))), deadlineMs);
    worker.once("message", (found: Omit<DiagramProblem, "fenceLine" | "bodyLine">[]) => finish(() => resolve(found.map(problem => {
      const fenceLine = fences.find(fence => fence.index === problem.diagram)?.line ?? null;
      return {
        ...problem, message: clip(problem.message, MESSAGE_CHARS), snippet: problem.snippet.split("\n").slice(0, 2).map(line => clip(line, SNIPPET_CHARS)).join("\n"),
        fenceLine, bodyLine: fenceLine !== null && problem.line > 0 ? fenceLine + problem.line : null,
      };
    }))));
    worker.once("error", (error: unknown) => finish(() => reject(new Error(`the diagrams could not be checked: ${error instanceof Error ? error.message : String(error)}`))));
    worker.once("exit", code => finish(() => reject(new Error(`the diagrams could not be checked (the checker stopped with ${code})`))));
  });
}

const clip = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars - 1)}…` : text;

/** The problems in words for the agent that wrote the body: which fence,
 * where, Pele's own message and the marked line. */
export function diagramProblemsText(problems: readonly DiagramProblem[], total: number): string {
  const lines = [`${problems.length === 1 ? "a ```mermaid diagram does" : `${problems.length} \`\`\`mermaid diagrams do`} not draw, so nothing was written; fix ${problems.length === 1 ? "it" : "each"} and write again:`];
  for (const problem of problems) {
    const where = [
      `diagram ${problem.diagram} of ${total}`,
      problem.fenceLine !== null ? `fence at body line ${problem.fenceLine}` : null,
      problem.line > 0 ? `diagram line ${problem.line}${problem.column > 0 ? `, column ${problem.column}` : ""}${problem.bodyLine !== null ? ` (body line ${problem.bodyLine})` : ""}` : null,
    ].filter(Boolean).join(", ");
    // Pele's syntax message repeats the snippet; its first line and the expectation say it.
    const marked = problem.snippet.split("\n");
    const message = problem.message.split("\n").filter(line => line.trim() && !marked.includes(line)).map(line => line.trim()).join(" ");
    lines.push(`- ${where}: ${problem.code}: ${message}`);
    if (problem.snippet) lines.push(...problem.snippet.split("\n").map(line => `    ${line}`));
  }
  lines.push("Pele draws the diagrams (Mermaid syntax, https://pele.run/compatibility); ZenUML and other external Mermaid plugins are not supported.");
  return lines.join("\n");
}
