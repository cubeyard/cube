/** `artifact_write`, `artifact_read` and `artifact_edit`, the cube tools
 * OptChat and every thread use to keep work artifacts (artifact-service.ts),
 * Pi and Claude Code alike (cube-tools.ts). */
import { Type } from "@earendil-works/pi-ai";
import { ArtifactError, type ArtifactAuthor, type Provenance } from "./artifacts.ts";
import type { Artifacts } from "./artifact-service.ts";
import { cubeTool, type CubeTool, type ToolCall } from "./cube-tools.ts";

/** How an agent should write one, after the show-me skill
 * (https://www.humanlayer.com/blog/show-me-skill): compact visuals beside
 * short text, never walls of prose. */
export const ARTIFACT_GUIDE = "An artifact is a document the user reads beside the chat, selects text in and comments on; every write is a new revision and older ones stay. "
  + "Use one for what the user will read and discuss at length (a review, a plan, a report, a design), not for a short reply. "
  + "Write it as GitHub Markdown and show rather than tell: keep prose brief and put each visual next to the short text it supports. "
  + "Pick the smallest view that makes the point: a call tree or file tree in a text fence, a ```mermaid sequence, state or flow diagram, "
  + "a ```diff of the shape that changes (a component tree, a call stack, a file layout, real code), a short table, pseudocode. "
  + "Raw HTML is shown as text, scripts never run, images are links, and only http(s) and #/ links work. "
  + "```mermaid diagrams are drawn by Pele (Mermaid syntax) and checked before a write is accepted: one that does not draw refuses the whole write, which tells you each diagram's problem and line; fix them and write again. "
  + "Comments come back to you as a message starting \"[artifact <id>]\" with the exact text they are about; answer them, and write a new revision of the same artifact when they call for changes. "
  + "You may revise an artifact someone else wrote when you can read it (a thread reads every artifact of its project): read its newest revision first, then write the whole document with its id. "
  + "A write on an older revision than the newest is refused rather than overwriting someone's newer one: read again and redo it on top. It stays its author's: the user's comments on it still go to the author. "
  + "actions offer the user a button; the only kind is github.merge of a pull request in the project's own repository, pinned to its exact 40-character head commit. "
  + "A revision that leaves actions out keeps the newest revision's as they are; give actions to change them (a new head needs a new headSha), [] to remove them. "
  + "Nothing runs unless the user confirms it on the artifact's page, after cube checks the pull request again; never claim an action ran.";

/** What artifact_read shows at once; offset and limit page the rest. */
export const ARTIFACT_READ_CHARS = 120_000;

const actionSchema = Type.Object({
  kind: Type.Literal("github.merge"),
  repository: Type.String({ description: "owner/name of a GitHub repository of the project" }),
  pull: Type.Integer({ minimum: 1, description: "Pull request number" }),
  headSha: Type.String({ description: "The pull request's full head commit the document is about" }),
  method: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
  id: Type.Optional(Type.String({ description: "Short id, lowercase; default merge-<pull>" })),
  label: Type.Optional(Type.String({ description: "Button text; default merge owner/name#pull" })),
}, { additionalProperties: false });

/** Models fill optional fields with "": a blank id, path or body is one left out. */
const given = (value: string | undefined) => value?.trim() ? value : undefined;
const STOPPED = "not written: the call was stopped";

