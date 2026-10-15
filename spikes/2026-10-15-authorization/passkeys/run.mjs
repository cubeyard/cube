// Spike 4d driver: starts loopback RPs and Caddy, drives Chromium with a CDP
// virtual authenticator against each origin, prints JSON results.
// Run certs.sh first. Everything binds 127.0.0.0/8 only.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const { chromium } = createRequire(path.join(repo, "packages/web/package.json"))("playwright");
const pk = "/tmp/authz/pk";
const spki = fs.readFileSync(`${pk}/leaf.spki`, "utf8").trim();
const caddy = process.env.CADDY ?? `${process.env.HOME}/.local/bin/caddy`;

const names = ["server1.tail832c1.ts.net", "cube.example.test", "example.test", "cube.example.com"];
const resolver = `--host-resolver-rules=${names.map((n) => `MAP ${n} 127.0.0.1`).join(", ")}`;
const tlsEnv = { RP_TLS_CERT: `${pk}/chain.crt`, RP_TLS_KEY: `${pk}/leaf.key` };

const rps = [
  { RP_PORT: 18451, RP_ID: "localhost", RP_ORIGIN: "http://localhost:18451" },
  { RP_PORT: 18452, RP_ID: "127.0.0.1", RP_ORIGIN: "http://127.0.0.1:18452" },
  { RP_PORT: 18453, RP_BIND: "127.0.0.2", RP_ID: "127.0.0.2", RP_ORIGIN: "http://127.0.0.2:18453" },
  { RP_PORT: 18454, RP_ID: "server1.tail832c1.ts.net", RP_ORIGIN: "http://server1.tail832c1.ts.net:18454" },
  { RP_PORT: 18455, RP_ID: "server1.tail832c1.ts.net", RP_ORIGIN: "https://server1.tail832c1.ts.net:18455", ...tlsEnv },
  { RP_PORT: 18457, RP_ID: "cube.example.test", RP_ORIGIN: "https://cube.example.test:18456" },
  { RP_PORT: 18458, RP_ID: "cube.example.test", RP_ORIGIN: "from-host" },
  { RP_PORT: 18465, RP_ID: "localhost", RP_ORIGIN: "https://cube.example.test:18464" },
  { RP_PORT: 18461, RP_ID: "example.test", RP_ORIGIN: "https://example.test:18460", RP_COOKIE_PATH: "/cube/" },
  { RP_PORT: 18462, RP_ID: "cube.example.com", RP_ORIGIN: "https://cube.example.com:18462", ...tlsEnv },
  { RP_PORT: 18463, RP_ID: "example.com", RP_ORIGIN: "https://cube.example.com:18463", ...tlsEnv },
  { RP_PORT: 18467, RP_ID: "100.64.0.10", RP_ORIGIN: "http://100.64.0.10:18467" },
  { RP_PORT: 18466, RP_ID: "com", RP_ORIGIN: "https://cube.example.com:18466", ...tlsEnv },
];

const auth = { username: "spike", password: "spike-pass" };
const cases = [
  { id: "1 localhost", url: "http://localhost:18451/" },
  { id: "2 127.0.0.1", url: "http://127.0.0.1:18452/" },
  { id: "3a 127.0.0.2 (tailnet IP stand-in)", url: "http://127.0.0.2:18453/" },
  { id: "3c http tailnet IP via loopback proxy", url: "http://100.64.0.10:18467/", proxy: "http://127.0.0.1:18467" },
  { id: "3b http MagicDNS name", url: "http://server1.tail832c1.ts.net:18454/" },
  { id: "4a https MagicDNS, trusted (spki)", url: "https://server1.tail832c1.ts.net:18455/" },
  { id: "4b https MagicDNS, --ignore-certificate-errors", url: "https://server1.tail832c1.ts.net:18455/", untrusted: "flag" },
  { id: "4c https MagicDNS, interstitial clicked through", url: "https://server1.tail832c1.ts.net:18455/", untrusted: "interstitial" },
  { id: "5a proxy, RP origin=configured", url: "https://cube.example.test:18456/", auth },
  { id: "5b proxy, RP origin=from Host", url: "https://cube.example.test:18459/", auth },
  { id: "5c proxy, RP ID=localhost", url: "https://cube.example.test:18464/", auth },
  { id: "5d proxy, path prefix /cube/", url: "https://example.test:18460/cube/", auth },
  { id: "6a public name, rpId=cube.example.com", url: "https://cube.example.com:18462/" },
  { id: "6b public name, rpId=example.com", url: "https://cube.example.com:18463/" },
  { id: "6c public name, rpId=com (public suffix)", url: "https://cube.example.com:18466/" },
];

