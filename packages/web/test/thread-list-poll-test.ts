/** The polled thread list: an unchanged list (a 304) is the same array, with no body read. */
import assert from "node:assert/strict";
import { fetchThreads } from "../src/lib/api.ts";

const sent: Array<string | null> = [];
let reply: () => Response = () => new Response(null, { status: 500 });
globalThis.fetch = (async (_path: string, init?: RequestInit) => {
  sent.push(new Headers(init?.headers).get("if-none-match"));
  return reply();
}) as typeof fetch;
const list = (title: string, etag: string) => () => new Response(JSON.stringify({ threads: [{ id: "t1", title }] }), { status: 200, headers: { etag } });

reply = list("a", '"one"');
const first = await fetchThreads(true);
reply = () => new Response(null, { status: 304, headers: { etag: '"one"' } });
const again = await fetchThreads(true);
assert.equal(again, first, "a 304 gives back the same array");
reply = list("b", '"two"');
const changed = await fetchThreads(true);
assert.equal(changed[0]!.title, "b");
reply = () => new Response(null, { status: 304, headers: { etag: '"two"' } });
assert.equal(await fetchThreads(true), changed);
assert.deepEqual(sent, [null, '"one"', '"one"', '"two"'], "each poll sends the ETag of the list it has");
reply = list("c", '"x"');
assert.equal((await fetchThreads(false))[0]!.title, "c", "each query keeps its own list");
console.log("ok: the polled thread list sends its ETag, and a 304 is the same array");
