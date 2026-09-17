# cube

Self-hosted coding-agent threads. The browser talks to cubed; an in-process
[Pi AgentHarness](https://github.com/earendil-works/pi) owns the agent loop and
durable SQLite session. Tools run on an explicitly enrolled Iroh runner.
Closing the tab or restarting cubed does not discard accepted work.

**Experimental software. Current runners execute trusted commands under their
own account, without sandboxing.** Native platform-appropriate sandboxing is
undecided. Use a separate unprivileged account or machine without valuable
credentials. Do not run untrusted repositories or commands under your own account.

## Run from source

Requires Node 26+, the pnpm version in `package.json`, Git, and a configured
model provider. Rust is needed when building the runner.

```sh
pnpm install --frozen-lockfile
pnpm build
CUBED_STATE="$HOME/.cube-host" pnpm cubed
```

cubed defaults to loopback port 7777. Use your local browser, an authenticated
access proxy, or [configured private Tailscale access](DEVELOPING.md#product-development)
with `CUBED_HOST` and `CUBED_ALLOWED_HOSTS`; cubed itself has no user authentication.
GitHub login is available in the UI. Open **models** to connect model providers using Pi's supported
browser/device login or API-key prompts, check connection status, or disconnect.
Credentials and configuration use Pi's `~/.pi/agent` directory (or
`PI_CODING_AGENT_DIR`); the CLI is not a prerequisite. Catalog changes take effect
without restarting cubed, and existing threads keep their selected model.

Create a project, prepare its workspace on a trusted runner, then enroll that
runner using [the operator runbook](docs/trusted-runner-operations.md). Starting a
thread consumes one unused runner binding. Each runner currently serves exactly
one thread; there is no automatic fleet provisioning. The UI supports prompts,
streamed results, reconnect, model selection, stop, rename and archive.

The current tool is bounded `bash`. Workspace transfer, authenticated Git writes,
service links, thread-to-thread tasks and native sandboxing are not yet exposed
by this implementation. Project repository checks remain host-side; they do not
claim to prepare the runner workspace.

## Fresh state, not migration

Old sessions and registries are **not migrated**. Use a fresh `CUBED_STATE`
directory. For a fresh start, stop cubed and choose a different empty directory;
create projects and enroll fresh runner identities. This does not erase old
installations or runner workspaces. Never copy a live Pi session into two hosts:
each session requires one writable owner.

See [DEVELOPING.md](DEVELOPING.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Apache-2.0; dependencies retain their [notices](THIRD_PARTY_NOTICES.md).
