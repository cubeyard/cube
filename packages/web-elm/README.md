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
node packages/web-elm/preview/host.ts --scratch /tmp/elm-preview --port 7790 --seed
node packages/web-elm/preview/journeys.ts --out /tmp/elm-evidence   # browser journeys
```

`preview/host.ts` is a real cubed on disposable state with a scripted model
and no VM, like the verify host: it has no login and no sandbox of its own, so
whoever reaches its port can run commands as the account that started it.
It adds two things cubed does not have, both marked in the code: `GET
/api/activity` (every open thread's run state and newest events in one read
that wakes no machine) and `preview/synthetic.ts` (labeled rows for states a
host without runners cannot reach). The scripted model answers `demo work`,
`demo slow`, `demo artifact`, `please fail`, `spawn <project>: <task>` (in
optchat) and `tool {"name":…,"args":…}`.
