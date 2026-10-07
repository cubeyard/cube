/** cube's Claude Code mod. cubed starts `claude -p --plugin-dir <this
 * folder>` for a claude-code thread; this module sends Claude Code's Bash,
 * Read, Write and Edit to the thread Workspace in its virtual machine, keyed
 * by tool_use_id, and refuses what would act on the cubed host instead.
 *
 * cubed passes the workspace through the environment: a Unix socket that
 * serves only workspace routes, the thread's route path, the lease token it
 * holds for this process, and the local directory Claude Code runs in. The
 * machine is the thread's sandbox; Claude Code itself runs on the cubed host
 * and is not sandboxed. */
import type { EngineInterface, Register } from 'claude-code'
import { WorkspaceClient } from './workspace.ts'
import { ALLOWED_TOOLS, ARTIFACT_GUIDE, ARTIFACT_ROOT, artifactPath, bash, edit, instructions, read, readArtifact, write, writeArtifact, VIRTUAL_ROOT, type ToolScope } from './tools.ts'

const ALLOWED = new Set(ALLOWED_TOOLS)
const UNCONFIGURED = 'cube: this session has no thread workspace; cubed starts Claude Code with one'
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

async function workspace($: Pick<EngineInterface, 'env' | 'http'>, signal?: AbortSignal): Promise<ToolScope | undefined> {
  const socketPath = await $.env.get('CUBE_WORKSPACE_SOCKET')
  const base = await $.env.get('CUBE_WORKSPACE_PATH')
  const token = await $.env.get('CUBE_WORKSPACE_TOKEN')
  const root = await $.env.get('CUBE_WORKSPACE_ROOT')
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
  return { client, token, root, ...(signal ? { signal } : {}) }
}

export const register: Register = on => {
  // An allow-list, not a deny-list: a tool this mod does not know (an MCP
  // tool, a newer built-in) would run on the cubed host as the cubed user.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (!ALLOWED.has(tool)) return { deny: `${tool} is not available in cube threads: it would act on the cubed host, not the thread workspace. Use Bash, Read, Write or Edit.` }
    if (e.tool === 'Agent' && e.isolation) return { deny: `subagents with ${e.isolation} isolation are not available in cube threads; start the subagent without isolation` }
    return next(e)
  })

  // An agent definition can force isolation without the call asking for it,
  // and a definition from elsewhere can carry its own tools and hooks: only
  // Claude Code's built-in agent types start, never isolated.
  on('agent.spawn', ($, e, next) => {
    const isolation = (e as { isolation?: unknown }).isolation
    if (isolation) return { deny: `subagents with ${String(isolation)} isolation are not available in cube threads; start the subagent without isolation` }
    if (e.provider.plugin !== 'engine') return { deny: `the ${e.subagentType} agent is not available in cube threads; use a built-in agent type such as general-purpose` }
    return next(e)
  })

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
    const result = await edit(scope, e.tool_use_id, e)
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
      'Commands run there as user agent (with sudo); the machine reaches the internet over HTTP and HTTPS only, and GH_TOKEN is a placeholder that works for gh and git with GitHub. Background commands, notebooks, worktrees and host-local tools are not available. ' +
      'A server a command starts ends with that command: to keep a web server running and give the user a URL, run `cube service start NAME --port PORT -- COMMAND` (it must listen on 0.0.0.0; `cube service --help` lists status, logs and stop).',
      `Work artifacts: Write ${ARTIFACT_ROOT}/<name>.md to create a document for the user, or a new revision of it (the whole document each time; its title is the first # heading); ` +
      `Write ${ARTIFACT_ROOT}/<name>.json as {"title"?, "body", "actions"?} to offer actions; Read ${ARTIFACT_ROOT}/<name>.md for the newest revision with the comments sent to you, and Read ${ARTIFACT_ROOT} for the list. ` +
      'These paths are kept by cube, not in the machine; Edit and Bash do not reach them. ' + ARTIFACT_GUIDE,
    ]
    for (const file of INSTRUCTION_FILES) {
      const text = await instructions(scope, file).catch(() => null)
      if (text?.trim()) sections.push(`Contents of ${file} in the thread workspace (project instructions, checked into the codebase):\n\n${text.trim()}`)
    }
    return { ...context, blocks: [...context.blocks, { name: 'cubeWorkspace', text: sections.join('\n\n') }] }
  })
}
