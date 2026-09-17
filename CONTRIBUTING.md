# Contributing to cube

Thanks for taking the time to improve cube.

## Before you start

- Search existing issues before opening a new one.
- Use [GitHub's private vulnerability reporting](SECURITY.md) for security
  issues. Do not include vulnerability details in a public issue.
- Keep changes focused. Large behavior or architecture changes are easier to
  review when discussed in an issue first.

AI-assisted contributions are welcome. You remain responsible for
understanding the change, reviewing generated code, and verifying that it
works.

## Development checks

The fast development loop requires Node.js 26 or newer. The exact pnpm version
is pinned in `package.json`.

```sh
npm install --global pnpm@10.34.5
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm lint` is ESLint with correctness rules only (no formatting). `pnpm test`
runs the offline Node suites without model credentials. Runner and execution
changes also require `bash scripts/test-node-transport.sh`, which exercises real
Rust/Iroh calls and process-crash recovery with disposable data.

## Pull requests

- Explain the user-visible outcome and any security implications.
- Add or update tests when behavior changes.
- Keep documentation accurate when commands, requirements, or configuration
  change.
- Confirm the build, typecheck, lint, and offline tests pass.

The root package is intentionally marked `private` to prevent accidental npm
publication; this does not restrict contributions or the repository's
Apache-2.0 license.

## Releases

No automatic product release workflow is configured during this architecture
replacement. Runner packaging remains available for explicit operator use.
Contributors should not create release tags as part of a pull request.