export function artifactTools(options: {
  artifacts: Artifacts;
  author: ArtifactAuthor;
  /** Whose artifacts this agent may read and revise (its own, and OptChat's threads'); a thread also its project's. */
  readable: () => Promise<ArtifactAuthor[]>;
  agent: Provenance["agent"];
  /** Reads a file in the thread's machine for `path` (threads only). */
  readFile?: (path: string) => Promise<{ text: string; path: string; sha256: string }>;
  /** OptChat names the project an artifact belongs to; a thread's is its own. */
  projects?: boolean;
  model?: () => string | undefined;
}): CubeTool[] {
  const scope = async () => ({ agent: options.author, authors: await options.readable() });
  const provenance = (call: ToolCall, source?: Provenance["source"]): Provenance => {
    const model = options.model?.();
    return { agent: options.agent, ...options.author.kind === "thread" ? { thread: options.author.thread } : {},
      call: call.id.slice(0, 200), ...model ? { model } : {}, ...source ? { source } : {} };
  };
  const write = cubeTool({
    name: "artifact_write",
    description: `Create an artifact, or with id write a new revision of one you can read (the whole document each time, on its newest revision). ${ARTIFACT_GUIDE}`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "An artifact to revise (yours, or another one artifact_read shows you); omit to create one" })),
      base: Type.Optional(Type.Integer({ minimum: 1, description: "The revision you read and wrote this one on; default: the one you last read or wrote. A write on an older revision than the newest is refused" })),
      title: Type.Optional(Type.String({ description: "Default: the body's first # heading" })),
      body: Type.Optional(Type.String({ description: "The whole Markdown document" })),
      ...options.readFile ? { path: Type.Optional(Type.String({ description: "A file in the thread machine (relative to the workspace, or absolute) holding the Markdown body, instead of body" })) } : {},
      ...options.projects ? { project: Type.Optional(Type.String({ description: "Project name or id; needed for actions" })) } : {},
      actions: Type.Optional(Type.Array(actionSchema, { maxItems: 8, description: "Left out on a revision: the newest revision's actions are kept as they are; [] removes them" })),
    }),
    run: async (args, call) => {
      const input = args as typeof args & { path?: string; project?: string };
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
        if (call.signal?.aborted) return STOPPED;
        return (await options.artifacts.write(await scope(), { id, base: input.base, title: input.title, body, actions: input.actions, project: input.project },
          provenance(call, source), call.key)).text;
      } catch (error) {
        if (error instanceof ArtifactError) return `not written: ${error.message}`;
        throw error;
      }
    },
  });
  const edit = cubeTool({
    name: "artifact_edit",
    description: "Replace text in the newest revision of an artifact you can read, as its next revision: a small change without writing the whole document. "
      + "It is written on the revision you last read or wrote, and refused when another is newer: read it again and redo the edit on top.",
    parameters: Type.Object({
      id: Type.String({ description: "The artifact to change" }),
      old_string: Type.String({ description: "The text to replace; it must occur once unless replace_all is true" }),
      new_string: Type.String({ description: "The text to replace it with" }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence; default false" })),
    }),
    run: async (input, call) => {
      try {
        if (call.signal?.aborted) return STOPPED;
        return (await options.artifacts.edit(await scope(), { id: input.id, oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all },
          provenance(call), call.key)).text;
      } catch (error) {
        if (error instanceof ArtifactError) return `not written: ${error.message}`;
        throw error;
      }
    },
  });
  const read = cubeTool({
    name: "artifact_read",
    description: "Read an artifact (its newest revision unless revision is given): its actions and what ran, the comments sent to its author, then its body. "
      + `Read the newest revision before you revise an artifact. At most ${ARTIFACT_READ_CHARS} characters are shown at once; offset and limit page a long one by lines. Without id: list the artifacts you can read.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "The first line to show; default 1" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "How many lines to show; default all that fit" })),
    }),
    run: async input => {
      try { return page(options.artifacts.read(await scope(), given(input.id), input.revision), input.offset, input.limit); }
      catch (error) {
        if (error instanceof ArtifactError) return error.message;
        throw error;
      }
    },
  });
  return [write, read, edit];
}

/** Lines of a read, at most ARTIFACT_READ_CHARS characters; a part says it
 * is one. A line longer than that is split into lines of at most that many,
 * so all of it can be read, and the read says which lines continue the same
 * line without a line break. */
function page(text: string, offset = 1, limit?: number): string {
  const lines: string[] = [];
  /** Lines (1-based) whose text goes on in the next line, unbroken. */
  const continued = new Set<number>();
  for (const line of text.split("\n")) {
    for (let at = 0, end; at === 0 || at < line.length; at = end) {
      end = at + ARTIFACT_READ_CHARS;
      // Never between the halves of a surrogate pair: each part must survive UTF-8.
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
      if (end < line.length) continued.add(lines.length + 1);
      lines.push(line.slice(at, end));
    }
  }
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)) {
    if (shown.length && chars + line.length + 1 > ARTIFACT_READ_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const end = offset - 1 + shown.length;
  if (!shown.length) return `[the artifact has ${lines.length} lines; read it with a smaller offset]`;
  const notes: string[] = [];
  const split = shown.map((_, index) => offset + index).filter(line => continued.has(line));
  // artifact_write replaces the whole document: a part read must say it is one.
  if (split.length) notes.push(`line ${split.map(line => `${line} goes on in line ${line + 1}`).join(", ")} without a line break: a line over ${ARTIFACT_READ_CHARS} characters is shown in parts; join them when you write the document`);
  if (end < lines.length) notes.push(`lines ${offset}-${end} of ${lines.length}; artifact_read with offset ${end + 1} for the rest. artifact_write replaces the whole document, so read all of it before writing it, or change a part with artifact_edit`);
  return notes.length ? `${shown.join("\n")}\n${notes.map(note => `[${note}]`).join("\n")}` : shown.join("\n");
}
