/** Test only: a stand-in for cube-gateway's process contract (its ready
 * line, the stdin lifeline, the credential socket). FAKE_GATEWAY_LOG
 * records every start; FAKE_GATEWAY_CRASH=<n> makes the first n starts exit
 * shortly after their ready line. The real gateway's tests are in
 * packages/gateway; cubed with the real one runs in runner-vm-cubed-test.ts. */
import fs from "node:fs";
import net from "node:net";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
const credential = option("credential");
const logFile = process.env.FAKE_GATEWAY_LOG!;
const record = (event: Record<string, unknown>) => fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`);
const starts = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(line => line.includes('"start"')).length : 0;
record({ event: "start", args });
const server = net.createServer(socket => socket.end());
fs.rmSync(credential, { force: true });
server.listen(credential, () => {
  fs.chmodSync(credential, 0o600);
  process.stdout.write(`${JSON.stringify({ ready: true, version: "fake" })}\n`);
  if (starts < Number(process.env.FAKE_GATEWAY_CRASH ?? 0)) setTimeout(() => { record({ event: "crash" }); process.exit(3); }, 150);
});
process.stdin.on("end", () => { record({ event: "lifeline" }); server.close(); process.exit(0); });
process.stdin.resume();
process.on("SIGTERM", () => { record({ event: "sigterm" }); process.exit(0); });
