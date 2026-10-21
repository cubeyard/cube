/** The runner of runner-enroll-test.ts's fake `berth vm`, which execs it
 * after its pull: it binds the listen address as berth does (and fails as
 * berth does when that is in use), prints berth's banner, answers a
 * protocol-4 hello as its node id, only to the control peer it was given,
 * and stops on SIGTERM. Arguments: <dir> <node id> <control peer hex>
 * <listen>; FAKE_RUNNER_KEY is its secret key (hex), FAKE_LOG berth's log. */
import fs from "node:fs";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream } from "@number0/iroh/index.js";
import { HelloAnswerSchema, OpenSchema, Runner_Kind } from "../src/gen/runner_pb.js";

const [dir, node, allowed, listen] = process.argv.slice(2) as [string, string, string, string];
const key = SecretKey.fromBytes(Array.from(Buffer.from(process.env.FAKE_RUNNER_KEY!, "hex")));
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(key.toBytes());
builder.bindAddr(listen);
builder.alpns([Array.from(Buffer.from("cubeyard/runner/4"))]);
let server: Endpoint;
try { server = await builder.bind(); } catch (error) {
  process.stderr.write(`Error: binding ${listen}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const hex = (bytes: ArrayLike<number>) => Buffer.from(bytes as Uint8Array).toString("hex");

function frame<D extends DescMessage>(schema: D, value: MessageInitShape<D>): number[] {
  const bytes = Buffer.from(toJsonString(schema, create(schema, value)));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Array.from(Buffer.concat([header, bytes]));
}

process.once("SIGTERM", () => {
  fs.appendFileSync(process.env.FAKE_LOG!, "vm stopped by SIGTERM\n");
  void server.close().finally(() => process.exit(0));
});
process.stderr.write(`dir: ${dir}\nnode: ${node}\npeer: ${hex(key.public().toBytes())}\ncontrol peer: ${allowed}\n`
  + "waiting for cubed; Ctrl-C stops the runner\n");
for (;;) {
  const incoming = await server.acceptNext();
  if (!incoming) break;
  void (async () => {
    const connection = await (await incoming.accept()).connect();
    if (hex(connection.remoteId().toBytes()) !== allowed) { connection.close(1n, Array.from(Buffer.from("unauthorized"))); return; }
    for (;;) {
      let stream: BiStream;
      try { stream = await connection.acceptBi(); } catch { return; }
      const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
      const opened = fromJsonString(OpenSchema, Buffer.from(await stream.recv.readExact(length)).toString("utf8"), { ignoreUnknownFields: true });
      if (opened.kind.case !== "hello") { await stream.send.finish(); continue; }
      fs.appendFileSync(process.env.FAKE_HELLOS!, "hello\n");
      await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, runner: { nodeId: node, kind: Runner_Kind.VM, softwareVersion: "0.1.0",
        platform: { os: "macos", arch: "aarch64", baseImageSha256: "b".repeat(64) }, network: { mode: "loopback" },
        limits: { maxVcpus: 4, maxMemoryMib: 8192, maxDiskGib: 64, maxMachines: 2, maxBootBytes: 262144 } } }));
      await stream.send.finish();
    }
  })().catch(() => {});
}
