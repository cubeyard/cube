// Tiny WebAuthn relying party for spike 4d. Not product code.
//
// Env:
//   RP_PORT, RP_BIND (loopback address), RP_ID, RP_ORIGIN (expected origin, the
//   configured "CUBED_ORIGIN"; "from-host" derives it from the request instead),
//   RP_TLS_CERT/RP_TLS_KEY (serve HTTPS directly), RP_COOKIE_PATH (default /),
//   SWA_DIR (directory holding node_modules/@simplewebauthn/server).
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire((process.env.SWA_DIR ?? "/tmp/authz/node") + "/");
const swa = require("@simplewebauthn/server");

const port = Number(process.env.RP_PORT ?? 18450);
const bind = process.env.RP_BIND ?? "127.0.0.1";
const rpID = process.env.RP_ID ?? "localhost";
const originCfg = process.env.RP_ORIGIN ?? `http://localhost:${port}`;
const cookiePath = process.env.RP_COOKIE_PATH ?? "/";
const tls = process.env.RP_TLS_CERT
  ? { cert: fs.readFileSync(process.env.RP_TLS_CERT), key: fs.readFileSync(process.env.RP_TLS_KEY) }
  : null;

const credentials = new Map(); // credential id -> { publicKey, counter }
const challenges = new Map(); // challenge -> kind
const sessions = new Set();

function expectedOrigin(req) {
  if (originCfg !== "from-host") return originCfg;
  // Naive: what the RP itself sees. Behind a TLS-terminating proxy this is http://.
  return `${tls ? "https" : "http"}://${req.headers.host}`;
}

const page = `<!doctype html><meta charset=utf-8><title>passkey spike</title>
<script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/") + "===".slice((s.length+3)%4)), c => c.charCodeAt(0));
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
}
window.info = () => ({ isSecureContext, origin: location.origin, hasPKC: typeof PublicKeyCredential !== "undefined" });
window.register = async (uv = "required", rk = "required") => {
  const o = (await post("api/reg/options", { uv, rk })).body;
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64u(o.challenge), rp: o.rp, user: { ...o.user, id: unb64u(o.user.id) },
      pubKeyCredParams: o.pubKeyCredParams, timeout: 10000, attestation: "none",
      authenticatorSelection: o.authenticatorSelection } });
  } catch (e) { return { stage: "create", error: e.name + ": " + e.message }; }
  const r = await post("api/reg/verify", { id: cred.id, rawId: b64u(cred.rawId), type: cred.type,
    response: { clientDataJSON: b64u(cred.response.clientDataJSON), attestationObject: b64u(cred.response.attestationObject),
      transports: cred.response.getTransports?.() ?? [] }, clientExtensionResults: cred.getClientExtensionResults() });
  return { stage: "verify", ...r };
};
window.login = async (uv = "required") => {
  const o = (await post("api/auth/options", { uv })).body;
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: { challenge: unb64u(o.challenge), rpId: o.rpId,
      allowCredentials: [], userVerification: o.userVerification, timeout: 10000 } });
  } catch (e) { return { stage: "get", error: e.name + ": " + e.message }; }
  const r = await post("api/auth/verify", { id: a.id, rawId: b64u(a.rawId), type: a.type,
    response: { clientDataJSON: b64u(a.response.clientDataJSON), authenticatorData: b64u(a.response.authenticatorData),
      signature: b64u(a.response.signature), userHandle: a.response.userHandle ? b64u(a.response.userHandle) : undefined },
    clientExtensionResults: a.getClientExtensionResults() });
  return { stage: "verify", ...r };
};
window.whoami = async () => (await fetch("api/whoami")).json();
window.cookieProbe = async () => { await fetch("api/setcookie"); return (await fetch("api/whoami")).json(); };
</script><p>passkey spike</p>`;

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d ? JSON.parse(d) : {}));
  });
}
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const seen = { host: req.headers.host, xfh: req.headers["x-forwarded-host"], xfp: req.headers["x-forwarded-proto"], origin: req.headers.origin };
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  if (url.pathname === "/api/setcookie") {
    return send(res, 200, { ok: true }, { "set-cookie": `probe=1; HttpOnly; Secure; SameSite=Strict; Path=${cookiePath}` });
  }
  if (url.pathname === "/api/whoami") {
    const sid = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return send(res, 200, { cookieHeader: req.headers.cookie ?? null, authenticated: !!sid && sessions.has(sid), seen });
  }
  const body = await readBody(req);
  try {
    if (url.pathname === "/api/reg/options") {
      const o = await swa.generateRegistrationOptions({
        rpName: "cube spike", rpID, userName: "me", userDisplayName: "me", attestationType: "none",
        authenticatorSelection: { residentKey: body.rk ?? "required", userVerification: body.uv ?? "required" },
      });
      challenges.set(o.challenge, "reg");
      return send(res, 200, o);
    }
    if (url.pathname === "/api/reg/verify") {
      const clientData = JSON.parse(Buffer.from(body.response.clientDataJSON, "base64url").toString());
      if (challenges.get(clientData.challenge) !== "reg") return send(res, 400, { error: "unknown challenge" });
      challenges.delete(clientData.challenge);
      const v = await swa.verifyRegistrationResponse({
        response: body, expectedChallenge: clientData.challenge, expectedOrigin: expectedOrigin(req),
        expectedRPID: rpID, requireUserPresence: true, requireUserVerification: true,
      });
      if (!v.verified) return send(res, 400, { error: "not verified" });
      const c = v.registrationInfo.credential;
      credentials.set(c.id, { publicKey: c.publicKey, counter: c.counter });
      return send(res, 200, { ok: true, uv: v.registrationInfo.userVerified, clientOrigin: clientData.origin, seen });
    }
    if (url.pathname === "/api/auth/options") {
      const o = await swa.generateAuthenticationOptions({ rpID, allowCredentials: [], userVerification: body.uv ?? "required" });
      challenges.set(o.challenge, "auth");
      return send(res, 200, o);
    }
    if (url.pathname === "/api/auth/verify") {
      const clientData = JSON.parse(Buffer.from(body.response.clientDataJSON, "base64url").toString());
      if (challenges.get(clientData.challenge) !== "auth") return send(res, 400, { error: "unknown challenge" });
      challenges.delete(clientData.challenge);
      const stored = credentials.get(body.id);
      if (!stored) return send(res, 400, { error: "unknown credential" });
      const v = await swa.verifyAuthenticationResponse({
        response: body, expectedChallenge: clientData.challenge, expectedOrigin: expectedOrigin(req),
        expectedRPID: rpID, requireUserVerification: true,
        credential: { id: body.id, publicKey: stored.publicKey, counter: stored.counter },
      });
      if (!v.verified) return send(res, 400, { error: "not verified" });
      stored.counter = v.authenticationInfo.newCounter;
      const sid = crypto.randomBytes(16).toString("base64url");
      sessions.add(sid);
      return send(res, 200, { ok: true, uv: v.authenticationInfo.userVerified, clientOrigin: clientData.origin, seen }, {
        "set-cookie": `sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=${cookiePath}`,
      });
    }
  } catch (e) {
    return send(res, 400, { error: String(e.message ?? e), expectedOrigin: expectedOrigin(req), seen });
  }
  send(res, 404, { error: "not found" });
}

const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
server.listen(port, bind, () => console.log(`rp ${tls ? "https" : "http"}://${bind}:${port} rpID=${rpID} origin=${originCfg}`));
