/** Controlled provider interaction; real Pi runtime and file credential store. */
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fauxProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createCubed } from "../src/index.ts";

export async function authFixture(directory: string) {
  const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "auth-fixture", models: [{ id: "fixture-model" }, { id: "discovered-model" }] });
  const token = (): OAuthCredential => ({ type: "oauth", access: "fixture-access-secret", refresh: "fixture-refresh-secret", expires: Date.now() + 3600_000 });
  let refreshed = 0;
  runtime.registerNativeProvider({ ...faux.provider, name: "fixture provider",
    getModels: () => refreshed ? faux.models : faux.models.slice(0, 1),
    auth: {
      apiKey: { name: "fixture key", async login(interaction) {
        const key = await interaction.prompt({ type: "secret", message: "api key" });
        if (key === "reject-this-secret") throw new Error(key);
        if (!key) throw new Error("key required");
        return { type: "api_key", key };
      }, async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; } },
      oauth: { name: "fixture oauth", loginLabel: "log in", async login(interaction) {
        const method = await interaction.prompt({ type: "select", message: "login method", options: [
          { id: "browser", label: "browser" }, { id: "device", label: "device code" }, { id: "callback", label: "automatic callback" },
        ] });
        if (method === "device") {
          interaction.notify({ type: "device_code", userCode: "CUBE-1234", verificationUri: "https://example.com/device", expiresInSeconds: 120 });
          await interaction.prompt({ type: "text", message: "confirm device approval" });
        } else {
          interaction.notify({ type: "auth_url", url: "https://example.com/oauth", instructions: "open the browser and paste the final redirect url" });
          for (let i = 0; i < 12; i++) interaction.notify({ type: "progress", message: "waiting for authorization" });
          const callback = new AbortController();
          const pending = interaction.prompt({ type: "manual_code", message: "redirect url or code", signal: callback.signal });
          if (method === "callback") {
            await setTimeout(20, undefined, { signal: interaction.signal });
            callback.abort();
            await pending.catch(() => {});
          } else await pending;
        }
        return token();
      }, async refresh() { return token(); }, async toAuth(credential) { return { apiKey: credential.access }; } },
    },
    async refreshModels(context) {
      if (context.allowNetwork) {
        await context.publish({ update: () => { refreshed++; } });
      }
    },
  });
  return { runtime, refreshCount: () => refreshed };
}

if (import.meta.main) {
  const directory = process.argv[2];
  const { runtime } = await authFixture(directory);
  const app = await createCubed({ state: directory, models: runtime, web: path.resolve("packages/web/dist") });
  app.server.listen(Number(process.env.CUBED_PORT ?? 7778), "127.0.0.1");
  process.on("SIGTERM", () => { void app.close().then(() => process.exit()); });
}
