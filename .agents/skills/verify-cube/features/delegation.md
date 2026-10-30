# Delegation

OptChat starts threads for the user with its `spawn` tool, answers each thread's id at once, and receives each thread's report back in the chat when the thread's turn ends. The thread shows in the chat's margin.

## Sub-features

- `spawn-accept` answers `[id] accepted in <project>` at once.
- `spawn-report` brings the thread's report back into the chat.
- `spawn-margin` lists the thread in the chat's margin.

## How to get to it (user POV)

- Ask OptChat for work in a project; it decides to spawn. Here the faux model is told to.

## Driving it with verify-cube

Preconditions:

- `doctor` is all `ok:`; the seeded project `demo` is ready.

- **Spawn.** In `#/chat` send `tool {"name":"spawn","args":{"tasks":[{"project":"demo","task":"tool {\"name\":\"bash\",\"args\":{\"command\":\"echo spawned-<token>\"}}"}]}}`, with a token new to this run. The reply reads `result: [<id>] accepted in demo: …`. Captured as `01-accepted`.
- **Report.** Wait for the report row, `details.report > summary` with `aria-label` `report from <thread name>, turn ended: result: spawned-<token> …`. Captured as `02-report`.
- **Proof.** `threads.json` (`/api/threads`) lists the thread in `demo`; `optchat-history.json` holds the report.

Run: `.agents/skills/verify-cube/verify-cube run spawn`.

## Gotchas

- The thread's task reaches its model with cube's thread note after it; the faux model reads the `tool …` line, not the last line.
- The report is a `details` element: `getByRole("group", { name })` does not find it by its summary's label; select the summary.
- After the report OptChat answers it (`ok: [<id>] ended its turn …`); that answer is the faux model's echo, not a check.
