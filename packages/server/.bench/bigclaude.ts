import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeStore, output } from "../test/history-store-fixture.ts";
const dir = "/workspace/packages/server/.bench/big/claude";
fs.mkdirSync(dir, { recursive: true });
await claudeStore(dir, { turns: 1, calls: 0, bytes: 0 });
const db = new DatabaseSync(path.join(dir, "claude.sqlite"));
const root = path.join(dir, "claude");
const file = output(60_000);
db.exec("BEGIN");
const submit = db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES (?, ?, 'completed', NULL, 0)");
const message = db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)");
for (let turn = 0; turn < 30; turn++) {
  const seq = Number(submit.run(`big-${turn}`, `task ${turn}`).lastInsertRowid);
  message.run(seq, JSON.stringify({ type: "system", subtype: "init", tools: Array.from({ length: 40 }, (_, k) => `Tool${k}`), mcp_servers: [], cwd: root }));
  for (let k = 0; k < 120; k++) {
    const id = `b${turn}.${k}`;
    message.run(seq, JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: output(500) }, { type: "tool_use", id, name: "Edit", input: { file_path: `${root}/src/f${k}.ts`, old_string: "a", new_string: "b" } }], usage: { input_tokens: 10 } } }));
    message.run(seq, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "The file was updated." }] }, tool_use_result: { filePath: `${root}/src/f${k}.ts`, originalFile: file, structuredPatch: [] } }));
    if (k % 10 === 0) for (let j = 0; j < 5; j++) message.run(seq, JSON.stringify({ type: "user", parent_tool_use_id: id, message: { content: [{ type: "tool_result", tool_use_id: `sub${j}`, content: output(8000) }] } }));
  }
  message.run(seq, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `turn ${turn} done` }] } }));
}
db.exec("COMMIT");
db.close();
console.log((fs.statSync(path.join(dir, "claude.sqlite")).size / 2 ** 20).toFixed(0), "MiB");
