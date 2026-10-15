# Spike 4d: which access paths can use passkeys

Throwaway spike for the authorization plan (2026-10-15). Not product code.
Results and implications: `/tmp/authz/spike-d.md` (copied into the plan).

- `rp.mjs`: a tiny WebAuthn relying party (Node http/https,
  `@simplewebauthn/server` 13 installed outside the repo in `/tmp/authz/node`).
  Registration asks for `residentKey: "required"`, `userVerification:
  "required"`; authentication uses empty `allowCredentials`. The server checks
  clientDataJSON type/challenge/origin, rpIdHash, UP, UV and the signature
  (`requireUserVerification: true`), then sets `sid` with `HttpOnly; Secure;
  SameSite=Strict`. `RP_ORIGIN` is the configured origin (`CUBED_ORIGIN`);
  `from-host` derives it from the request instead, to show why that is wrong
  behind a proxy.
- `certs.sh`: a local CA and one leaf for the simulated HTTPS names, plus its
  SPKI hash for `--ignore-certificate-errors-spki-list`.
- `Caddyfile`: loopback-only TLS proxies with `basic_auth` (user `spike`,
  password `spike-pass`), one of them path-prefixed (`/cube/`).
- `run.mjs`: starts the RPs and Caddy on 127.0.0.0/8, then for each origin
  launches Playwright Chromium (`channel: "chromium"`, new headless), maps the
  names to 127.0.0.1 with `--host-resolver-rules`, adds a CDP virtual
  authenticator (ctap2, internal, resident keys, UV) and runs create/get,
  the UV-false variants and a Secure cookie probe. The plain-HTTP tailnet IP
  case loads `http://100.64.0.10:18467/` through a loopback HTTP proxy (the
  RP itself), so nothing touches the tailnet interface.

```sh
export PATH=$HOME/.local/share/mise/installs/node/26.8.1/bin:$PATH
npm install --prefix /tmp/authz/node @simplewebauthn/server@13
bash certs.sh /tmp/authz/pk
node run.mjs > /tmp/authz/pk/results.json
```
