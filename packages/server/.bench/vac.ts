import { DatabaseSync } from "node:sqlite";
const s = new DatabaseSync(".bench/data/pi/pi.sqlite", { readOnly: true });
s.prepare("VACUUM INTO ?").run("/workspace/packages/server/.bench/vac-copy.sqlite");
s.close();
