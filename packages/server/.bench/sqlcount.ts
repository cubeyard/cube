import { DatabaseSync } from "node:sqlite";
const t = () => performance.now();
const cl = new DatabaseSync("/workspace/packages/server/.bench/data/claude/claude.sqlite", { readOnly: true });
for (let k = 0; k < 3; k++) {
  let s = t();
  const rows = cl.prepare(`SELECT m.seq, m.submission, m.data ->> '$.type' AS type,
    (SELECT count(*) FROM json_each(m.data, '$.message.content') b WHERE json_type(m.data, '$.message.content') = 'array' AND (
      (m.data ->> '$.type' = 'assistant' AND ((b.value ->> 'type' = 'text' AND b.value ->> 'text' <> '') OR (b.value ->> 'type' = 'tool_use' AND b.value ->> 'id' <> '')))
      OR (m.data ->> '$.type' = 'user' AND b.value ->> 'type' = 'tool_result' AND b.value ->> 'tool_use_id' <> ''))) AS shown
    FROM message m WHERE m.data ->> '$.parent_tool_use_id' IS NULL ORDER BY m.seq`).all();
  const sql = t() - s; s = t();
  const all = cl.prepare("SELECT seq, submission, data FROM message ORDER BY seq").all().map((row: any) => JSON.parse(row.data));
  console.log(`claude sql count ${sql.toFixed(0)} ms (${rows.length} rows, ${rows.reduce((n: number, row: any) => n + row.shown, 0)} shown); JS parse ${(t() - s).toFixed(0)} ms (${all.length})`);
}
const pi = new DatabaseSync("/workspace/packages/server/.bench/data/pi/pi.sqlite", { readOnly: true });
for (let k = 0; k < 3; k++) {
  let s = t();
  const rows = pi.prepare(`SELECT e.id, (SELECT count(*) FROM json_each(e.record, '$.model') m LEFT JOIN json_each(CASE WHEN m.value ->> 'role' = 'assistant' THEN m.value -> 'content' ELSE '[]' END) p
      WHERE m.value ->> 'role' IN ('user', 'toolResult') OR p.value ->> 'type' NOT IN ('thinking')) AS n
    FROM entries e WHERE e.conversation_id = 1 AND e.record ->> '$.kind' IN ('pi.user', 'pi.assistant', 'pi.tool-result') ORDER BY e.id`).all();
  const sql = t() - s; s = t();
  const all = pi.prepare("SELECT record FROM entries ORDER BY id").all().map((row: any) => JSON.parse(row.record));
  console.log(`pi sql count ${sql.toFixed(0)} ms (${rows.length} rows, ${rows.reduce((n: number, row: any) => n + row.n, 0)} counted); JS parse ${(t() - s).toFixed(0)} ms (${all.length})`);
}
