/** Draws an artifact's diagrams with Pele, off cubed's main thread, and
 * answers with what failed (artifact-diagrams.ts terminates it at its
 * deadline). Links and images are off, as on the page. */
import { parentPort, workerData } from "node:worker_threads";
import { PeleError, render } from "pele";

const { fences, limit, maxEdges } = workerData as { fences: { index: number; source: string }[]; limit: number; maxEdges: number };
const problems = [];
for (const { index, source } of fences) {
  try {
    render(source, { limit, maxEdges, links: false, images: false });
  } catch (error) {
    if (error instanceof PeleError) problems.push({ diagram: index, code: error.code, message: error.message, line: error.line, column: error.column, snippet: error.snippet });
    // Pele itself failed on this source: the page could not draw it either.
    else problems.push({ diagram: index, code: "render", message: error instanceof Error ? error.message : String(error), line: 0, column: 0, snippet: "" });
  }
}
parentPort!.postMessage(problems);
