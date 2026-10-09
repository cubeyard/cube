# Security and the private network

- **The thread machine is the sandbox.** A thread's commands run as user
  `agent` (with sudo) inside its QEMU guest, and its file tools reach any
  file in that guest (`/workspace`, `/home/agent`, `/tmp`, …) but never the
  host's or another thread's. Its files, processes and network are its own; it holds no real credential; its only network is cube's
  gateway, which allows HTTP and HTTPS to public addresses and asks cubed's
  policy about every request. It cannot reach cubed, the runner, your LAN or
  a metadata service.
- **The host is not.** QEMU runs as the runner's account, hardened only by
  `-sandbox on` on Linux and not at all on macOS. A QEMU escape has that
  account's authority. On the one-Mac setup ([macOS with Homebrew](macos.md))
  that account is yours: the
  runner can read every machine disk it hosts, and a guest escape would run as
  you. Give a runner that matters a dedicated account or machine without SSH,
  cloud, browser, Git or provider credentials.
- **cubed's own processes are not sandboxed either.** Pi, codemode's worker
  and Claude Code run on the cubed host as the user who runs cubed, with that
  user's files and the model credentials; only the tools they call run in the
  thread's machine.
- **The agent can act with what it is given.** It can push to GitHub with
  your token through the gateway (github.com and api.github.com only) and send
  what it reads to any public HTTPS host. Give projects the repositories you
  mean it to touch.
- **cubed has no user authentication.** It binds `127.0.0.1:7777`. Anyone
  who reaches it is you. For access from other devices use an authenticated
  reverse proxy, or Tailscale: set `CUBED_HOST` to the Mac's Tailscale IP and
  list the exact MagicDNS name and IP in `CUBED_ALLOWED_HOSTS` (DNS-rebinding
  protection, not access control). Never bind `0.0.0.0` on a network you do
  not control. [SECURITY.md](../SECURITY.md) has the reporting process.
- **Updates are signed, Homebrew's by proxy.** Release bundles carry
  Ed25519-signed manifests (trust anchor `scripts/cubed/update-public-key.pem`)
  that the managed launcher and the runner's updater verify. The Homebrew
  formulas are generated from those manifests and pin each asset's sha256,
  but a Homebrew user trusts the tap's commits: whoever can write the tap
  (the `homebrew` workflow's token, the tap's maintainers) can publish a
  formula.
