# web-elm: a prototype of a redesigned cube frontend

A throwaway prototype, not a replacement for `packages/web`. It asks one
question: does a board of runners, with each thread as a card in the slot it
holds, make it easier to see what runs and what needs you?

Elm owns the application (`src/`): `Data` (cubed's API as types), `Phase`
(the one ranking of a thread's machine and run into a state), `Model`,
`Main` (update), `View`, `Convo`, `Pages`, `Ui`. `static/boot.js` holds the
three things Elm cannot reach: one `EventSource`, `localStorage` and the text
selection. The typeface is Archivo (SIL Open Font License 1.1), latin subset.

```sh
npm install --prefix /tmp/elmtool elm@0.19.1-6            # the compiler, once
ELM=/tmp/elmtool/node_modules/.bin/elm bash packages/web-elm/build.sh
bash packages/web-elm/preview/serve.sh                               # the simulation
node packages/web-elm/preview/sim-journeys.ts --out /tmp/sim-evidence # its safety checks and journeys
node packages/web-elm/preview/journeys.ts --out /tmp/elm-evidence     # real cubed, loopback only
```

Two hosts serve the built UI, and only one may be shown to anyone:

- `preview/sim.ts` is what a portal serves (`preview/serve.sh`). It is a
  simulation: no cubed, model, shell, git, repository or credential. It plays
  canned scripts on timers, matches a visitor's text against a few fixed
  words and never runs it, and says "simulated" in every reply and step. It
  runs under Node's permission model (no child process, no file write).
  `node preview/sim-journeys.ts --out DIR` checks that before it is served.
- `preview/host.ts` is a real cubed on disposable state with a scripted model
  and no VM, like the verify host. It runs real shell commands for whoever
  reaches it, so it listens on 127.0.0.1 only and refuses any other binding.
  `preview/journeys.ts` drives it for evidence about cubed's real behavior.
  It adds `GET /api/activity` (every open thread's run state in one read that
  wakes no machine), which cubed lacks.

Both show `preview/synthetic.ts`'s labeled rows for states neither can reach.
Words both answer: `demo work`, `demo slow`, `demo artifact`, `please fail`,
and in optchat `spawn <project>: <task>`.
