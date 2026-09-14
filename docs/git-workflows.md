# Git workflows for agents

Use ordinary local Git for editing, staging, committing, reviewing, rebasing,
and resolving conflicts. Cube brokers authenticated network access because
credentials stay outside the thread environment; it does not add a second
review process.

## Operations

| Task | Operation | Cube behavior |
| --- | --- | --- |
| Commit | local `git commit` | No Cube approval or review gate |
| Refresh the configured base | `cube.git.syncBase(repositoryId)` | Fetches into `origin/<base>` without changing local work |
| Push the current branch | `cube.git.pushBranch(repositoryId)` | One ordinary non-forced push |
| Update an existing PR | commit locally, then `cube.git.pushBranch(repositoryId)` | Same push path; no PR lookup, diff ingestion, or Cube review |
| Push to the configured base | `cube.git.pushBase(repositoryId)` | One ordinary non-forced push to the base ref |
| Create a PR | `cube.git.createPr(repositoryId, { title?, body? })` | Interactive user confirmation, then push and `gh pr create` |

Git rejects non-fast-forward updates unless the remote accepts them. Cube does
not expose a force-push option. That is the current capability boundary, not a
claim that Cube validates PR history or enforces repository policy.

## Where policy is actually enforced

Three enforcement levels must not be conflated:

1. **Cube policy** controls Cube-owned capabilities. Today it confirms one
   operation: creating a new pull request. The pi extension asks the user in
   the TUI immediately before calling the host API. Declining means no host
   push or PR call occurs. Commit, push, and existing-PR updates have no Cube
   approval or review gate.
2. **Local security guards** protect the credentialed host from an untrusted
   workspace. Cube disables workspace hooks, fsmonitor commands, external diff
   drivers, and credential helpers for host-side operations; it relays objects
   through a host-owned mirror. These guards prevent code execution and
   credential theft. They cannot enforce repository merge policy, and ordinary
   Git inside the thread remains ordinary Git.
3. **GitHub branch protection and rulesets** are the authoritative server-side
   controls for required reviews, status checks, signed commits, allowed update
   types, and protected branches. Only GitHub can enforce these against every
   writer. Cube sends a normal push or PR request and reports GitHub's answer.

## Declarative policy direction

If more Cube-owned confirmation points are needed, keep the representation
small and capability-oriented rather than modeling GitHub rules locally. For
example:

```toml
[policy.git]
push = "allow"
create_pull_request = "confirm"
```

The values describe only Cube decisions at Cube capability boundaries. A
future implementation could validate this closed schema when loading project
configuration and apply it in the pi extension before the matching host call.
It should not add `required_reviews`, `status_checks`, or branch-pattern claims:
those belong in GitHub rulesets. It should also not generate local hooks as a
security guarantee, because a process that controls its checkout can bypass or
replace them.

`commit` is deliberately absent: local Git is not a Cube capability boundary,
so listing it would imply enforcement Cube does not have.

The current fixed policy already matches the example, so no general policy
engine or configuration migration is justified yet.
