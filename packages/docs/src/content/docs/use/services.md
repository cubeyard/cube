---
title: web servers in a thread
description: How a thread's agent runs a web server with cube service, and how cube's private portal gives you a URL for it.
---

A thread's agent can run a web server in its machine and give you a URL for it: a preview of a site it builds, a report, a tool. The agent runs it with `cube service`, and cube's **portal** passes your browser's requests to it.

## what the agent runs

In its machine, the agent starts a server under a name:

```sh
cube service start web --port 5173 -- pnpm dev --host 0.0.0.0
```

`start` runs the command as a supervised service that outlives the command that started it. It waits until something listens on the port, then prints the URL. The service restarts when it fails and when the machine boots again. `cube service list`, `status`, `logs`, `restart` and `stop` manage it. The whole command is in the [command-line reference](/cube/reference/cli/#cube-inside-a-thread-machine).

Rules the agent follows:

- The server must listen on `0.0.0.0`, not only on `127.0.0.1`. The portal reaches it over the machine's network. Many dev servers need a flag for that, such as `vite --host 0.0.0.0`.
- Names are 1 to 24 lowercase letters, digits and dashes. Ports are 1024 to 65535, one service per port, at most 16 services per machine.
- Plain HTTP and WebSocket only.

A machine with a registered service is not suspended for being idle.

## where the URL works

Each service gets its own origin:

```text
http://<service>-<thread label>.<suffix>:<port>/
```

The portal is off unless you configure it, except under Homebrew:

| setup | URLs look like | they open |
|---|---|---|
| Homebrew, by default | `http://web-<label>.localhost:7780/` | in a browser on the Mac that runs cube only |
| `CUBED_PORTAL_IP` set to a Tailscale address | `http://web-<label>.100-101-102-103.sslip.io:7780/` | on every device of your tailnet that may reach the port |
| no portal | none | the service still runs, and `cube service` says there is no portal |

To set up the portal for other devices, see [reach cube from other devices](/cube/run/private-network/#the-portal-for-thread-web-servers).

## what the portal allows

- Only the exact host names of registered services, on the registered port. The portal serves no page of cube's own, so a rebinding attack reaches nothing.
- Only while the thread's machine runs. The portal never starts or wakes a machine, so a sleeping thread answers 503.
- Cookies a service sets stay with that one service's host.
- Archiving a thread takes its services off at once.

## limits

- **No login.** Anyone who can reach the port and knows a URL reaches the service. Labels are hard to guess but not secret, since they appear in transcripts.
- **Plain HTTP.** Keep the port on a private network. Tailscale encrypts the traffic between devices.
- **`localhost` URLs reach only the browser's own machine.** On a phone, a `*.localhost` URL goes to the phone.
- **sslip.io is public DNS.** It sees the names asked for. Resolvers with rebinding protection refuse public names that resolve to private addresses. Allow `sslip.io` there, or use a wildcard record in your own DNS with `CUBED_PORTAL_DOMAIN`.
