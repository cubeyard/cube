/** cube's Claude Code mod. cubed starts `claude -p --plugin-dir <this
 * folder>` for a claude-code thread; this module sends Claude Code's Bash,
 * Read, Write and Edit to the thread Workspace in its virtual machine, keyed
 * by tool_use_id, and refuses what would act on the cubed host instead. Every
 * file path names a file in that machine: the workspace, or with an absolute
 * path anywhere else in it; none is opened on the host.
 *
 * cubed passes the workspace through the environment: a Unix socket that
 * serves only workspace routes, the thread's route path, the lease token it
 * holds for this process, and the local directory Claude Code runs in. The
 * machine is the thread's sandbox; Claude Code itself runs on the cubed host
 * and is not sandboxed. */
import type { EngineInterface, Register } from 'claude-code'
import { WorkspaceClient } from './workspace.ts'
import { ALLOWED_TOOLS, ARTIFACT_GUIDE, ARTIFACT_ROOT, NO_SUBAGENTS, PROJECT_HOOKS_NOTE, SUBAGENT_TOOLS, artifactPath, bash, edit, editArtifact, GUEST_HOME, instructions, read, readArtifact, write, writeArtifact, VIRTUAL_ROOT, type ToolScope } from './tools.ts'

const ALLOWED = new Set(ALLOWED_TOOLS)
const SUBAGENTS = new Set(SUBAGENT_TOOLS)
const UNCONFIGURED = 'cube: this session has no thread workspace; cubed starts Claude Code with one'
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

async function workspace($: Pick<EngineInterface, 'env' | 'http'>, signal?: AbortSignal): Promise<ToolScope | undefined> {
  const socketPath = await $.env.get('CUBE_WORKSPACE_SOCKET')
  const base = await $.env.get('CUBE_WORKSPACE_PATH')
  const token = await $.env.get('CUBE_WORKSPACE_TOKEN')
  const root = await $.env.get('CUBE_WORKSPACE_ROOT')
  const realRoot = await $.env.get('CUBE_WORKSPACE_REAL_ROOT')
  if (!socketPath || !base || !token || !root) return undefined
  const client = new WorkspaceClient({
    base,
    transport: async request => {
      const reply = await $.http.fetch(`http://localhost${request.path}`, {
        method: request.method, headers: request.headers, socketPath, ...(request.body === undefined ? {} : { body: request.body }),
      })
      return { status: reply.status, text: reply.text }
    },
  })
  return { client, token, root, ...(realRoot ? { realRoot } : {}), ...(signal ? { signal } : {}) }
}

export const register: Register = on => {
  // An allow-list, not a deny-list: a tool this mod does not know (an MCP
  // tool, a newer built-in) would run on the cubed host as the cubed user.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (SUBAGENTS.has(tool)) return { deny: `${tool}: ${NO_SUBAGENTS}` }
    if (!ALLOWED.has(tool)) return { deny: `${tool} is not available in cube threads: it would act on the cubed host, not the thread workspace. Use Bash, Read, Write or Edit.` }
    return next(e)
  })

  // Every spawn, whatever starts it (a fork, a teammate, a workflow, an
  // agent definition): the tool list is not the only way in.
  on('agent.spawn', () => ({ deny: NO_SUBAGENTS }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await bash(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const artifact = artifactPath(e.file_path)
    if (artifact && 'deny' in artifact) return artifact
    const result = artifact ? await readArtifact(scope, artifact, e) : await read(scope, e)
    return 'deny' in result ? result : { result }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const artifact = artifactPath(e.file_path)
    if (artifact && 'deny' in artifact) return artifact
    const result = artifact ? await writeArtifact(scope, e.tool_use_id, artifact, e) : await write(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    // Artifacts are cube's, not the machine's: cubed writes the edited revision.
    const artifact = artifactPath(e.file_path)
    if (artifact && 'deny' in artifact) return artifact
    const result = artifact ? await editArtifact(scope, e.tool_use_id, artifact, e) : await edit(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  })

  // The repository's own instructions live in the thread's machine, not beside the
  // local directory Claude Code runs in.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const scope = await workspace($)
    if (!scope) return context
    const sections = [
      `You are working in a cube thread. ${scope.root} (also ${VIRTUAL_ROOT}) is the thread workspace in the thread's own virtual machine: ` +
      'Read, Write and Edit address files there, and Bash runs commands there with the workspace root as its working directory. ' +
      `Any other absolute path (${GUEST_HOME}, /tmp, ~/…) is a file in the same machine, never on the host Claude Code runs on; there the file tools have the agent account's own permissions (use sudo in Bash for root-owned files; /proc, /sys and /dev only through Bash). ` +
      'Commands run there as user agent (with sudo); the machine reaches the internet over HTTP and HTTPS only, and GH_TOKEN is a placeholder that works for gh and git with GitHub. Background commands, notebooks, worktrees and host-local tools are not available. ' +
      'A server a command starts ends with that command: to keep a web server running and give the user a URL, run `cube service start NAME --port PORT -- COMMAND` (it must listen on 0.0.0.0; `cube service --help` lists status, logs and stop). ' +
      PROJECT_HOOKS_NOTE,
      `Work artifacts: Write ${ARTIFACT_ROOT}/<name>.md to create a document for the user, or a new revision of it (the whole document each time; its title is the first # heading); ` +
      `Write ${ARTIFACT_ROOT}/<name>.json as {"title"?, "body", "actions"?} to offer actions; Read ${ARTIFACT_ROOT}/<name>.md for the newest revision with the comments sent to you, and Read ${ARTIFACT_ROOT} for the list. ` +
      `To revise an existing artifact by its id (yours, another thread's or OptChat's in this project), Read ${ARTIFACT_ROOT}/<id>.md, then Write ${ARTIFACT_ROOT}/<id>.md with the whole document. ` +
      `Read takes offset and limit there as for a file; to change part of a long artifact, Edit ${ARTIFACT_ROOT}/<name or id>.md instead of writing it whole (a new revision on the one you last read). ` +
      'These paths are kept by cube, not in the machine; Bash does not reach them. ' + ARTIFACT_GUIDE,
    ]
    for (const file of INSTRUCTION_FILES) {
      const text = await instructions(scope, file).catch(() => null)
      if (text?.trim()) sections.push(`Contents of ${file} in the thread workspace (project instructions, checked into the codebase):\n\n${text.trim()}`)
    }
    // The thread's skills, installed in its machine; cubed renders the list.
    const skills = await $.env.get('CUBE_SKILLS_PROMPT')
    if (skills) sections.push(skills)
    return { ...context, blocks: [...context.blocks, { name: 'cubeWorkspace', text: sections.join('\n\n') }] }
  })
}
