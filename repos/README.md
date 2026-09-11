# Dependency source references

These are read-only Git subtrees, available immediately after an ordinary clone.
They are not workspace packages or runtime dependencies. Do not install their
dependencies, run their scripts, or import from here in cube application code.
Licenses and upstream notices remain in each subtree.

| Directory | Upstream | Tag | Commit | Used by cube |
| --- | --- | --- | --- | --- |
| `pi/` | https://github.com/earendil-works/pi | `v0.85.1` | `d981de1229ef899957bbe968bc8dcda02a21f477` | `@earendil-works/pi-coding-agent` in server and pi-extension |
| `effect/` | https://github.com/Effect-TS/effect | `effect@4.0.0-rc.113` | `d3b837aee836f35d625d55205f7d6e61305fc198` | `effect` in server, git, sandbox and web |

Cube delegates its agent loop, sessions and terminal UI to pi. Effect 4 is an
explicitly pinned release candidate, initially used for onboarding-state schema
validation. Read `effect/LLMS.md` before using its APIs. Add other references only
when their source will help a concrete task.

## Updating

Use Git with the `subtree` command installed. From a clean working tree on a
branch, update to the release tag matching cube's dependency version:

```sh
git subtree pull --prefix=repos/pi https://github.com/earendil-works/pi.git v0.85.1 --squash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@4.0.0-rc.113 --squash
```

Replace the relevant tag when upgrading; update the table after verifying the upstream
commit and package version. Do not follow upstream `main` independently of the
installed package. `subtree pull` creates local commits; inspect them before
publishing. Preserve upstream files unchanged so future subtree merges stay clean.

Upgrade all consuming cube package pins, the lockfile and the subtree in the same change.
After installing dependencies, run `pnpm check:references`: it checks the subtree
package versions against every listed consumer's exact pin and installed package.
`pnpm test` runs this check first; CI's frozen-lockfile install ensures those
installed versions come from the committed lockfile. A mismatch fails rather
than fetching or silently updating anything. The check belongs to the source
checkout, not the VM offline suite, because app artifacts omit `repos/`.

To add another dependency, use `git subtree add --prefix=repos/<name>
<upstream-url> <matching-tag> --squash` and record its provenance here.

`repos/` stays tracked and searchable with tools such as `rg`, but is excluded
from VS Code search, file watching and auto-imports, cube linting, app staging,
VM sync and reference-only release triggers. Existing workspace and TypeScript
include lists already restrict builds and checks to cube's own code.
