/** Test only: a stand-in for cube-gateway's process contract (ready line,
 * stdin lifeline, control API on a unix socket). FAKE_GATEWAY_LOG records
 * every start and attach; FAKE_GATEWAY_CRASH=<n> makes the first n starts
 * exit shortly after their ready line. The real gateway's tests are in
 * packages/gateway; the real pairing runs in scripts/test-vm-e2e.ts. */
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(`--${name}`) + 1];
const control = option("control");
const logFile = process.env.FAKE_GATEWAY_LOG!;
const record = (event: Record<string, unknown>) => fs.appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`);
const starts = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(line => line.includes('"start"')).length : 0;
record({ event: "start", args });
const vms = new Map<string, Record<string, unknown>>();
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const send = (status: number, value?: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(value === undefined ? "" : JSON.stringify(value)); };
    const parts = (request.url ?? "").split("/").filter(Boolean);
    if (request.method === "GET" && request.url === "/v1/hello") return send(200, { version: "fake", peer: "a".repeat(64), network: option("network"), caPem: "CA", caSha256: "b".repeat(64) });
    if (request.method === "GET" && request.url === "/v1/vms") return send(200, { vms: [...vms.values()] });
    if (parts[0] === "v1" && parts[1] === "vms" && parts[2]) {
      if (request.method === "PUT") {
        const spec = JSON.parse(body);
        vms.set(parts[2], { vmId: parts[2], threadId: spec.threadId, link: "up", leased: true, guestIp: "10.77.0.2", flows: 0, rxBytes: 0, txBytes: 0, lastError: null });
        record({ event: "attach", vmId: parts[2], frameToken: spec.frameToken });
        return send(200, vms.get(parts[2]));
      }
      if (request.method === "DELETE") { vms.delete(parts[2]); return send(204); }
      if (request.method === "GET") return vms.has(parts[2]) ? send(200, vms.get(parts[2])) : send(404, { error: "vm is not attached" });
    }
    send(404, { error: "no such route" });
  });
});
fs.rmSync(control, { force: true });
server.listen(control, () => {
  fs.chmodSync(control, 0o600);
  process.stdout.write(`${JSON.stringify({ ready: true, version: "fake", peer: "a".repeat(64), caSha256: "b".repeat(64) })}\n`);
  if (starts < Number(process.env.FAKE_GATEWAY_CRASH ?? 0)) setTimeout(() => { record({ event: "crash" }); process.exit(3); }, 150);
});
process.stdin.on("end", () => { record({ event: "lifeline" }); server.close(); process.exit(0); });
process.stdin.resume();
process.on("SIGTERM", () => { record({ event: "sigterm" }); process.exit(0); });
