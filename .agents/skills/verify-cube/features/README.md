# cube verification map

This directory is the maintained source for verifying cube's user-facing behavior with `verify-cube`. Read the index, then the feature file for the journey you run.

## Baseline preconditions

- A fresh `pnpm build` and Playwright's Chromium.
- An instance launched by `verify-cube run` or `verify-cube serve` on a run directory of its own; `doctor` prints only `ok:` lines.
- The seeded project `demo` is ready: one repository at `RUN/scratch/demo.git`, branch `main`, one commit `seed` with `README.md` containing `seeded by verify-cube`.
- The model is `faux/faux-1`, scripted by the message (SKILL.md, Drive). The runner `node-verify` is a registry row; tools run in local guests, not VMs.
- Never drive an instance this run did not start.

## Driving conventions

- Each journey starts from the baseline and leaves what it created for cleanup; journeys may share one instance in any order.
- Prefer ARIA roles and accessible names; fall back to the class names the browser tests use.
- Wait for an observable state (`.composer[aria-busy=false]`, a message's text, a URL), never a fixed sleep.
- Read the API only as a second view of what the UI did.

## Proof and skip reporting

- Each journey writes `RUN/evidence/<journey>/steps.log` with every action and observation, screenshots with ARIA snapshots, and API or CLI captures.
- A mutation is proven by a second view: a later turn, the guest's file, the API.
- Report a journey not run as not run, with the reason. A journey that cannot reach its state fails; never weaken it to pass.
- Name the faux model and local guests in every claim that rests on them.

## Feature entry contract

Each feature file has an H1 title, one paragraph of user-visible behavior, then `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-cube` (starting with `Preconditions:`) and `Gotchas`.

## Features

- [Chat](./chat.md) (`chat`): talking to OptChat, streaming, a provider error, reload, phone.
- [Projects](./projects.md) (`project`): creating a project and its repository check.
- [Threads](./threads.md) (`thread`): starting a thread from a project, tool calls in its machine, a second turn, archive.
- [Delegation](./delegation.md) (`spawn`): OptChat starts a thread and its report comes back to the chat.
- [cubed CLI](./cli.md) (`cli`): version, help, runner status, a bad option.

Not mapped yet, with the tests that cover them today (all under `packages/web/test/browser/`): artifacts (`artifact-browser-test.ts`, `diagram-browser-test.ts`), settings and model providers (`settings-browser-test.ts`), skills (`skills-browser-test.ts`), the runners page (`runners-browser-test.ts`), machine startup and sleep (`startup-browser-test.ts`), thread names (`thread-names-browser-test.ts`), usage, images in messages.
