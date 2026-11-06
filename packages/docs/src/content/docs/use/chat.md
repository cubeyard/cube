---
title: the chat
description: Talk to cube's chat to start threads, read their reports, keep their work going and archive them.
---

The chat is cube's home page and your one endless conversation with cube. It is an interface, not a worker: it has no machine and runs no code. It starts threads in your projects, tells them more, reads their reports and archives them when they are done. Threads do all the work, each in its own machine.

## start work

Write what you want in plain words and name the project:

```text
In hello, find out why the login test is flaky and fix it. Open a pull request.
```

The chat writes a brief and starts a thread in that project. It answers once the thread is accepted, with a line such as `[abc12345] accepted in hello: …`. A note for the thread appears beside your message, or under it on a narrow window. The note shows the thread's state and links to it.

A thread runs on the host's preferred model unless you ask for another. Name a runner only when you mean it: the chat starts a thread on a named runner, and that is the only way onto an unsandboxed host runner (see [runners](/cube/run/runners/)).

You can attach images to a message: paste, drop or pick PNG, JPEG, GIF or WebP files. They go to the chat's model provider with the message.

## read reports

When a thread ends a turn, its report arrives in the chat as one folded line: the thread's name, `report`, how the turn ended and its first words. Open it to read the thread's whole reply. A failed report stands open.

The chat reads every report and answers it. A report says how the turn ended, never that the task is done. The thread's own reply says what is left.

| the report says | meaning |
|---|---|
| `ended its turn; nothing of it runs now` | the thread finished its turn and waits for a message |
| `ended its turn, waiting on its background agent` | a Claude Code thread still runs a background agent; another report follows |
| `failed: …` | the turn failed: a provider error, Claude Code exited, cubed restarted or the machine failed |
| `stopped` | someone stopped the turn |

Nothing wakes a thread after its turn ends. Threads are told to wait for CI, reviews and long commands in the foreground. When a thread stops short, the chat tells it to go on if the next step is clear and within what you asked. Otherwise it asks you.

## keep work going

- **Ask the chat** to tell a thread more: answers, fixes, review findings, the next step of its task. A thread keeps one task. For a new task the chat starts a new thread.
- **A tell reaches a working thread** between its steps, without a second turn.
- **There is a bound.** The chat sends at most 8 messages to one thread between two of your messages, so unattended work cannot loop without end.

## find threads and artifacts

Press `/` or ctrl/⌘ k, or select the **cube** wordmark, to open the chat's index. It lists the threads the chat started that are still open, failed ones first, and the newest artifacts. The chat's model is chosen there too.

Threads you start from **threads** or a project page are not the chat's, and the chat does not list them.

## archive threads

An open thread holds one machine slot on its runner until it is archived. Ask the chat to archive threads that are done. It archives up to 20 at a time and says what happened to each machine's disk.

The chat refuses to archive a thread that is working, and it cannot stop one. To stop a thread, open it and choose **stop**.

## memory

The chat never forgets. It keeps every message word for word and builds a tree of one-line summaries over them. Each turn starts from a fresh view of the whole chat, where older messages are summarized more coarsely, and the chat opens a summary to read its detail when it needs it.

A smaller model can write the summaries. Choose it under **settings** › **chat memory**. The default follows the chat's own model.

Every new thread gets this view of the chat in its prompt and can read any message of it. Secret-looking values are redacted, but a secret written in plain words is not. See the [security model](/cube/concepts/security-model/#what-a-thread-can-read).

## your instructions

If `<CUBED_STATE>/optchat/AGENTS.md` exists, its text is added to the chat's system prompt on every request. Use it for standing instructions, such as which model to use for reviews. Keep it stable: a change makes the next request read the whole chat again instead of from the provider's cache.
