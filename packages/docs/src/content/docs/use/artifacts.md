---
title: artifacts
description: Documents the chat and threads write for you to read, comment on, and act from with a confirmed pull request merge.
---

An artifact is a document the chat or a thread writes for you: a plan, a review, a report. You read it beside the chat, select text in it and comment, and the comments go back to its author. An artifact can also offer a pull request merge that runs only when you confirm it.

The chat stays the only place to talk. An artifact records what someone wrote, not the state of the work.

## open an artifact

A thread's report lists the artifacts its turn wrote, as links. The chat's index lists the newest ones, and the chat shows a note beside the message that wrote or linked one. Each artifact has its own page at `#/a/<id>`.

Every write is a whole new revision. Older revisions stay readable, with the body and actions they had.

## comment

1. Select text in the document, then choose **comment**, or press `c`.
2. Write the comment. It stays a draft.
3. Write more drafts if you like, then choose **send**. All drafts go together, as one message.

The message goes to the artifact's author:

- **The chat's artifact:** it reaches the chat like a message you typed.
- **A thread's artifact:** it becomes the thread's next message. A working thread is never interrupted. The comments wait, saying so, and go when its turn ends. An archived thread cannot receive them, and the page says so.

Each comment prints its state in words: not sent, waiting with the reason, sent or undeliverable. On a newer revision, a comment is shown where its quote is found again, or as `not in this one`.

## merge from an artifact

An artifact can carry a `github.merge` action for one pull request, pinned to the exact head commit the document is about. It shows as a key with its target.

1. Press the key. cube checks, without changing anything, that this is the newest revision, the repository belongs to the artifact's project, and the pull request is open, not a draft, mergeable and still at the reviewed head.
2. The dialog shows the pull request, the reviewed head beside the current head, and any problem. The merge key is enabled only when there is none.
3. Confirm. cube asks GitHub to merge at the reviewed head, so GitHub refuses if the branch moved in between.

The outcome is kept on the artifact and told to its author. Agents can offer an action but never run one. Anyone who can reach cube can confirm one, as with every other control.

## who can read and revise

| who | creates | reads and revises |
|---|---|---|
| the chat | its own artifacts | its own, and those of the threads it started |
| a thread | its own artifacts | every artifact of its project |
| your browser | nothing | reads everything, comments and confirms actions |

The project is the sharing boundary. A thread cannot see another project's artifacts.

## how artifacts render

Artifacts are Markdown. Raw HTML shows as text, links work only for http, https, mailto and cube's own pages, and images show as links. Mermaid diagrams are drawn in your browser, with links and images off. cube checks each diagram before it writes a revision, so a revision with a diagram that does not draw is refused.

Limits: a title of 200 characters, a body of 256 KiB, 8 actions and 500 revisions per artifact.
