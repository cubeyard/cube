# Git workflows for agents

Use ordinary local Git for editing, staging, committing, and resolving conflicts.
Cube only brokers authenticated repository access and guarded publication; it
must not become a second command language for everything Git already does.

## Choose by intent

| Task | Start here | Finish |
| --- | --- | --- |
| New thread | Creation refreshes each configured base automatically | Work locally on the pinned snapshot |
| Refresh an existing thread's base | `cube.git.syncBase(repositoryId)` | Integrate explicitly; fetching never resets local work |
| Publish a new branch/PR | Local commits | `cube.git.pushBranch` or `cube.git.createPr` |
| Fix review feedback on an existing PR | `cube.git.preparePrUpdate(repositoryId, number)` | Plan, inspect, publish |
| Explicitly rebase/rewrite a standalone PR | `cube.git.preparePrRebase(repositoryId, number)` | Local rebase, test, then the same plan, inspect, publish |
| Reconcile uncertain publication | `cube.git.verifyPrUpdate(repositoryId, token)` | Inspect actual state; never blindly retry or roll back |

A normal review adds commits and preserves the published head as an ancestor.
A user-requested rebase intentionally rewrites history. These are distinct
session intents, not a global `force: true` option. Only the new rebase session
permits replacing existing commits. Primary repository only; reference
repositories stay read-only.

## Rebase: one new entry point, existing publication flow

1. Obtain explicit user authorization to rewrite the PR's published history.
   Keep the worktree clean; preserve any unrelated work first.
2. Call `cube.git.preparePrRebase(repositoryId, number)`. This reads authoritative
   GitHub head/base/membership/queue state, fetches the exact commits on the
   host, and imports a bundle. It returns a new branch without switching or
   resetting existing branches, plus `head`, `baseOid`, `upstream`,
   `rebaseCommand`, and `rangeDiffCommand`.
3. Switch to the returned branch and run `rebaseCommand` locally. It uses pinned
   SHAs, not mutable tracking refs; it flattens merge commits and leaves other
   branches alone. Resolve conflicts and `git rebase --continue`, or abort.
   This is ordinary Git, with no credentials in the environment.
4. Check `rangeDiffCommand`, compare the intended old/new PR changes, and run
   tests. Flattening old merges can require preserving their conflict
   resolutions explicitly: a successful rebase is not proof of semantic
   equivalence. Do not just reconstruct an old tree on a new parent.
5. Call `cube.git.planPrUpdate(repositoryId, token)`. The candidate must contain
   the pinned base and be linear above it; the result marks
   `rewritesHistory: true`. Planning is local and can be repeated without
   generating new commits for an unchanged candidate.
6. Read every `patch` and `prDiff` page with `cube.git.inspectPrUpdatePlan`.
   For rebases, `patch` compares old/new heads and includes changes inherited
   from the updated base; `prDiff` shows the resulting PR relative to that base.
   Both matter. Existing comments/reviews should be read when relevant too.
7. Call `cube.git.publishPrUpdate(repositoryId, token, plan)` only when publication
   is authorized. Cube checks the workspace, head, base, membership, and queue
   again, then pushes the exact inspected head with
   `--force-with-lease=refs/heads/<branch>:<original-head-SHA>` from the saved
   host snapshot. Local `origin/*` refs are never used as leases.
8. On timeout/disconnect/uncertainty, use `verifyPrUpdate`. The publication
   attempt is persisted before push and cannot be blindly repeated, even
   after a restart. Never force over a concurrent update.

If the base or head changes before publication, preparation must be repeated
without discarding local work. A last-millisecond head change is protected by
the explicit lease. GitHub metadata and Git refs cannot be locked together;
a post-push discrepancy is reported as uncertain completion, not rolled back.

## Scope and limitations

Initial rewrite support is deliberately **standalone PRs only**. Native stacks
(including a one-member native stack), forks, queued PRs, and missing/inconsistent
native membership metadata stop with an explanation. Additive stacked-PR reviews
keep their existing restack workflow. Whole-stack history rewriting needs a
separate coordinated design; it must not silently rewrite descendants.

This does not add a GitHub merge operation or bypass branch protections. It
provides a guarded way to publish a rebased branch that GitHub can then assess
for the requested merge method. Reviews/required checks still apply.

The host Git service, HTTP dispatcher, codemode SDK and its instructions must
all be deployed together. New sessions need the updated extension/instructions;
editing repository files alone does not grant an already-running agent new
capabilities or permission to bypass its existing workflow.

## Tests

`packages/git/test/pr-rebase-test.ts` uses local throwaway remotes and mocked
GitHub metadata. It covers merge-commit flattening and conflict resolution,
additive-session rejection of rewrites, pinned-base and linearity checks,
restart-stable plans, explicit leases, base drift, concurrent head changes,
uncertain-push reconciliation, and refusal of unsupported PR shapes. It runs
with the existing offline suite, without modifying any real PR.
