# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a developer who self-hosts cube on a VM they own and drives coding
agents from a browser. They are technically fluent — they installed Incus, ran
`pi` to log in a provider, and reach the daemon over their own Tailnet — so the
interface may assume command-line literacy, but not familiarity with cube's own
internals.

The situation is asynchronous and interstitial: start a thread, leave, come back
to a result. The job is "give an agent an isolated machine, a task, and see what
it did" — not "manage containers".

Cube is released for other self-hosting developers, not only its author. First
run, setup legibility, and honest failure states are durable product concerns:
the person on the other end of a broken state has no context from this repo.

## Product Purpose

Cube is a self-hosted equivalent of Amp Orbs. The control plane owns the
conversation; each thread is permanently bound to one environment on one
execution node. Local Incus threads provide an isolated machine with
docker-in-docker and portals. The optional remote trusted-host profile instead
runs under a dedicated unprivileged Linux account and is explicitly not
sandboxed. In both profiles, agent harness credentials and history stay on the
control plane.

Success is that a developer can hand a task to an agent, close the tab, and come
back to trustworthy work and a legible account of what changed — without ever
thinking about the container underneath.

## Positioning

Three claims a neighboring product could not truthfully copy:

- **Harness outside the sandbox.** The agent loop, provider credentials, git
  credentials, and thread history live on the host; the sandbox only ever
  contains code and processes, never secrets. Prompt injection cannot reach
  what the agent was never given. This is also what makes container-grade
  isolation an acceptable trade instead of VM-grade.
- **No KVM required.** Unprivileged Incus system containers with nesting run on
  ordinary cloud VMs, not just bare metal — so self-hosting is not gated on
  nested virtualization the host may not offer.
- **One VM you own.** No clustering, no multi-tenancy, no shared team platform,
  no per-minute billing. The state of record is directories and files on the
  user's own machine.

## Operating Context

- **Desktop browser is the workplace.** The global thread list, project
  switchboard, and thread view are used on a full-size screen over a
  Tailnet-reachable daemon on port 7777.
- **Phone is a check-in surface.** It must be usable and unbroken — a running
  thread must be readable and answerable from a phone — but mobile does not
  drive layout decisions.
- **Sessions are long and interrupted.** Threads outlive the tab. Cubes sleep
  after 1h idle and wake on demand, so a returning user routinely lands on a
  thread whose environment is not yet awake.
- **Nothing is instant.** Creating a thread provisions a container; waking one
  restarts services. Waiting is a normal state, not an error, and the product
  distinguishes the two.

## Capabilities and Constraints

**Terminology — load-bearing.** The user-facing unit is the **thread**: one
thread per cube, cubes 100% invisible. No cube names, no cube management UI, no
cube-vocabulary statuses in anything the user sees. Creating a thread silently
allocates and provisions a backing cube; deleting a thread destroys it. Thread
states read as thread states — `setting up`, `ready`, `sleeping`, `error` — never
as container states. The cube-centric API routes that still exist are admin
plumbing, not product.

**Execution binding and availability.** A thread never changes environment or
node, including after failure or prolonged disconnection. Conversation access is
independent of environment contact. Offline environment work is rejected, not
queued; a confirmed missing environment is an error, not a replacement request.
Working on another node requires a new thread. The supported remote profile is
trusted Linux x86_64 host execution over authenticated Iroh/N0 relay, with
bounded durable exec and no filesystem, portal, provisioning or migration RPCs.
Browser access remains within the existing private boundary.

Confirmed today:

- Every thread belongs to exactly one project. There is no projectless thread
  path or repo-per-thread compatibility path.
- Project list and project switchboard: create, edit, delete, and re-check a
  project before work starts. A project owns one primary repository and any
  number of additional repositories.
- Repository checks verify host access and base configuration up front. A
  thread can start only from a ready project. Each new creation refreshes all
  repository default branches (including references), then pins their exact OIDs
  before allocating an environment. Fetch failures stop creation, never fall
  back to the checked snapshot. Existing threads and idempotent replays retain
  their original pins; provisioning itself does not fetch.
- The thread list is global across all projects, defaults to `all projects`,
  prints project attribution on every row, and supports a URL-backed project
  filter.
