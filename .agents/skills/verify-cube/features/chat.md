# Chat

The chat is OptChat, the user's one endless conversation at `#/chat`. A message shows at once, the reply streams in, a provider failure shows as an error in the chat, and a reload reads the same messages once each, on desktop and phone.

## Sub-features

- `chat-send` sends a message and streams the reply.
- `chat-error` shows a provider failure in the chat.
- `chat-reload` reads the chat back after a reload, each message once.
- `chat-phone` shows the same chat at 390x844.

## How to get to it (user POV)

- Open cube's root URL; the chat is the main surface (`#/chat`).
- Type in the composer (`message optchat`) and press Enter.

## Driving it with verify-cube

Preconditions:

- `doctor` is all `ok:`.
- The chat has no message `hello from verify-cube` yet.

- **Send.** Type `hello from verify-cube` and press Enter. The message shows as `.conversation-message.user`, the reply `ok: hello from verify-cube` streams in, and `.composer[aria-busy=false]` returns. Captured as `01-reply`.
- **Provider error.** Send `please fail now`. The chat shows `the provider refused`. Captured as `02-provider-error`.
- **Reload.** Reload the page. The user messages read `["hello from verify-cube", "please fail now"]`, once each.
- **Phone.** Open `#/chat` at 390x844. The same messages show. Captured as `03-phone`.
- **Proof.** `optchat-history.json` is `/api/optchat/history` after the journey.

Run: `.agents/skills/verify-cube/verify-cube run chat`.

## Gotchas

- OptChat's memory compactor also calls the model; the faux model answers it `a summary`, so do not count model calls.
- The send invariants (shown once, never gone and back, busy once) are proven frame by frame by `chat-browser-test.ts` and `cubed-browser-test.ts`; this journey checks the user path.
