/** A post-merge review in the show-me style
 * (https://www.humanlayer.com/blog/show-me-skill): compact visuals beside
 * short text. The browser test renders it as OptChat's artifact, with the
 * hostile content an agent might quote mixed in, which must stay inert. */
export const REVIEW = `# post-merge review: work artifacts

Threads and the chat can now write documents you read beside the chat. Comments on a selection go back to whoever wrote it; a merge runs only after you confirm it here.

## what changed

\`\`\`text
packages/server/src/
├── artifacts.ts          # store: revisions, comments, batches, action runs
├── artifact-service.ts   # write/read for agents, delivery, merge checks
├── artifact-tools.ts     # artifact_write / artifact_read (pi, optchat)
└── github-pulls.ts       # live pull request state, merge pinned to a head
packages/claude-mod/hooks/tools.ts   # /cube/artifacts/<name>.md for claude code
packages/web/src/components/ArtifactView.svelte
\`\`\`

## a comment's way back

\`\`\`mermaid
sequenceDiagram
    participant You
    participant cubed
    participant Thread
    You->>cubed: comment on a selection (draft)
    You->>cubed: send 2 comments
    cubed-->>cubed: one batch, one request id
    alt thread is working
        cubed-->>You: waiting: sent once its turn ends
    end
    cubed->>Thread: message with quote, context, revision
    Thread->>cubed: new revision
\`\`\`

## the merge, as a call tree

\`\`\`diff
 POST /api/artifacts/:id/actions/:action
   preview
+    newest revision only
+    repository belongs to the artifact's project
+    github: open, not draft, head == reviewed head, mergeable
+  confirm == "owner/name#n"
   github.merge(sha = reviewed head)
+  action run recorded once per request
\`\`\`

| risk | handled by |
| --- | --- |
| a document runs code | raw HTML is text; diagrams are images |
| merge of a moved head | GitHub refuses a sha that is not the head |
| a busy thread interrupted | comments wait for its turn to end |

## what an agent might quote

<script>window.__pwned = true</script><img src=x onerror="window.__pwned = true">

[a javascript link](javascript:window.__pwned=true) · [the pull request](https://github.com/cubeyard/demo/pull/7) · [the chat](#/chat)

\`\`\`mermaid
graph TD
    A[click me] --> B
    click A "javascript:window.__pwned=true"
\`\`\`

The summary sentence the user comments on: the store keeps every revision.
`;

export const REVIEW_REVISED = REVIEW.replace("the store keeps every revision.", "the store keeps every revision, and an older revision's actions never run.");
