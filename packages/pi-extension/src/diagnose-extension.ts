import path from "node:path";
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readDiagnosticFile } from "./diagnostics.ts";

export default function diagnosisExtension(pi: ExtensionAPI): void {
  const bundle = process.env.CUBE_DIAGNOSIS_BUNDLE;
  if (!bundle || fs.realpathSync(bundle) !== path.resolve(bundle)) throw new Error("A canonical diagnosis bundle is required");
  const ownSource = fs.realpathSync(import.meta.filename);
  const allowed = () => {
    const tools = pi.getActiveTools();
    const read = pi.getAllTools().find((tool) => tool.name === "read");
    return tools.length === 1 && tools[0] === "read" && read?.sourceInfo?.path !== undefined && fs.realpathSync(read.sourceInfo.path) === ownSource;
  };
  pi.registerTool({
    name: "read", label: "Read diagnostic evidence",
    description: "Read a generated diagnostic text file by its basename. Start with index.md. Returns numbered lines, up to 500 per call.",
    parameters: Type.Object({
      path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id, input) {
      if (!allowed()) throw new Error("RCA tool policy violated");
      return { content: [{ type: "text", text: await readDiagnosticFile(bundle, input.path, input.offset, input.limit) }], details: {} };
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (!allowed()) { ctx.ui.notify("RCA refused: only its own read tool is permitted", "error"); ctx.shutdown(); }
  });
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read" || !allowed()) return { block: true, reason: "RCA permits only bounded diagnostic reads", terminate: true };
  });
  pi.on("user_bash", async () => ({ result: { output: "Shell is disabled in RCA mode", exitCode: 126, cancelled: false, truncated: false } }));
}
