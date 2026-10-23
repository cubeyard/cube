# Perf harness: a seeded cube in Chrome

Measurements, not tests: nothing here runs in CI. Everything is local and
disposable: a fresh state directory, the controlled (faux) model for every
model call, local guests (`test/local-guest.ts`, the real guest helper under
a temporary root, not a sandbox) for thread machines, and a `gh` that is
never logged in. No runner, provider or GitHub is contacted.

| file | what |
| --- | --- |
| `seed.ts` | seeds a root through cubed's own routes and agents: projects (local git repositories), OptChat turns (replies, tool calls, spawns, artifact writes and revisions, thread reports), threads (most archived), one long thread, artifact comments. Writes `manifest.json` with counts, sizes and the commit |
| `serve.ts` | serves a seeded root with the real cubed and the built UI on loopback; logs each request's server time to `requests.jsonl` |
| `../../../web/test/perf/measure.ts` | copies the root, starts `serve.ts`, drives Google Chrome over CDP: cold/warm chat load, older pages, typing, thread view, lists, phone index, idle polling, route-change leaks, a streamed send; optional Chrome traces and a server CPU profile |
| `profile-summary.ts` | summarizes a `.cpuprofile` |
| `job.ts` | keeps a long seed running under `cube service` in a cube thread |

Content is deterministic for a seed (default 20261023); ids and times are not.

```sh
pnpm install --frozen-lockfile && pnpm --filter @cube/web build
node packages/server/test/perf/seed.ts small  /tmp/perf/small            # ~2 min
node packages/server/test/perf/seed.ts medium /tmp/perf/medium           # ~25 min
node packages/server/test/perf/seed.ts large  /tmp/perf/large            # ~1-2 h
node packages/web/test/perf/measure.ts --root /tmp/perf/large --out /tmp/perf/out-large --runs 5 --trace
node packages/web/test/perf/measure.ts --root /tmp/perf/large --out /tmp/perf/prof-large --runs 3 --only api,chat,idle --profile
node packages/server/test/perf/profile-summary.ts /tmp/perf/prof-large/*.cpuprofile
```

`measure.ts` takes `--chrome` (default `/usr/bin/google-chrome`; say so
when it is Chromium), `--headed`, `--only` (`api,chat,older,thread,lists,phone,idle,leak,send`)
and `--tps` (the controlled model's tokens per second for the streamed send).
Do not run two seeds or a seed and a measurement at once: they share the CPU.
