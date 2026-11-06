# docs

cube's public documentation site, <https://cubeyard.github.io/cube/>, built
with [Astro Starlight](https://starlight.astro.build) and styled from
DESIGN.md. It documents the latest published release; the maintainer
references stay in `docs/` and the root `.md` files, and the site links to
them at its release tag (`gh:PATH` links, see `astro.config.mjs`).

The package is its own pnpm workspace with its own lockfile: its toolchain
never enters cubed's dependency graph or the code CI's install.

```sh
pnpm install --frozen-lockfile          # in the repository root: cubed --help needs it
cd packages/docs
pnpm install --frozen-lockfile
pnpm dev                                # http://localhost:4321/cube/
pnpm build                              # dist/, then every link checked
```

- `scripts/cli-reference.ts` writes `src/content/docs/reference/cli.md`
  (not committed) from `cubed --help` and the usage strings of `berth` and
  of `cube` in a thread machine, before every build and `pnpm dev`.
- `scripts/check-links.ts` fails the build on a link to a page, a fragment,
  or a repository file or heading that does not exist. External links are
  not fetched.
- `CUBE_DOCS_REF` names the release the build documents (the header shows
  it, and `gh:` links point at it); unset, it is `main` and the header says
  `unreleased`.

## Publishing

`.github/workflows/docs.yml` builds the site on pull requests that touch it
or the help texts the reference is written from. It deploys only from a
published stable release: on `release: published`, or by hand with the tag
of the latest release. It refuses any other tag, and a release whose tag
has no `packages/docs`. A docs fix merged to `main` goes live with the next
release.

One-time settings, by a repository admin:

1. Settings › Pages: source **GitHub Actions**.
2. Settings › Environments › `github-pages`: add the deployment tag rule
   `v*`, so a release's run (whose ref is the tag) may deploy. Without it,
   run the workflow by hand from `main` with the release's tag.
3. The repository's website: `https://cubeyard.github.io/cube/`.
