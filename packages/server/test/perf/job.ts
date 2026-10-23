/** Runs one long harness command (a large seed) to its end under `cube
 * service`, which keeps a process past the shell that started it only
 * while it listens on a port. The port answers only whether the command
 * still runs and how it ended; the command's output goes to LOG. The job
 * stays up after the command ends, so the service does not start it again;
 * stop it with `cube service stop`.
 *
 *   cube service start NAME --port PORT -- node packages/server/test/perf/job.ts PORT LOG -- node packages/server/test/perf/seed.ts large ROOT
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";

const [port, logFile, separator, command, ...rest] = process.argv.slice(2);
if (!port || !logFile || separator !== "--" || !command) { console.error("usage: job.ts PORT LOG -- COMMAND..."); process.exit(2); }
const marker = `${logFile}.done`;
let state = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "running";
if (state === "running") {
  const log = fs.openSync(logFile, "a");
  const child = spawn(command, rest, { stdio: ["ignore", log, log] });
  child.on("exit", (code, signal) => { state = `exited ${code ?? signal}`; fs.writeFileSync(marker, state); });
}
http.createServer((_request, response) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(`${state}\n`); }).listen(Number(port), "0.0.0.0");
