/**
 * The unshadowed-tool guard. An active tool this extension did not itself
 * register would execute on the credentialed host pi runs on — so the rule
 * is fail-closed: every active tool must be one of the names we shadow AND
 * its effective definition must come from this extension's own source path.
 * Anything else (an unshadowed built-in, another extension's tool, a
 * shadow-war lost over one of our names) is a refusal.
 */
import fs from "node:fs";
import path from "node:path";

/** The complete model-facing tool surface this extension permits. */
export const SHADOWED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "code",
]);

export interface ToolAudit {
  name: string;
  /** ToolInfo.sourceInfo.path — where the effective definition came from. */
  sourcePath?: string;
}

function canonical(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Audit the active tool set. Returns human-readable violations; empty
 * means every active tool is one of ours. `ownRoot` is this extension
 * package's directory — the only source allowed to define tools.
 */
export function auditTools(activeNames: string[], allTools: ToolAudit[], ownRoot: string): string[] {
  const root = canonical(ownRoot) + path.sep;
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const violations: string[] = [];
  for (const name of activeNames) {
    if (!SHADOWED_TOOLS.has(name)) {
      violations.push(`unknown tool "${name}" would run on the host`);
      continue;
    }
    const info = byName.get(name);
    const source = info?.sourcePath ? canonical(info.sourcePath) : undefined;
    if (!source || !(source + path.sep).startsWith(root)) {
      violations.push(`tool "${name}" is not backed by the cube extension (source: ${info?.sourcePath ?? "unknown"})`);
    }
  }
  return violations;
}
