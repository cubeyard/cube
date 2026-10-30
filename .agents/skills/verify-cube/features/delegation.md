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

- **Spawn.** In `#/chat` send `tool {"name":"spawn","args":{"tasks":[{"project":"demo","task":"tool {\"name\":\"bash\",\"args\":{\"command\":\"echo spawned-<token>\"}}"}]}}`, with a token new to this run. The reply reads `result: [<id>] accepted in demo: …` with the token; the journey keeps `<id>`, the thread's 8-character short id. Captured as `01-accepted`.
- **Margin.** The region `threads and artifacts from this chat` has a button for the thread, its name containing the token and ending `· demo`.
- **Report.** Wait for the report row, `details.report > summary` with `aria-label` `report from <thread name>, turn ended: result: spawned-<token> …`. Captured as `02-report`.
- **Proof.** `threads.json` (`/api/threads`) has exactly one thread whose id starts with `<id>`, in `demo`, titled with the task; `optchat-history.json` holds `[<id>] ended its turn; nothing of it runs now: result: spawned-<token>`.

Run: `.agents/skills/verify-cube/verify-cube run spawn`.

## Gotchas

- The thread's task reaches its model with cube's thread note after it; the faux model reads the `tool …` line, not the last line.
- The report is a `details` element: `getByRole("group", { name })` does not find it by its summary's label; select the summary.
- After the report OptChat answers it (`ok: [<id>] ended its turn …`); that answer is the faux model's echo, not a check.
