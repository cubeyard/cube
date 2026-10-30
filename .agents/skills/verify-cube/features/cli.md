# cubed CLI

`cubed` is the host command: it prints its version and help, reports runners from a state directory and refuses bad options.

## Sub-features

- `cli-version` prints the version.
- `cli-help` prints usage.
- `cli-runners-status` reads runners from `--state`.
- `cli-bad-option` fails on a bad option.

## How to get to it (user POV)

- `cubed …` from a release or Homebrew; `node packages/server/src/index.ts …` (`pnpm cubed`) in a checkout.

## Driving it with verify-cube

Preconditions:

- An instance from `run` or `serve`, for its state directory. Every command runs with `CUBED_STATE` set to an empty directory under scratch; only `runners status` names the run's state.

- **Version.** `cubed --version`: exit 0, an `x.y.z` version.
- **Help.** `cubed --help`: exit 0, stdout starts `usage: cubed`.
- **Runner status.** `cubed runners status --state RUN/scratch/state`: exit 1, `node-verify: unreachable; ENOENT … /private/verify.json`.
- **Bad option.** `cubed --port 70000 --state <empty dir>`: exit 1, `--port must be an integer from 0 through 65535`. Its state is an empty directory of its own, so even a wrong parse would not start a second server on the run's state.
- **Proof.** One `cubed-*.txt` per command with exit code, stdout and stderr. Each command is killed after 30 s and then fails the journey.

Run: `.agents/skills/verify-cube/verify-cube run cli`.

## Gotchas

- `runners status` exits 1 because the stand-in runner has no config; a real runner is out of scope here.
- Never point `--state` at `~/.cube-host` or any state this run did not create.
- `runners init-local` and `runners enroll` need a real berth and are not driven here (DEVELOPING.md, `scripts/test-local-berth.ts`).