- Thread create, open, rename, and delete. Creation chooses a ready project;
  the writable primary checkout is `/workspace`, with read-only reference
  checkouts at `../repos/<checkout-name>` (guest paths
  `/repos/<checkout-name>`).
- The thread view is Cube's native web conversation: a durable transcript,
  browser-native selectable text, and a multiline composer. Cube accepts and
  records each turn before starting a replaceable Pi worker.
- Primary-repository review in the thread view: inspect committed, staged,
  and unstaged changes. Publication is requested directly through the agent;
  there is no dedicated publish button or automatic runbook. Host-scoped tools
  provide authenticated Git/PR operations for the primary only, without exposing
  credentials to the sandbox. Reference repositories cannot be changed or published.
- Primary-workspace file listing and disk usage, plus links to declared
  services.
- Provider auth state surfaced from the host (`pi` owns login; cube only
  reports it — signed out is fixed by running `pi` on the host, not in the UI).
- History survives daemon restarts because SQLite, not a Pi session file, is
  authoritative. Interrupted runs are shown as failed and are never replayed
  automatically.

Constraints:

- Svelte 5 + Vite SPA in `packages/web`, hash routing, token-based CSS in
  `app.css`. Node backend packages carry no UI.
- pi owns each agent loop, compaction within a run, provider auth, and the model
  catalog. Cube owns thread identity, accepted turns, transcript persistence,
  run lifecycle, HTTP API, and UI. A Pi process is a disposable worker hydrated
  from the Cube transcript, never the thread's source of truth.
- No authentication in front of the daemon or portals — the Tailnet is the
  boundary. The UI must not imply a login or account model it does not have.
- Deliberately out of scope: multiplayer, team platform, clustering, Slack,
  webhooks from the internet, unrestricted sub-agent messaging, and a separate
  general-purpose shell outside the pi TUI. Explicitly authorized, directed
  thread-to-thread tasks are the narrow shipped exception; see
  [the task protocol plan](docs/plans/thread-to-thread.md).

Undecided:

- Search, sort, and pagination remain deferred until the global list grows past
  the scale where project filtering is enough.
- The visible checked time describes project preflight, not the revisions of
  later threads. Each new thread independently fetches the current remote defaults.

## Brand Commitments

- **Name:** cube, lowercase.
- **Mark:** the existing wireframe cube glyph used as favicon and wordmark on
  both screens.
- **Design reference — binding.** Dieter Rams / Braun is the design north:
  the user's stated design idol. UI decisions cite Rams-era Braun hardware
  grammar (machined panels, control banks, hairline divisions, restrained
  color, "Weniger, aber besser"). When torn between renditions, choose the
  quieter, more machined one — Braun restraint, never TE playfulness.
- **Voice — binding.** Lowercase controls (`new thread`, `working`). Plain
  sentence case for prose. No marketing register anywhere in the product. Error
  and empty copy states what actually happened and what to do about it —
  "not signed in — run `pi` on the host" is the model, not an exception.
  Honesty over reassurance: delete confirmation says what does and does not get
  removed.

## Evidence on Hand

There is no docs site, hosted demo, documented adoption, benchmark, or press
coverage yet.

Future work must not fabricate testimonials, customer names, usage statistics,
pricing, or performance claims. `ARCHITECTURE.md` and `HANDOFF.md` are the internal
record of what is real; screenshots of the running daemon are the only product
imagery that exists.

## Product Principles

1. **The thread is the product; the cube is plumbing.** If a screen makes the
   user think about containers, it has failed.
2. **Projects define trusted inputs.** Repository access, branches, checkout
   names, and exact base revisions are settled before a thread can exist.
3. **Waiting is a state, not a failure.** Provisioning, waking, and sleeping get
   first-class, calm treatment — never the error styling.
4. **Say what actually happened.** Failures name the real cause and the real
   next action, including when the fix lives on the host, outside the UI.
5. **Leverage pi maximally.** Do not build what the harness already owns; design
   around its capabilities rather than reimplementing them.
6. **Someone else runs this.** Every state must be legible to a self-hoster who
   has never read this repo.

## Accessibility & Inclusion

Committed floor: full keyboard reachability with visible focus, and honor
`prefers-reduced-motion`. Both are already implemented in `app.css` and must
survive future work.

WCAG AA contrast is explicitly not a commitment — the muted palette is a
deliberate identity choice. No formal standard beyond the floor above.
