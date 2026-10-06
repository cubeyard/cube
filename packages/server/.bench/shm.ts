import fs from "node:fs";
import { readStorage } from "../src/durable-agent.ts";
const dir = "/workspace/packages/server/.bench/shm";
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
fs.copyFileSync("/workspace/packages/server/.bench/data/pi/pi.sqlite", dir + "/pi.sqlite");
console.log("before", fs.readdirSync(dir));
await readStorage(dir + "/pi.sqlite", async () => null);
console.log("after old readStorage", fs.readdirSync(dir), fs.statSync(dir + "/pi.sqlite-wal", { throwIfNoEntry: false })?.size);
