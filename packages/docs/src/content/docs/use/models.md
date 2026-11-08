---
title: models
description: Connect model providers for Pi threads, run Claude Code threads with your own subscription, and choose a thread's model.
---

A thread's agent is either Pi, with any model a connected provider offers, or Claude Code, with your own Claude subscription. Both run on the cubed host and send their tools to the thread's machine. Credentials stay on the host.

## connect a provider

1. Open **settings** › **model providers**.
2. Find the provider. Connect it with its browser or device login, or enter an API key, as the provider offers.
3. If the browser cannot reach the login's callback on the host, paste the final redirect URL or the code into the field the page shows.

Pi keeps the credentials in `~/.pi/agent` on the cubed host. **disconnect** removes a saved login. It does not remove credentials the host's environment supplies, and it does not change a thread's model.

A provider that needs host configuration, such as a local model server, has no login here. Configure it in Pi's own files in `~/.pi/agent` on the host.

## the model a thread gets

A thread you start from **new thread** runs the model you pick in the dialog. A thread the chat starts runs the model you asked for, or else the host's preferred model: Pi's default provider and model if a connected provider offers them, otherwise the first model offered.

A thread shows its model in its top rail. You can switch a Pi thread to another Pi model there between turns.

The chat's own model is chosen in the chat's index. The model that writes the chat's summaries is chosen under **settings** › **chat memory**.

## Claude Code threads

Claude Code threads run the unmodified `claude` program on the cubed host with your own Claude Pro or Max subscription. cube never stores Claude credentials.

1. Install Claude Code on the cubed host.
2. Run `claude setup-token` as the user who runs cubed. It prints a long-lived token.
3. Add `CLAUDE_CODE_OAUTH_TOKEN=<the token>` to `~/.config/cubed/environment`. If `claude` is not on the service's `PATH`, also set `CUBED_CLAUDE` to its full path there. Restart cubed.

Without the token, a Claude Code thread's turn fails and says so. cube does not fall back to a `claude /login` session or an API key.

Claude Code models then appear as **claude · max** when you start a thread. A thread stays a Claude Code thread or a Pi thread for its whole life.

cube starts Claude Code with its own minimal set of tools. Your Claude Code settings, hooks and MCP servers do not load. Bash, Read, Write and Edit go to the thread's machine; other tools and subagents are refused. Claude Code itself still runs on the cubed host as your user. See the [security model](/cube/concepts/security-model/#what-runs-on-the-cubed-host).

Claude Code never gets the token. It gets a placeholder for its thread and sends its model requests to cube's gateway on `127.0.0.1`. The gateway puts the token in, sends the request to Anthropic and streams the answer back. It forwards only Claude Code's model requests, up to 32 MiB each, and refuses any other address. Each request and answer is kept, per thread, in `model-audit.sqlite` in cube's state directory, recorded before the request leaves: if cube cannot record a request, it refuses it rather than send it unrecorded. A request still streaming when the gateway is killed shows as lost when it starts again. That file holds the threads' prompts, code and answers, so protect it like the rest of the state directory.

## cost

cube shows what each thread, project and model used, with an estimated cost, under **settings** › **system**. A Claude Code thread on a subscription shows what the calls would cost at list prices, not what you paid. See [usage and cost](/cube/reference/usage-and-cost/).
