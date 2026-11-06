---
title: reach cube from other devices
description: Open cube from a phone or another computer over Tailscale or an authenticated proxy, and give thread web servers URLs there.
---

cubed has no login of its own. It listens on `127.0.0.1:7777`, and anyone who reaches it is you. They can start threads that push with your GitHub token. To use cube from another device, put a private network or an authenticated proxy in front of it. Never expose it to the public internet.

## use Tailscale

1. Install Tailscale on the cubed host and on your devices, in one tailnet.
2. Find the host's Tailscale address and name: `tailscale ip -4`, and its MagicDNS name, for example `mymac.tailnet.ts.net`.
3. Add them to cubed's environment file, `~/.config/cubed/environment`:

   ```sh
   CUBED_HOST=100.64.0.2
   CUBED_ALLOWED_HOSTS=mymac.tailnet.ts.net,100.64.0.2
   ```

4. Restart cubed. On macOS: `brew services restart cubeyard/tap/cube`.
5. Open `http://mymac.tailnet.ts.net:7777` on another device of the tailnet.

`CUBED_ALLOWED_HOSTS` protects against DNS rebinding. It is not access control. Use Tailscale's access controls to decide which devices may reach the port.

:::danger
`CUBED_HOST=0.0.0.0` listens on every IPv4 interface, not only Tailscale's. Never use it on a network you do not control.
:::

## use a proxy

Keep cubed on loopback and put an HTTPS reverse proxy with its own authentication in front of it. List the proxy's host name in `CUBED_ALLOWED_HOSTS`. Every client the proxy admits has full access to cube.

## the portal for thread web servers

Thread web servers get URLs through cube's portal, a second listener with the same rule: no login, plain HTTP, private or loopback addresses only. Under Homebrew it is on by default for a browser on the same Mac. For other devices, give it the Tailscale address:

```sh
CUBED_PORTAL_IP=100.64.0.2
```

Restart cubed. `http://127.0.0.1:7777/api/health` then reports `"portal": "listening"`, and every running machine learns its new URLs. Service URLs look like `http://web-<label>.100-64-0-2.sslip.io:7780/`.

| variable | default | meaning |
|---|---|---|
| `CUBED_PORTAL_IP` | off (Homebrew: `127.0.0.1`) | the private address browsers use |
| `CUBED_PORTAL_PORT` | `7780` | the portal's port, in every URL |
| `CUBED_PORTAL_LISTEN` | `CUBED_PORTAL_IP` | the address it binds; private or loopback IPv4 only |
| `CUBED_PORTAL_DOMAIN` | `sslip.io` (Homebrew: `localhost`) | `sslip.io` or `nip.io`, a wildcard domain of your own that resolves to the IP, or `localhost` |

cubed refuses public addresses and `0.0.0.0` for the portal, and refuses to start on a malformed setting. `CUBED_PORTAL_IP=` (empty) turns the Homebrew portal off. See [web servers in a thread](/cube/use/services/) for what the portal allows.
