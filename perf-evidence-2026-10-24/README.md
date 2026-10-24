# GUI performance evidence, 2026-10-24 (thread 95617736)

Raw `measure.ts` results (harness #248), Chrome 156.0.8078.47 headless, 2 vCPU VM, synthetic seed 20261023 only.

| directory | server tree | UI build |
| --- | --- | --- |
| `small-leak-main` | main 2e65414e + harness (`ca067811`) | main |
| `small-leak-fix` | same | #251 |
| `large-base/*` | `perf/evidence-base` (`ca067811`) | main |
| `large-rows/send` | `perf/evidence-base` | #252 at `eae54699` |
| `large-all/*` | `58fc0337` (main + harness + #251 + #252 first commit + #253) | that tree |
| `large-all2/older` | `3d248df1` (plus #252's margin commit) | that tree |
| `large-all/profile`, `large-all/typing.cpuprofile` | `3d248df1`, unminified build | |

`retainers.ts`, `inspect.ts`, `typing-profile.ts`, `summary.mjs`: the ad hoc analysis scripts used.
Not kept: the seeded state directories (272 MB large), heap snapshots, Chrome traces.
