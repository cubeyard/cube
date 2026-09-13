# Development environment

`setup` installs native build dependencies, the Node version from
`scripts/vm/build-app.sh`, pnpm from `package.json`, and the Rust toolchain from
`rust-toolchain.toml`, then runs `pnpm install --frozen-lockfile` and
`cargo fetch --locked` when Cargo.lock exists. Rust 1.91.0 meets the pinned
iroh 1.2.0 requirement. Compilation and tests remain explicit, not setup work.
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

Initial setup validation in the disposable Linux x86_64 development environment
(before the iroh addition raised the Rust pin from 1.90.0 to 1.91.0):

- Initial setup: 92.650 s; warm retry: 2.037 s, both succeeded.
- Resume lifecycle without a script: succeeded (60 ms on warm retry).
- Fresh noninteractive login shell: Node 26.8.1, pnpm 10.34.5,
  rustc/Cargo 1.90.0, GCC 13.3.0 and OpenSSL development metadata available.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` passed.
- `cube.services.ensure()` returned no services (none declared).
- aarch64 setup has not been tested. Subsequent real loopback iroh acceptance
  is documented in `packages/node-transport/README.md`; external connectivity
  remains untested.

After the iroh addition: Rust 1.91.0 installed in 11.306 s; two setup retries
including locked Cargo fetch passed in 2.422 s and 2.345 s. Fresh login shells
resolve the repository Rust pin. Rust fmt/clippy and six tests passed, alongside
the 40 Node offline suites, typecheck, lint and build.
