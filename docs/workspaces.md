# Workspaces

A workspace is what a project was: a name, up to 20 repositories, external
hooks and a machine size, under the same id. What is new is that each
workspace has its own chat, and that chat is the only thing that starts
threads there for the user. Memory, reports and context of one workspace
do not reach another.

A workspace is a way to keep work apart, not access control. cubed has one
user and no login; anyone who can reach it can read every workspace.

| | |
| --- | --- |
| workspace : chat | one each |
| thread : workspace | exactly one, for good (`thread.project_id`) |
| chat : threads | the ones it started, all in its own workspace |

The registry is unchanged on disk: the table is still `project`, the column
`project_id`, and `user_version` is the same. `archivedAt` in the row's JSON
is the only new field. In code and in a thread machine "workspace" also still
means a thread's checkout (`/workspace`, `workspaceState`, `workspace-lease.ts`);
the docs call that the checkout.

## Where a chat lives

```text
<CUBED_STATE>/
  optchat/                    the chat from before workspaces: kept as it was, never opened again once copied
  workspaces/
    migration.json            what the migration did
    <workspace id>/chat/      that workspace's chat store (pi.sqlite, media/, AGENTS.md, skills-section.json)
  artifacts.sqlite.before-workspaces   only if the migration deleted artifacts
```

A store is bound to its workspace in its `cube.optchat` document
(`workspace`) at its first open. A store bound to another workspace, or one
with a chat in it and no binding, is refused before anything is written
(`optchat.ts`). Each store has its own identity (`cache`), which names its
prompt cache and the request keys of its artifact and hook calls.

`workspace-chats.ts` holds the open chats by workspace. Every workspace that
is not archived has its chat open from the start of cubed, because a
thread's report needs its chat open. The user's instructions are per chat:
`workspaces/<id>/chat/AGENTS.md`.

## What a chat reaches

`workspaceThreads` wraps everything a chat can do to threads, so the limit
does not rest on the chat's own records:

| tool | in a workspace's chat |
| --- | --- |
| `spawn` | takes no `project`; the thread starts in the chat's workspace, whatever the call names |
| `projects` | describes this workspace only |
| `tell`, `history`, `diagnose`, `archive`, `threads` | a thread of another workspace is no thread |
| `project_hooks`, `project_hooks_write` | take no `project`; this workspace's hooks |
| `usage` | this workspace, or one of its threads |
| artifacts | written for this workspace; reads this workspace's artifacts |

A thread reads the chat of its own workspace: its start view is frozen from
it, and `memory_zoom` and `memory_date` read it live. `thread_history`
reads threads of the same workspace, as before.

A new thread's task ends with a note that it was started by its workspace's
chat. Threads started earlier keep their prompts.

## From one chat to many

cubed migrates once, when it starts, before any chat opens
(`workspace-migration.ts`). Every workspace that exists then gets a copy of
the whole old chat: log, summaries and images. A workspace made later starts
empty; that is how to get a chat without the past.

1. Write `migration.json` with the ids of the workspaces that exist, state
   `copying`. A later run uses this list, so a workspace made meanwhile gets
   no copy.
2. For each of them without a chat directory: copy `pi.sqlite` with SQLite's
   backup, and the store's files, into a temporary directory beside the
   target.
