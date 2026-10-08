/** `artifact_write` and `artifact_read`, the Pi tools OptChat and Pi threads
 * use to write work artifacts (artifact-service.ts). Claude Code threads get
 * the same through the mod's /cube/artifacts paths. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { ArtifactError, type ArtifactAuthor, type Provenance } from "./artifacts.ts";
import type { Artifacts } from "./artifact-service.ts";
import { ARTIFACT_GUIDE } from "../../claude-mod/hooks/tools.ts";

export { ARTIFACT_GUIDE };

const actionSchema = Type.Object({
  kind: Type.Literal("github.merge"),
  repository: Type.String({ description: "owner/name of a GitHub repository of the project" }),
  pull: Type.Integer({ minimum: 1, description: "Pull request number" }),
  headSha: Type.String({ description: "The pull request's full head commit the document is about" }),
  method: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
  id: Type.Optional(Type.String({ description: "Short id, lowercase; default merge-<pull>" })),
  label: Type.Optional(Type.String({ description: "Button text; default merge owner/name#pull" })),
}, { additionalProperties: false });

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
/** Models fill optional fields with "": a blank id, path or body is one left out. */
const given = (value: string | undefined) => value?.trim() ? value : undefined;

export function artifactTools(options: {
  artifacts: Artifacts;
  author: ArtifactAuthor;
  /** Whose artifacts this agent may read (its own, and OptChat's threads'). */
  readable: () => Promise<ArtifactAuthor[]>;
  agent: Provenance["agent"];
  /** The request id of a call: the same on replay, so a revision is written once. */
  key: (api: ToolExecutionApi) => string;
  /** Reads a workspace file for `path` (threads only). */
  readFile?: (path: string) => Promise<{ text: string; path: string; sha256: string }>;
  /** OptChat names the project an artifact belongs to; a thread's is its own. */
  projects?: boolean;
  model?: () => string | undefined;
}): ToolRegistration[] {
  const write = defineTool({
    name: "artifact_write",
    description: `Create an artifact, or with id write a new revision of one of yours (the whole document each time). ${ARTIFACT_GUIDE}`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "An artifact of yours to revise; omit to create one" })),
      title: Type.Optional(Type.String({ description: "Default: the body's first # heading" })),
      body: Type.Optional(Type.String({ description: "The whole Markdown document; it replaces the previous revision's, so a revision that adds actions repeats the full body" })),
      ...options.readFile ? { path: Type.Optional(Type.String({ description: "A workspace file holding the Markdown body, instead of body" })) } : {},
      ...options.projects ? { project: Type.Optional(Type.String({ description: "Project name or id; needed for actions" })) } : {},
      actions: Type.Optional(Type.Array(actionSchema, { maxItems: 8, description: "Every action this revision offers; omitted is none, not the previous revision's" })),
    }),
    // The request id finds the revision a replayed call wrote.
    replay: "safe",
    execute: async (args, api) => {
      const input = args as { id?: string; title?: string; body?: string; path?: string; project?: string; actions?: unknown };
      try {
        const id = given(input.id), path = given(input.path);
        let body = input.body;
        let source: Provenance["source"];
        if (path !== undefined) {
          if (given(body) !== undefined) throw new ArtifactError("give body or path, not both");
          if (!options.readFile) throw new ArtifactError("path is not available here");
          const file = await options.readFile(path);
          body = file.text;
          source = { path: file.path, sha256: file.sha256 };
        }
        if (body === undefined || !body.trim()) throw new ArtifactError(source ? `${source.path} is empty` : "body (or path) is required");
        const model = options.model?.();
        const provenance: Provenance = { agent: options.agent, ...options.author.kind === "thread" ? { thread: options.author.thread } : {},
          call: api.callId, ...model ? { model } : {}, ...source ? { source } : {} };
        return text(options.artifacts.write(options.author, { id, title: input.title, body, actions: input.actions, project: input.project },
          provenance, options.key(api)).text);
      } catch (error) {
        if (error instanceof ArtifactError) return text(`not written: ${error.message}`);
        throw error;
      }
    },
  });
  const read = defineTool({
    name: "artifact_read",
    description: "Read an artifact whole (its newest revision unless revision is given): its actions and what ran, the comments sent to its author, then its body. Without id: list the artifacts you can read.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    replay: "safe",
    execute: async args => {
      try { return text(options.artifacts.read(await options.readable(), args.id, args.revision)); }
      catch (error) {
        if (error instanceof ArtifactError) return text(error.message);
        throw error;
      }
    },
  });
  return [write, read];
}