const procs = [];
function start(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
  procs.push(p);
  return p;
}
for (const rp of rps) start(process.execPath, [path.join(here, "rp.mjs")], Object.fromEntries(Object.entries(rp).map(([k, v]) => [k, String(v)])));
start(caddy, ["run", "--config", path.join(here, "Caddyfile"), "--adapter", "caddyfile"], {});
await new Promise((r) => setTimeout(r, 2500));

async function addAuthenticator(cdp, isUserVerified, hasUserVerification = true) {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification, isUserVerified },
  });
  return authenticatorId;
}

async function runCase(browserArgs, c) {
  const browser = await chromium.launch({ channel: "chromium", args: browserArgs, ...(c.proxy ? { proxy: { server: c.proxy } } : {}) });
  const version = browser.version();
  const ctx = await browser.newContext(c.auth ? { httpCredentials: c.auth } : {});
  const page = await ctx.newPage();
  const out = { case: c.id, url: c.url, version };
  try {
    if (c.untrusted === "interstitial") {
      try { await page.goto(c.url); } catch (e) { out.navError = String(e.message).split("\n")[0]; }
      out.interstitialTitle = await page.title();
      out.interstitialHasProceed = await page.locator("#proceed-link").count();
      await page.click("#details-button");
      await Promise.all([page.waitForNavigation(), page.click("#proceed-link")]);
      await page.waitForFunction(() => typeof window.register === "function", null, { timeout: 10000 });
    } else {
      const resp = await page.goto(c.url);
      out.status = resp?.status();
    }
    // Before any virtual authenticator exists: does Chromium's own TLS check refuse the call?
    out.createBeforeVirtualEnv = await page.evaluate(() => {
      const t0 = performance.now();
      return navigator.credentials?.create({ publicKey: { challenge: new Uint8Array(32), rp: { name: "x" },
        user: { id: new Uint8Array(8), name: "x", displayName: "x" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 3000 }, signal: AbortSignal.timeout(2000) })
        .then(() => "resolved", (e) => `${e.name}: ${e.message} (${Math.round(performance.now() - t0)} ms)`) ?? "no navigator.credentials";
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    out.info = await page.evaluate(() => window.info());
    const authId = await addAuthenticator(cdp, true);
    out.create = await page.evaluate(() => window.register("required"));
    out.get = await page.evaluate(() => window.login("required"));
    out.cookie = await page.evaluate(() => window.whoami());
    // UV false: the same credential, authenticator stops verifying the user.
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId: authId, isUserVerified: false });
    out.getUvFalseRequired = await page.evaluate(() => window.login("required"));
    out.getUvFalseDiscouraged = await page.evaluate(() => window.login("discouraged"));
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authId });
    const noUvId = await addAuthenticator(cdp, false);
    out.createUvFalseRequired = await page.evaluate(() => window.register("required"));
    out.createUvFalseDiscouraged = await page.evaluate(() => window.register("discouraged"));
    // Authenticator without UV at all, client asks for no UV: does the server refuse UV=0?
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: noUvId });
    await addAuthenticator(cdp, false, false);
    out.createNoUvAuthDiscouraged = await page.evaluate(() => window.register("discouraged"));
    out.cookieProbe = await page.evaluate(() => window.cookieProbe());
  } catch (e) {
    out.error = String(e.message ?? e).split("\n")[0];
  }
  await browser.close();
  return out;
}

const results = [];
try {
  for (const c of cases) {
    const trust = { flag: ["--ignore-certificate-errors"], interstitial: [] }[c.untrusted] ?? [`--ignore-certificate-errors-spki-list=${spki}`];
    const args = [resolver, ...trust];
    results.push(await runCase(args, c));
  }
} finally {
  for (const p of procs) p.kill();
}
console.log(JSON.stringify(results, null, 1));
