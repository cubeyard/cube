# Projects

A project names the repositories a thread checks out. The user creates one on `#/projects/new`, saves it, and cube checks access and resolves the branch before any thread can start.

## Sub-features

- `project-create` creates a project with a repository URL.
- `project-check` shows the resolved branch and commit.
- `project-list` lists the project on `#/projects`.

## How to get to it (user POV)

- `#/projects`, then `new project`.
- The index (the `cube · index` button, or `/`), then projects.

## Driving it with verify-cube

Preconditions:

- `doctor` is all `ok:`.
- No project is named `demo-ui`.

- **Fill.** On `#/projects/new` fill the textbox `project name` with `demo-ui` and the combobox `repository 1 URL` with the seeded `RUN/scratch/demo.git`, then press Escape to close the suggestions.
- **Save.** Choose `save & check`. The URL becomes `#/projects/<id>` and `.repository-evidence` reads `main @ <8 hex>`. Captured as `01-checked`.
- **List.** Open `#/projects`. It lists `demo-ui`. Captured as `02-list`.
- **Proof.** `projects.json` (`/api/projects`) has `demo-ui` with status `ready`.

Run: `.agents/skills/verify-cube/verify-cube run project`.

## Gotchas

- The repository input searches GitHub as you type; with no GitHub login it offers nothing to pick, which is expected here. A pasted path or URL is used as typed.
- A local path is accepted as a repository URL. GitHub URLs need the host's `gh` login, which a verification run never uses.
