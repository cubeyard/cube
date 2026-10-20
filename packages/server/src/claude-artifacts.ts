/** A Claude Code thread's artifacts on cubed's workspace socket
 * (`/api/threads/<id>/workspace/artifacts`): what the mod's /cube/artifacts
 * paths reach. The lease token cubed holds for that thread's child is the
 * authorization, and only a claude-code lease admits it. */
import type { Artifacts } from "./artifact-service.ts";
import { ArtifactError, isArtifactId, isArtifactName, type ArtifactAuthor } from "./artifacts.ts";
import type { Workspace } from "./workspace.ts";
import type { WorkspaceResponse } from "./workspace-http.ts";

export async function claudeArtifactRoute(artifactService: Artifacts, workspace: Workspace, threadId: string, request: {
  method: string; query: URLSearchParams; headers: { authorization?: string }; body: Record<string, unknown>;
}): Promise<WorkspaceResponse> {
  const json = (body: unknown, status = 200): WorkspaceResponse => ({ status, body });
  const { body } = request;
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1];
  if (!token) return json({ error: "workspace lease token required", code: "LEASE_STALE", completionUnknown: false }, 401);
  const lease = await workspace.lease({ token }).catch(() => null);
  if (!lease) return json({ error: "workspace lease is not held by this token", code: "LEASE_STALE", completionUnknown: false }, 401);
  if (lease.owner !== "claude-code") return json({ error: "artifacts here are for claude code threads", code: "WRONG_NODE", completionUnknown: false }, 403);
  const author: ArtifactAuthor = { kind: "thread", thread: threadId };
  const scope = { agent: author, authors: [author] };
  try {
    // A name in the form of an artifact id is that artifact, the thread's or not.
    if (request.method === "GET") {
      const name = request.query.get("name");
      if (!name) return json({ text: artifactService.read(scope, undefined) });
      const artifact = isArtifactId(name) ? artifactService.store.get(name) : isArtifactName(name) ? artifactService.store.named(author, name) : null;
      if (!artifact) return json({ error: `no artifact named ${name}; write /cube/artifacts/${name}.md to create it`, code: "NOT_FOUND", completionUnknown: false }, 404);
      const revision = request.query.get("revision");
      // Whole: the mod pages it with Read's offset and limit.
      return json({ text: artifactService.read(scope, artifact.id, revision ? Number(revision) : undefined, { whole: true }) });
    }
    if (request.method === "POST") {
      if (!isArtifactName(body.name)) throw new ArtifactError("a name is 1 to 64 lowercase letters, digits, dots, dashes or underscores");
      const provenance = { agent: "claude-code" as const, thread: threadId, ...typeof body.call === "string" ? { call: body.call.slice(0, 200) } : {} };
      if (body.edit !== undefined) {
        const edit = body.edit as Record<string, unknown> | null;
        if (typeof body.requestId !== "string" || !edit || typeof edit.oldString !== "string" || typeof edit.newString !== "string" || (edit.replaceAll !== undefined && typeof edit.replaceAll !== "boolean")) {
          throw new ArtifactError("requestId and edit {oldString, newString, replaceAll?} are required");
        }
        const target = isArtifactId(body.name) ? { id: body.name } : { name: body.name };
        const written = artifactService.edit(scope, { ...target, oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll as boolean | undefined }, provenance, body.requestId);
        return json({ text: written.text, id: written.id, revision: written.revision });
      }
      if (typeof body.requestId !== "string" || typeof body.body !== "string") throw new ArtifactError("requestId and body are required");
      if (body.base !== undefined && typeof body.base !== "number") throw new ArtifactError("base must be a revision number");
      const target = isArtifactId(body.name) ? { id: body.name } : { name: body.name };
      const written = artifactService.write(scope, { ...target, base: body.base, title: typeof body.title === "string" ? body.title : undefined, body: body.body, actions: body.actions },
        provenance, body.requestId);
      return json({ text: written.text, id: written.id, revision: written.revision });
    }
  } catch (error) {
    if (error instanceof ArtifactError) return json({ error: error.message, code: error.status === 404 ? "NOT_FOUND" : "INVALID_REQUEST", completionUnknown: false }, error.status);
    throw error;
  }
  return json({ error: "not found", code: "NOT_FOUND", completionUnknown: false }, 404);
}
