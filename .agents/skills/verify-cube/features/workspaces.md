# Workspaces

A workspace (a project) has its own chat. A message, a spawned thread and its report stay in the chat of the workspace they belong to, and the chat page switches between workspaces.

## Sub-features

- `workspace-new` makes a workspace whose chat is empty, with the fixed welcome.
- `workspace-pick` switches the chat page to another workspace's chat.
- `workspace-spawn` starts a thread in the chat's own workspace, with no project named.
- `workspace-apart` keeps each chat's messages and reports out of the other.

## How to get to it (user POV)

- With more than one workspace, `#/chat` shows a `workspace` picker above the chat.

## Driving it with verify-cube

Preconditions:

- `doctor` is all `ok:`; the seeded workspace `demo` is ready.

- **New.** `POST /api/workspaces` with the seeded repository makes `second-<token>`, ready. `GET /api/workspaces/<id>/chat/view` reads `messages: 0` and `welcome: "what do you want to build?"`.
- **Demo.** In `#/chat` choose `demo` in the picker and send `hello only-demo-<token>`. Captured as `01-demo`.
- **Switch.** Choose the second workspace: the page shows its empty chat with the welcome, without demo's message. Send `hello only-second-<token>`, then a `spawn` with no project. The reply reads `[<id>] accepted in this workspace`, and the report `turn ended: result: spawned-<token>` comes back. Captured as `02-second-report`.
- **Proof.** `threads-second.json` (`/api/threads?workspace=<second>`) has the thread; demo's list does not. `chat-demo.json` holds only demo's message; `chat-second.json` holds the second's message and the report.
- **Back.** Choose `demo`: its message is there, nothing of the other workspace's thread. Captured as `03-back-in-demo`.

Run: `.agents/skills/verify-cube/verify-cube run workspaces`.

## Gotchas

- The picker stores the choice in the browser's `localStorage` and the chat page mounts anew for that chat, without a page load; wait for that chat's own content (the welcome, or one of its messages) before reading it.
- Archiving, the migration from one chat and its idle wait are not driven here: `packages/server/test/workspace-migration-test.ts` and `workspaces-api-test.ts` cover them.
