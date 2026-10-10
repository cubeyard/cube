/** Protocol 4's schema in TypeScript and Rust agree on every message.
 *
 * packages/runner-protocol/proto/fixtures holds one proto3-JSON document per
 * message of runner.proto, and one per case of each oneof, with every field
 * set to a value that is not its default (so none is left out of the JSON).
 * This test derives that corpus from the generated descriptors and checks
 * the committed one is the same, then parses each document with the
 * generated TypeScript types and writes it back unchanged. The Rust test
 * (packages/runner-protocol/tests/proto_round_trip.rs) parses and writes the
 * same files with the generated Rust types. Together: both sides read and
 * write the same bytes for every message.
 *
 * `node packages/server/test/runner-proto-test.ts --write` rewrites the
 * corpus after a schema change. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { create, fromJson, toJson, type DescMessage, type DescField, type JsonValue } from "@bufbuild/protobuf";
import { file_runner } from "../src/gen/runner_pb.js";

const FIXTURES = path.join(import.meta.dirname, "../../runner-protocol/proto/fixtures");

function allMessages(): DescMessage[] {
  const out: DescMessage[] = [];
  const visit = (message: DescMessage) => { out.push(message); message.nestedMessages.forEach(visit); };
  file_runner.messages.forEach(visit);
  return out;
}

const fixedTime = { seconds: 1791590400n, nanos: 0 };

/** A value for one field that is not its default. */
function sample(field: DescField, depth: number): unknown {
  const scalar = (kind: number | undefined, name: string, number: number): unknown => {
    switch (kind) {
      case 9: return `${name}-${number}`; // string
      case 8: return true; // bool
      case 12: return new TextEncoder().encode(`${name}-${number}`); // bytes
      case 3: case 4: case 6: case 16: case 18: return BigInt(1000 + number); // 64-bit
      case 1: case 2: return number + 0.5; // double, float
      default: return number + 1; // 32-bit integers
    }
  };
  const message = (desc: DescMessage): unknown => {
    if (desc.typeName === "google.protobuf.Timestamp") return create(desc, fixedTime);
    if (desc.typeName === "google.protobuf.Duration") return create(desc, { seconds: 2n, nanos: 500000000 });
    return populate(desc, depth + 1, new Map());
  };
  const enumValue = (values: { number: number }[]) => values[values.length - 1].number;
  switch (field.fieldKind) {
    case "scalar": return scalar(field.scalar, field.name, field.number);
    case "enum": return enumValue(field.enum.values);
    case "message": return message(field.message);
    case "list":
      return [field.listKind === "message" ? message(field.message) : field.listKind === "enum" ? enumValue(field.enum.values)
        : scalar(field.scalar, field.name, field.number)];
    case "map": {
      const value = field.mapKind === "message" ? message(field.message) : field.mapKind === "enum" ? enumValue(field.enum.values)
        : scalar(field.scalar, field.name, field.number);
      return { [`${field.name}-key`]: value };
    }
  }
}

/** Every field set; `cases` picks the member of each oneof (default: the first). */
function populate(desc: DescMessage, depth: number, cases: Map<string, string>): unknown {
  const init: Record<string, unknown> = {};
  if (depth > 8) return create(desc);
  for (const member of desc.members) {
    if (member.kind === "oneof") {
      const chosen = member.fields.find(field => field.name === cases.get(member.name)) ?? member.fields[0];
      init[member.localName] = { case: chosen.localName, value: sample(chosen, depth) };
    } else init[member.localName] = sample(member, depth);
  }
  return create(desc, init as never);
}

/** File name → document: `<Message>.json`, or `<Message>.<oneof case>.json`. */
function corpus(): Map<string, { desc: DescMessage; json: JsonValue }> {
  const out = new Map<string, { desc: DescMessage; json: JsonValue }>();
  for (const desc of allMessages()) {
    const oneof = desc.oneofs[0];
    assert.ok(desc.oneofs.length <= 1, `${desc.typeName}: one oneof per message keeps the corpus one file per case`);
    const variants = oneof ? oneof.fields.map(field => [`${desc.typeName}.${field.name}`, new Map([[oneof.name, field.name]])] as const)
      : [[desc.typeName, new Map<string, string>()] as const];
    for (const [name, cases] of variants) {
      const message = populate(desc, 0, cases);
      out.set(`${name.replace(/^cube\.runner\.v4\./, "")}.json`, { desc, json: toJson(desc, message as never) });
    }
  }
  return out;
}

const expected = corpus();
const text = (json: JsonValue) => `${JSON.stringify(json, null, 2)}\n`;

if (process.argv.includes("--write")) {
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [name, { json }] of expected) fs.writeFileSync(path.join(FIXTURES, name), text(json));
  console.log(`wrote ${expected.size} fixtures to ${FIXTURES}`);
  process.exit(0);
}

const committed = fs.readdirSync(FIXTURES).filter(name => name.endsWith(".json")).sort();
assert.deepEqual(committed, [...expected.keys()].sort(), "the committed corpus has one file per message and oneof case (run with --write)");
let fields = 0;
for (const name of committed) {
  const { desc, json } = expected.get(name)!;
  const bytes = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  assert.equal(bytes, text(json), `${name} is what the schema derives (run with --write)`);
  const parsed = fromJson(desc, JSON.parse(bytes) as JsonValue);
  assert.deepEqual(toJson(desc, parsed), JSON.parse(bytes), `${name} round-trips through the TypeScript types`);
  fields += Object.keys(JSON.parse(bytes) as object).length;
}

// The corpus says something: spot-check literal values a reader can follow.
const machine = JSON.parse(fs.readFileSync(path.join(FIXTURES, "Machine.json"), "utf8")) as Record<string, any>;
assert.equal(machine.fenceEpoch, "1005", "int64 is a JSON string");
assert.equal(machine.status.phase, "FAILED", "enums are their names");
assert.equal(machine.status.guest.ready, true);
assert.deepEqual(machine.status.guest.hooks, { "hooks-key": "hooks-9" });
assert.equal(machine.status.startedAt, "2026-10-10T00:00:00Z");
const open = JSON.parse(fs.readFileSync(path.join(FIXTURES, "Open.guest.json"), "utf8")) as Record<string, any>;
assert.deepEqual(Object.keys(open), ["guest"], "a oneof writes only its case");
assert.equal(open.guest.op, "op-3");
assert.ok(committed.length >= 70, `${committed.length} documents`);
console.log(`runner proto: ${committed.length} documents (${expected.size} derived), ${fields} top-level fields, all round-trip in TypeScript`);
