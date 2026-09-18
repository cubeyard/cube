# cube

Self-hosted coding-agent threads. The browser talks to cubed; an in-process
[Pi AgentHarness](https://github.com/earendil-works/pi) owns the agent loop and
durable SQLite session. Tools run on an explicitly enrolled Iroh runner.
Closing the tab or restarting cubed does not discard accepted work.

**Experimental software. Current runners execute trusted commands under their
own account, without sandboxing.** Native platform-appropriate sandboxing is
undecided. Use a separate unprivileged account or machine without valuable
credentials. Do not run untrusted repositories or commands under your own account.

## Laptop-first quickstart

Requires Node 26+, the pnpm version in `package.json`, Git, and a configured
model provider. Rust is needed when building the runner.

```sh
pnpm install --frozen-lockfile
pnpm build
cargo build --locked -p cube-runner

# after one-time runner initialization and enrollment (linked below):
target/debug/cube-runner run --home "$HOME/.cube/runner"
# in a second terminal:
pnpm cubed --state "$HOME/.cube-host"
```

Both programs are ordinary foreground processes. They create no systemd or
launchd service, do not auto-restart, and stop when their terminal or laptop
stops. The runner truthfully reports `network ready / waiting for cubed`; Cube
does not maintain a permanent runner connection. Check enrolled runners with
`pnpm cubed runners status --state "$HOME/.cube-host"`.

On the first Ctrl-C, the runner drains and waits for its one active command. A
second Ctrl-C records a controlled `CANCELLED` result. Cubed closes admission and
its durable owners cleanly on SIGINT or SIGTERM. Restart both against the same
state to reconcile accepted work; neither component blindly replays a command.

Cubed defaults to loopback port 7777. `cubed --help` documents `--state`,
`--host`, `--port`, repeatable `--allowed-host`, and `--log-level`; the existing
`CUBED_*` variables remain supported and flags take precedence. Use your local
browser, an authenticated access proxy, or
[configured private Tailscale access](DEVELOPING.md#product-development)
with `CUBED_HOST` and `CUBED_ALLOWED_HOSTS`; cubed itself has no user authentication.
GitHub login is available in the UI. Open **models** to connect model providers using Pi's supported
browser/device login or API-key prompts, check connection status, or disconnect.
Credentials and configuration use Pi's `~/.pi/agent` directory (or
`PI_CODING_AGENT_DIR`); the CLI is not a prerequisite. Catalog changes take effect
without restarting cubed, and existing threads keep their selected model.
Managed binary installations also expose **system**, where an operator can check
for and install signed cubed releases. Browser updates are opt-in and never update
runners. Source checkouts and externally managed installations remain read-only;
see [the cubed update runbook](docs/cubed-updates.md).
Optional JEV memory is configured separately at the top of **models**. It is
strictly off until a JEV key is saved there; Cube then uses JEV to retain useful
thread notes and select compact, recallable views of large tool output.

Create a project, prepare its repository template on a trusted runner, then enroll
that runner using [the operator runbook](docs/trusted-runner-operations.md). A
runner serves one active thread at a time in a separate Git worktree (or a
non-Git copy fallback); archiving releases that capacity. There is no automatic
fleet provisioning. The UI supports prompts,
streamed results, reconnect, model selection, stop, rename and archive.

This is workspace collision isolation only, not process or security isolation.
The current tool is bounded `bash`. Workspace transfer, authenticated Git writes,
service links, thread-to-thread tasks and native sandboxing are not yet exposed
by this implementation. Project repository checks remain host-side; they do not
claim to prepare the runner workspace.

**A laptop runner under your login UID can read everything that UID can read,
including SSH, cloud, browser, Git and provider credentials. It is not a
sandbox.** Use a separate credential-free account or machine for stronger
separation. The optional systemd/launchd server profile is documented in the
operator runbook; it is never installed by the direct flow.

## Fresh state, not migration

Registry v100 is upgraded in place for reusable runner allocations; older
registries and execution stacks are **not migrated**. For a fresh start, stop
cubed and choose a different empty `CUBED_STATE` directory;
create projects and enroll fresh runner identities. This does not erase old
installations or runner workspaces. Never copy a live Pi session into two hosts:
each session requires one writable owner.

See [DEVELOPING.md](DEVELOPING.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Apache-2.0; dependencies retain their [notices](THIRD_PARTY_NOTICES.md).
