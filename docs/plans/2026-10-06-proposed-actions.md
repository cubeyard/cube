# Proposed actions: OptChat prepares, the user confirms

Status: proposal only. Nothing here is implemented. OptChat cannot change
projects, runners, models or settings today.

## Question

Could OptChat do admin work, such as adding a project, by preparing a
confirmation with everything filled in, so that the user only approves it?

## What exists today

- **Project API** (`packages/server/src/index.ts`): `GET /api/projects`,
  `POST /api/projects {name, repositories[], hooks?}` (create, then check),
  `PUT /api/projects/<id>` (replace; `revision` goes up), `DELETE
  /api/projects/<id>`, `POST /api/projects/<id>/check`. A check reads each
  repository with the host's GitHub credentials. New threads clone the
  repositories into their machines and run the project's pre-setup and
  pre-resume hooks inside each new thread machine, as the guest user `agent`.
- **OptChat** can read projects (`projects`), but cannot write them. Its only
  writes are to its own threads (`spawn`, `tell`, `archive`) and its own task
  list (`task`).
- **Precedent:** retiring a runner already needs a confirmation bound to the
  object. The request must carry `confirm: <nodeId>`. It fails closed if the
  runner reports an active machine.
- **Authorization:** cubed has no user authentication. Anyone who can reach
  it can already `POST /api/projects`. HTTP host and origin checks block
  cross-site requests. They do not authenticate a person.

## Principles

1. **A confirmation is not authorization.** A button only guards against the
   model's mistakes and against instructions smuggled in through a thread
   report or a web page. It does not stop anyone who can reach cubed. Access
   control stays at the network boundary, as AGENTS.md requires.
2. **The user approves the exact action.** cubed renders the card from the
   stored payload, not from the model's words: the action kind and target,
   every field, and its consequences. Approval names the payload's digest.
   cubed runs the stored payload only if the digest still matches. Nothing
   the model writes after the proposal can change what runs.
3. **Scope and consequences are stated.** For example: "installation-wide:
   every new thread can use this project"; "cubed reads these repositories
   with the host's GitHub login"; "these hooks run as `agent` in every new
   thread machine of this project"; "this replaces revision 4".
4. **Approval is checked again before anything runs.** It is refused if the
   proposal has expired (15 min) or was already decided. It is also refused
   if a stored condition no longer holds: no project with that name for a
   create, the same `revision` for an update. A proposal runs at most once.
   A retried approval returns the first result.
5. **The model cannot approve.** No tool approves anything. The only path is
   an HTTP route that the UI calls after a click.
6. **Small, read-back-able kinds first.** Start with `project.create`.
   Deleting projects, discarding disks and retiring runners stay where they
   are, with their typed confirmations.

## Smallest next step (`project.create` only)

- `cube.optchat.proposals`: a doc in OptChat's Pi store. Each entry holds
  `{id, kind, payload, conditions, digest, origin (the tool call), created,
  expires, state: proposed|approved|rejected|expired|applied|failed,
  result}`. The payload is the normalized `POST /api/projects` body: URLs go
  through `normalizeRepoUrl`, and checkout names and hook text are given in
  full. The digest is SHA-256 over the canonical JSON of kind, payload and
  conditions.
- OptChat tool `propose_project({name, repositories, hooks?, why})`. It
  validates with the same code as the route but writes nothing, then stores
  the proposal. It answers "proposed p3; waiting for the user". `why` is
  shown separately, labelled as OptChat's words.
- `GET /api/optchat/proposals` lists the open ones.
  `POST /api/optchat/proposals/<id> {decision: "approve"|"reject", digest}`
  runs the checks in principle 4. It then calls the same project-creation
  code the route uses. It records the result and sends it to the chat once,
  as `[proposal p3] applied: project demo created, check: ready`.
- The card in the now panel shows the kind, the target and every field. Hook
  text is shown in full and folded. It shows the consequences, the expiry
  and the digest's first 12 characters. Keys: `approve` and `reject`.
- Tests: digest mismatch, expiry, a project of that name created meanwhile,
  a double approve (one creation), a reject, no approve tool in the model's
  tool list, and a thread report asking for a proposal still needs a click.
