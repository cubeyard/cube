# Working on cube

Read README.md, ARCHITECTURE.md, PRODUCT.md, DESIGN.md, HANDOFF.md and
DEVELOPING.md before changing behavior.

## Ownership

- `packages/server`: product API, projects, runner admission and activation.
- `packages/server/src/durable-agent.ts`: in-process Pi AgentHarness + published
  SQLite backend. Pi owns execution state; never add a second workflow journal.
- `packages/node-transport`: Linux/macOS trusted runner and Iroh protocol.
- `packages/git`: host-side repository capabilities; credentials stay here.
- `packages/web`: Svelte 5/Vite UI, built to `packages/web/dist`.

Current runners are **not sandboxes**. Native isolation remains undecided. Never
invent an optional legacy backend or local execution fallback. One session has
one writable owner; preserve lifetime locking and stable invocation identity.

## Development

Node ≥26, pnpm pinned in package.json, Rust pinned in rust-toolchain.toml.
`bash scripts/setup-dev.sh` bootstraps a Linux development account. Run
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. New offline Node tests
belong in `scripts/test-offline.sh`. Runner changes also need
`bash scripts/test-node-transport.sh`; mocks are not runner acceptance.
Inspect rendered UI at desktop/phone sizes for appearance changes.

`repos/` contains pinned upstream reference snapshots, not application code.
Use published package imports; do not modify upstream snapshots except for
explicit upgrades. Read `repos/effect/LLMS.md` before writing Effect code and use
the pinned v4 APIs. For Pi study the matching AgentHarness/session sources.
Upgrade consuming pins, lockfile and reference subtree together, update
`repos/README.md`, then run `pnpm check:references`.

## Guardrails

- Never push to main, tag, deploy or release without explicit authorization.
- Never commit credentials, private runner configuration, model auth or runtime
  state. For maintainer commits use Didrik A. Rognstad
  <3679075+dizk@users.noreply.github.com>.
- Never operate on other people's threads or shared data for tests. Use
  disposable state. A fresh schema does not authorize wiping a live installation.
- Keep cubed private: loopback, an authenticated proxy, or an explicit
  access-controlled private-network binding. It has no application-level user
  authentication; HTTP host validation does not replace network access controls.
- Never call trusted same-UID runner execution sandboxed. Keep runner accounts
  separate from host/provider/Git/cloud credentials.
- English in repository files; calm lowercase user copy and thread vocabulary.

Old registries are not migrated. The explicit reset workflow selects a new
`CUBED_STATE` directory; see DEVELOPING.md. Preserve Linux/macOS runner lifecycle,
retained operation evidence and backup quarantine when changing architecture.
