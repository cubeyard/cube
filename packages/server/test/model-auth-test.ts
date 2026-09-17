import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCubed } from "../src/index.ts";
import type { ModelAuth } from "../src/model-auth.ts";
import { authFixture } from "./model-auth-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-auth-"));
let fixture = await authFixture(root);
let app = await createCubed({ state: root, models: fixture.runtime });
async function listen() {
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address(); assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
let base = await listen();
const route = "/api/providers/auth-fixture";
async function request(route: string, method = "GET", body?: unknown, status = 200) {
  const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text();
  for (const secret of ["fixture-access-secret", "fixture-refresh-secret", "key-for-persistence", "reject-this-secret", "private-redirect-code"]) assert(!text.includes(secret), "HTTP response leaked secret");
  assert.equal(response.status, status, text);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return JSON.parse(text);
}
async function provider() {
  const result: { providers: Awaited<ReturnType<ModelAuth["list"]>> } = await request("/api/providers");
  return result.providers.find(provider => provider.id === "auth-fixture")!;
}
async function wait(predicate: (state: Awaited<ReturnType<typeof provider>>) => boolean) {
  for (let i = 0; i < 200; i++) {
    const value = await provider(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("auth state timed out");
}
async function answer(value: string) {
  const { flow } = await wait(provider => !!provider.flow?.prompt);
  return request(`${route}/answer`, "POST", { flowId: flow!.id, promptId: flow!.prompt!.id, value });
}
async function available() { return (await request("/api/models")).models.filter((model: { provider: string }) => model.provider === "auth-fixture"); }
try {
  assert.equal((await provider()).connected, false);
  assert.deepEqual(await available(), []);
  await request(`${route}/login`, "POST", { type: "api_key" });
  assert.equal((await wait(provider => !!provider.flow?.prompt)).flow!.prompt!.type, "secret");
  await request(`${route}/login`, "POST", { type: "oauth" }, 409);
  await answer("key-for-persistence");
  await wait(provider => provider.connected && provider.flow?.state === "connected");
  assert.deepEqual((await available()).map((model: { id: string }) => model.id), ["fixture-model", "discovered-model"], "catalog exposes models discovered during login refresh");
  assert(fixture.refreshCount() > 0, "login must refresh catalog without host restart");
  await app.close();
  fixture = await authFixture(root);
  app = await createCubed({ state: root, models: fixture.runtime }); base = await listen();
  assert.equal((await provider()).connected, true, "Pi persisted login across host recreation");
  assert.equal((await available()).length, 1);
  await request(route, "DELETE");
  assert.equal((await provider()).connected, false);
  assert.deepEqual(await available(), []);
  await request(`${route}/login`, "POST", { type: "api_key" });
  await answer("reject-this-secret");
  assert.match((await wait(provider => provider.flow?.state === "error")).flow!.error!, /login could not finish/);
  for (const method of ["browser", "device", "callback"]) {
    await request(`${route}/login`, "POST", { type: "oauth" });
    await answer(method);
    if (method !== "callback") {
      const pending = await wait(provider => provider.flow?.prompt?.type === (method === "browser" ? "manual_code" : "text"));
      assert(pending.flow!.events.some(event => event.type === (method === "browser" ? "auth_url" : "device_code")));
      await answer("private-redirect-code");
    }
    await wait(provider => provider.connected && provider.flow?.state === "connected");
    assert.equal((await provider()).type, "oauth");
    await request(`${route}/refresh`, "POST", {});
    await request(route, "DELETE");
  }
  await request(`${route}/login`, "POST", { type: "oauth" });
  const pending = await wait(provider => !!provider.flow?.prompt);
  await request(`${route}/login`, "DELETE");
  assert.equal((await provider()).flow!.state, "cancelled");
  await request(`${route}/answer`, "POST", { flowId: pending.flow!.id, promptId: pending.flow!.prompt!.id, value: "browser" }, 409);
  assert.deepEqual(await available(), []);
  await request(`${route}/login`, "POST", { type: "api_key" });
  await app.close();
  fixture = await authFixture(root); app = await createCubed({ state: root, models: fixture.runtime }); base = await listen();
  assert.equal((await provider()).flow, null, "restart drops transient pending interaction, not credentials");
  assert.equal((await provider()).connected, false, "logout persists across restart");
  console.log("ok: Pi credential persistence; API-key/OAuth browser/device/callback; cancellation, safe errors, stale prompts, logout, live catalog and restart; no paid calls");
} finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
