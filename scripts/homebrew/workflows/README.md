# Workflows staged for a maintainer

These two files belong in `.github/workflows/`, but the thread that wrote them
pushed with a GitHub token without the `workflow` scope, which GitHub requires
for creating or changing workflow files (`git push` and the contents API both
refuse). A maintainer installs them:

```sh
git mv scripts/homebrew/workflows/homebrew.yml .github/workflows/homebrew.yml
# append the job in ci-homebrew-job.yml under `jobs:` in .github/workflows/ci.yml
git rm scripts/homebrew/workflows/ci-homebrew-job.yml scripts/homebrew/workflows/README.md
```

- `homebrew.yml`: on a published release (or by hand with a `version` input),
  generate the tap formulas from the release's signed manifests, install, audit
  and test them on a macOS runner, and push them to `cubeyard/homebrew-tap`
  with the `HOMEBREW_TAP_TOKEN` secret.
- `ci-homebrew-job.yml`: the same generation, install, audit and test against
  the latest published release on every pull request, without the push.

Until they are installed, nothing publishes the tap and no CI run exercises
the formulas on macOS; DEVELOPING.md, "Homebrew publishing", describes the
intended state.
