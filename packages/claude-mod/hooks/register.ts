/** cube's Claude Code mod. cubed starts `claude -p --plugin-dir <this
 * folder>` for a claude-code thread; this module sends Claude Code's Bash,
 * Read, Write and Edit to the thread Workspace on its trusted runner, keyed
 * by tool_use_id, and refuses what would act on the cubed host instead.
 *
 * cubed passes the workspace through the environment: a Unix socket that
 * serves only workspace routes, the thread's route path, the lease token it
 * holds for this process, and the local directory Claude Code runs in. The
 * runner is trusted, not a sandbox. */
import type { EngineInterface, Register } from 'claude-code'
import { WorkspaceClient } from './workspace.ts'
import { bash, edit, instructions, read, write, VIRTUAL_ROOT, type ToolScope } from './tools.ts'

/** Tools that would act on the cubed host, not the thread workspace. */
const LOCAL = new Set(['NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'LSP', 'Monitor', 'PowerShell'])
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
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (LOCAL.has(tool)) return { deny: `${tool} is not available in cube threads: it would act on the cubed host, not the thread workspace. Use Bash, Read, Write or Edit.` }
    if (e.tool === 'Agent' && e.isolation) return { deny: `subagents with ${e.isolation} isolation are not available in cube threads; start the subagent without isolation` }
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
    const result = await read(scope, e)
    return 'deny' in result ? result : { result }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await write(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await edit(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  })

  // The repository's own instructions live on the runner, not beside the
  // local directory Claude Code runs in.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const scope = await workspace($)
    if (!scope) return context
    const sections = [
      `You are working in a cube thread. ${scope.root} (also ${VIRTUAL_ROOT}) is the thread workspace on cube's trusted runner: ` +
      'Read, Write and Edit address files there, and Bash runs commands there with the workspace root as its working directory. ' +
      'The runner executes trusted commands under its own account; it is not a sandbox. Background commands, notebooks, worktrees and host-local tools are not available.',
    ]
    for (const file of INSTRUCTION_FILES) {
      const text = await instructions(scope, file).catch(() => null)
      if (text?.trim()) sections.push(`Contents of ${file} in the thread workspace (project instructions, checked into the codebase):\n\n${text.trim()}`)
    }
    return { ...context, blocks: [...context.blocks, { name: 'cubeWorkspace', text: sections.join('\n\n') }] }
  })
}
