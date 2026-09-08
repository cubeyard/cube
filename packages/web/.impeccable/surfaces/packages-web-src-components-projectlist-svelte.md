---
version: 1
slug: "packages-web-src-components-projectlist-svelte"
primary_target: "packages/web/src/components/ProjectList.svelte"
related_targets: ["packages/web/src/App.svelte","packages/web/src/components/Header.svelte","packages/web/src/components/ProjectView.svelte","packages/web/src/components/ThreadList.svelte","packages/web/src/components/ThreadView.svelte"]
---

## Scope and mode

Projects at `#/projects` and `#/projects/<id>`, plus their required context in
the global thread list and thread review controls. **Operate**: a technically
fluent self-hoster prepares repository inputs and needs exact readiness before
starting work.

## Job, task, and evidence

Configure one primary and any number of additional repositories once. Cube
checks URL safety, host access, branches, checkout-name uniqueness, and local
mirrors. Success is a green project with per-repository evidence and a checked
time; only then can it start a thread. Every thread belongs to one project.
The primary checkout is fixed at `/workspace`; each additional repository has
an explicit checkout name and prints `../repos/<checkout-name>`.

## Direction and memorable moment

Project switchboard, selected from seed `e0bc0e78`, extending the established
bench instrument. The project list is one recessed module well; detail is one
vertical repository control board. The memorable moment is the lamp check:
repositories move from blinking amber to green one by one while exact errors
remain printed in their own rows.

The shipped list row contains the project lamp and name, repository and thread
counts, checked time, compact repository names, full wrapping failure text,
and one flush re-check key. The detail board contains project identity,
per-repository role/path, URL/base/checkout fields, and inline evidence:
`not checked`, access/branch checking, resolved base plus abbreviated OID, or
the complete error. Saving dirties the board and clears readiness; re-check and
thread creation remain unavailable until the saved configuration is ready.

The bottom action bank is intentionally unequal: orange belongs to save, while
check, new thread, and the global thread link remain neutral; delete is
separated red ink. Preserve that hierarchy and the quiet warm ramp. Do not
raise all secondary contrast in pursuit of generic dashboard legibility.

## Constraints

- Threads remain the global home, defaulting to `all projects`; projects never
  become thread silos. Every thread row shows its project, and project actions
  deep-link back to the same filtered global list.
- No `no project`, legacy repo-per-thread UX, account/team model, modal-first
  flow, or user-facing cube vocabulary.
- Primary checkout is `/workspace`; additional checkouts are
  `../repos/<checkout-name>`. Review, push, and PR actions are repository-scoped.
- Preserve the 47rem column, lower-case control voice, lamp vocabulary, mobile
  stacking, keyboard focus, and reduced-motion behavior.
- Preserve complete inline repository and action failure text with wrapping;
  do not collapse actionable backend detail into a toast or generic label.
- A project with threads cannot be deleted. The confirmation names the
  prepared repository configuration being removed; it does not imply source
  repositories are deleted.

## Unresolved

Automatic mirror refresh policy remains undecided. The shipped contract is
explicit `checked` time and manual re-check; thread creation uses the prepared
mirror snapshot rather than doing hidden network/auth work again.