3. In the copy, in one commit: bind it to the workspace, give it a new
   identity, record `copiedFrom` (the old identity, the time, the old
   chat's usage so far) and keep only this workspace's threads in its
   thread list. Then rename the directory into place.
4. If the old chat wrote artifacts for no project: copy `artifacts.sqlite`
   to `artifacts.sqlite.before-workspaces` (never replaced), then delete
   those artifacts with their revisions, comments and notices.
5. Set `migration.json` to `done`.

The copy is refused while the old chat has a message waiting or a turn under
way. cubed then opens the old chat once more and lets it finish, for at most
five minutes (`MIGRATION_IDLE_MS`). A request that was out when cubed last
stopped is dropped at that open, as after any stop, so a turn cut off by the
restart does not hold the migration up. If the chat is still working when
the wait ends, it is closed, no workspace chat opens, and every chat route
answers 503 with the reason; `GET /api/workspaces` says so in `chats`.
Nothing is retried in that process. The next start tries again.

The old chat's `close()` is bounded and may return with its Harness still
closing. The copy is taken only once that chat has let go of its store
(`OptChat.released`), waited for at most 20 seconds. If it still holds the
store then, nothing is copied, chat routes answer 503 with that reason, and
this one failure is tried again in the same process: once the old chat has
let go, the next chat request or the recovery loop runs the migration. A
copy is never taken of a store that a chat in this process can still write.

Every step reads what exists and does what is missing:

| stopped | next run |
| --- | --- |
| before `migration.json` | starts over |
| during a copy | deletes the temporary directory and copies again |
| after some copies | keeps finished copies, makes the rest |
| after the artifact backup, before the deletion | keeps the backup, deletes |
| after `done` | does nothing |

What the copies need, and why:

| | without it | so |
| --- | --- | --- |
| thread list | every copy would watch every thread, and a report would arrive once per workspace | each copy keeps its own workspace's threads |
| identity | the copies' artifact and hook request keys would collide | a new identity per copy |
| frozen thread memory | a thread started before the copy names the old identity | a chat accepts its `copiedFrom` identity; message ids up to the copy are the same |
| usage | the past would be counted once per workspace | a chat reports usage since its copy; the old chat's is reported once, as before workspaces |
| reports already taken | | their request ids are in every copy, so none is taken again |

Each workspace's chat starts with the whole past, including what was about
other projects. Links in it to threads of other workspaces still open those
threads where they live.

### Going back

An older cubed opens `optchat/` as it was before the migration. It knows
nothing of what was said in the workspaces' chats afterwards, nor of the
threads they started (it does not watch them and gets no reports from
them). The chats of the workspaces stay on disk. Artifacts written by a
workspace's chat have an author (`optchat:<workspace id>`) an older cubed
does not understand. Going back is a way to recover, not to continue.

## HTTP

| route | |
| --- | --- |
| `GET/POST /api/workspaces`, `GET/PUT/DELETE /api/workspaces/<id>`, `POST …/check` | as `/api/projects` was; the list also has `chats: {state: preparing, ready or failed, error}` |
| `POST /api/workspaces/<id>/archive`, `…/unarchive` | below |
| `GET /api/workspaces/<id>/chat/history`, `…/stream`, `…/view`, `…/threads` | that workspace's chat; `view` has `welcome` for an empty chat |
| `POST …/chat/prompt`, `…/chat/stop`, `GET/PATCH …/chat/model`, `…/chat/media` | |
| `GET /api/threads?workspace=<id>` | each row has `workspace: {id, name}` |
| `GET /api/artifacts?workspace=<id>`, `GET /api/usage?workspace=<id>` | the workspace's newest 200 artifacts, chosen before the limit |

The server keeps no choice of workspace per client. To switch, a client
closes one `EventSource` and opens another.

A new workspace's chat is empty. `view` gives the fixed text `what do you
want to build?` as `welcome`; no model is called and the text is not in the
chat's log.

### Routes from before workspaces

They stay for the current web UI and go with it.

| route | now |
| --- | --- |
| `/api/projects…` | the same resource as `/api/workspaces…`, with `project` and `projects` as keys |
| `/api/optchat/…?workspace=<id>` | that workspace's chat, exactly as `/api/workspaces/<id>/chat/…` |
| `/api/optchat/…` without `workspace` | the only open workspace's chat; with several, 409; with none, 404 |
| `POST /api/threads` | starts a thread in `projectId` as before: no chat started it, so it reports to none |
| `project` on a thread row, `?project=` on usage | the same as `workspace` |

None of them reaches further than the new routes: a chat is always one
workspace's own, and an archived workspace refuses writes through either.

The web UI's chat page picks a workspace when there are several (the oldest
at first) and remembers it in the browser. A change mounts the chat page
anew; nothing is reloaded.

## Archive

`POST /api/workspaces/<id>/archive` is refused while the workspace has an
open thread. It and thread creation run in one `BEGIN IMMEDIATE`
transaction each, so the first wins: a thread accepted first makes the
archive fail, and after the archive no thread is accepted (from the chat or
`POST /api/threads`). The chat is closed. Its history, view and threads
stay readable: a read opens the store with nothing running (no turn, no
summary, no watcher) and it takes no message. A store has one owner at a
time: the chat that is closing stays its owner until it has let go of the
store, which is when its Harness has closed (`OptChat.released`), not when
its `close()` returns: that is bounded and may return first. A read, a
restore or a reopen that arrives meanwhile waits for the release, then
looks at the workspace again. After 20 seconds (`RELEASE_WAIT_MS`) it is
refused with 503 instead, and the store stays its last owner's; cubed's
recovery loop opens the chat once that owner is gone. An open that
fails counts the same: it has had the store, closes what it opened, and may
still hold it after it has rejected. Its error says when the store is let
go (`releasedAfter`), and until then a retry is refused and opens nothing. An archive or a
restore itself returns when the close does. `unarchive` opens the same
store for work again. A workspace is deleted only without thread history,
as a project was; its chat store goes with it. If its closed chat still holds the store, the
directory is removed when that chat has let go (if cubed stops first, it
stays on disk under an id that is not used again).

## Usage

A workspace's report (`?workspace=`) has its threads and its chat since the
copy. The report of everything adds every chat and, as `beforeWorkspaces`,
what the one chat had used until it was copied. `chats` lists each
workspace's chat apart. An archived workspace's chat is read from its
store, so its usage is its final usage whether or not it was read before.
A summary request that was out when the old chat's process stopped is
counted in the copy before the usage every copy starts from is read: once,
before workspaces, and by no workspace again.

## Costs

Measured once in a thread machine (2 vCPU) with the real migration on
synthetic chats and four workspaces; a faux model, so no provider time.
Memory is the process's resident size after a collection, before and after
the opens, so it is approximate. The size of a real installation's chat was
not read: multiply by its own.

| per workspace | 200 messages (2.7 MiB store) | 3,000 messages (48 MiB store) |
| --- | --- | --- |
| copy and bind, once | 10 ms | 89 ms |
| open at start | 20 ms | 246 ms |
| memory while open | about 2.5 MiB | about 32 MiB |
| disk | 2.7 MiB | 48 MiB |

Disk and memory grow with the number of workspaces that got a copy. Each
chat's turn starts with its own view (64 to 128 KB), as the one chat's did.
Each chat runs up to eight compactor jobs; there is no limit across chats.
The runner pool is shared, with no limit per workspace.

## Known risks

- The first turn of each copied chat writes its prompt cache anew (a new
  identity and tool list).
- A workspace's chat may still hold lines about other projects from before
  the copy.
- The old chat's artifacts for no project are deleted. They are in
  `artifacts.sqlite.before-workspaces`; links to them in the chat are dead.
- A workspace with no chat yet needs a model provider to open one, as the
  one chat did.
- With no workspace there is no chat: the web UI's home shows an error
  until one is made.
