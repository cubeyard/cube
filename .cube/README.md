# Development environment

`setup` installs native build dependencies, the Node version from
`scripts/vm/build-app.sh`, pnpm from `package.json`, and the Rust toolchain from
`rust-toolchain.toml`, then runs `pnpm install --frozen-lockfile`. Rust 1.90.0 is
an initial development pin, not yet a validated iroh dependency requirement.
Node and Rust are installed under the guest user's home; login shells load the
managed PATH snippet. Native packages use the guest's passwordless sudo.

Supported setup targets: Linux x86_64 and aarch64. No daemons, services, model
credentials, or GitHub credentials are installed. No resume script is needed.
`cube.toml` adds only Node/Rust distribution and Cargo registry hosts. This does
not configure iroh relays or prove external QUIC connectivity.

Changes apply to new threads after publication and project re-check. In an
existing writable environment, setup retry currently rereads the declaration
and applies it before running setup; merging alone does not update existing
threads. See the open agent-editable-egress security follow-up in `HANDOFF.md`.

Validation in the disposable Linux x86_64 development environment:

- Initial setup: 92.650 s; warm retry: 2.037 s, both succeeded.
- Resume lifecycle without a script: succeeded (60 ms on warm retry).
- Fresh noninteractive login shell: Node 26.8.1, pnpm 10.34.5,
  rustc/Cargo 1.90.0, GCC 13.3.0 and OpenSSL development metadata available.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` passed.
- `cube.services.ensure()` returned no services (none declared).
- aarch64 setup and real iroh transport have not been tested.
