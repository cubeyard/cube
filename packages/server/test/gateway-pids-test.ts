/** How runner-vm-cubed-v3-test.ts finds cubed's supervised gateway
 * (gateway-pids.ts): held to the command line cubed builds in gateway.ts and
 * index.ts, so a change there fails here, offline, instead of in a native
 * gate. server1's gate 18d1376d stopped on the old lookup (`pgrep -f "serve
 * --state <state>/gateway"`, the argv before #230's `2530f2e9`), which no
 * longer matched any gateway. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gatewayCommand, gatewayPidsIn } from "./gateway-pids.ts";

// cubed's source: the argv, the sockets and the run directory gateway-pids.ts rebuilds.
const source = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "../src", file), "utf8");
const gateway = source("gateway.ts");
const index = source("index.ts");
assert.ok(gateway.includes(`const args = ["serve", "--decide", this.options.decide, "--credential", this.options.credential, ...(this.options.extraArgs ?? [])];`),
  "gateway.ts starts the gateway with this argv (change gateway-pids.ts with it)");
assert.ok(gateway.includes("const child = spawn(binary, args,"), "gateway.ts spawns the binary itself, so argv[0] is CUBED_GATEWAY");
assert.ok(gateway.includes("const configured = env.CUBED_GATEWAY?.trim();"), "CUBED_GATEWAY is used trimmed");
assert.ok(index.includes(`const credential = path.join(run, "credential.sock");`)
  && index.includes(`new GatewaySupervisor({ decide: path.join(run, "egress.sock"), credential,`), "index.ts puts both sockets in its run directory");
assert.ok(index.includes(`const directory = path.join(state, "run");`) && index.includes("if (Buffer.byteLength(socket) > 100) {"),
  "index.ts's run directory is <state>/run unless workspace.sock's path is over 100 bytes");

// The native test uses this lookup, with the same test args it hands cubed, and no other.
const v3 = fs.readFileSync(path.resolve(import.meta.dirname, "runner-vm-cubed-v3-test.ts"), "utf8");
assert.ok(v3.includes("CUBED_GATEWAY: gatewayBin,") && v3.includes("CUBED_GATEWAY_TEST_ARGS: JSON.stringify(gatewayTestArgs)")
  && v3.includes("gatewayCommand({ binary: gatewayBin, state, testArgs: gatewayTestArgs })"), "runner-vm-cubed-v3-test.ts names its gateway as it starts cubed");
assert.ok(!/pgrep|serve --state/.test(v3), "runner-vm-cubed-v3-test.ts has no other gateway lookup");

const binary = "/home/x/cube/target/test-hooks/debug/cube-gateway";
const state = "/tmp/cv3-AbC123/state";
const testArgs = ["--test-upstream", "github.com=127.0.0.1:40123", "--test-upstream", "api.github.com=127.0.0.1:40123", "--test-upstream-ca", "/tmp/cv3-AbC123/github/ca.pem"];
const command = gatewayCommand({ binary, state, testArgs });
assert.equal(command, `${binary} serve --decide ${state}/run/egress.sock --credential ${state}/run/credential.sock ${testArgs.join(" ")}`);
assert.equal(gatewayCommand({ binary: ` ${binary}\n`, state, testArgs }), command, "argv[0] as cubed trims it");
assert.throws(() => gatewayCommand({ binary, state: `/tmp/${"d".repeat(90)}/state`, testArgs }), /over 100 bytes/,
  "a state whose sockets cubed moves to a temporary directory is refused, not guessed");

const line = (pid: number, args: string) => `${String(pid).padStart(7)} ${args}`;
const ps = (...lines: string[]) => `${lines.join("\n")}\n`;

// Today's argv (since #230): found, and only it.
assert.deepEqual(gatewayPidsIn(ps(line(1, "/sbin/init"), line(4242, command)), command, 99), ["4242"]);
// The regression: the old lookup never matches today's argv (the STOP), and the new one does not match the old argv.
const oldArgv = `${binary} serve --state ${state}/gateway --control ${state}/run/gateway.sock --decide ${state}/run/egress.sock`;
assert.ok(!command.includes(`serve --state ${path.join(state, "gateway")}`), "the pre-#230 pattern is not in today's argv");
assert.deepEqual(gatewayPidsIn(ps(line(4242, oldArgv)), command, 99), [], "a pre-#230 gateway is not this one");

// Unrelated gateways and processes never match.
const other = (changes: Partial<{ binary: string; state: string; testArgs: string[] }>) => gatewayCommand({ binary, state, testArgs, ...changes });
const unrelated = [
  line(5001, other({ state: "/tmp/cv3-ZzZ999/state" })), // another test's cubed
  line(5002, other({ state: `${state}2` })), // a state this one is a prefix of
  line(5003, other({ testArgs: [] })), // production cubed: no test upstreams
  line(5004, other({ testArgs: testArgs.map(arg => arg.replace("40123", "40124")) })), // another fake GitHub
  line(5005, other({ binary: "/opt/cube/bin/cube-gateway" })), // another binary
  line(5006, `${command} --extra`), // more arguments than cubed gives
  line(5007, `bash -c ${command}`), // a shell carrying the line
  line(5008, `pgrep -af ${command}`), // a lookup carrying the line
  line(5009, `grep -F ${command}`),
  line(5010, "[cube-gateway] <defunct>"), // a zombie
  line(5011, `${binary} serve --decide ${state}/run/egress.sock`), // a cut-short line
];
assert.deepEqual(gatewayPidsIn(ps(...unrelated), command, 99), [], "no unrelated process matches");
assert.deepEqual(gatewayPidsIn(ps(...unrelated, line(4242, command)), command, 99), ["4242"], "among them, only this state's gateway");
// The caller itself, whatever its command line, is never counted; two real ones are both reported.
assert.deepEqual(gatewayPidsIn(ps(line(99, command), line(4242, command)), command, 99), ["4242"]);
assert.deepEqual(gatewayPidsIn(ps(line(4242, command), line(4243, command)), command, 99), ["4242", "4243"]);
assert.deepEqual(gatewayPidsIn("", command, 99), []);

console.log("ok: gateway pids by cubed's whole command line; pre-#230 argv, other states, binaries, upstreams, shells, lookups, zombies and self excluded");
