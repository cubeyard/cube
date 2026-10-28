/** cube's Claude Code mod. cubed starts `claude -p --plugin-dir <this
 * folder>` for a claude-code thread; this module sends Claude Code's Bash,
 * Read, Write and Edit to the thread Workspace in its virtual machine, keyed
 * by tool_use_id, and refuses what would act on the cubed host instead. Every
 * file path names a file in that machine: the workspace, or with an absolute
 * path anywhere else in it; none is opened on the host. It also registers
 * cube's own tools (artifacts) as cubed lists them and forwards their calls
 * to cubed, which defines and answers them (packages/server/src/cube-tools.ts).
 *
 * cubed passes the workspace through the environment: a Unix socket that
 * serves only workspace routes, the thread's route path, the lease token it
 * holds for this process, and the local directory Claude Code runs in. The
 * machine is the thread's sandbox; Claude Code itself runs on the cubed host
 * and is not sandboxed.
 *
 * Claude Code runs without a mod it cannot load (one its static check
 * refuses, a missing folder) and skips a hook that throws, misanswers or
 * overruns, running the tool itself: on the cubed host. So every guard here
 * refuses in its `.catch`, and the mod's last hook tells cubed it is in
 * (`ready`, with the nonce cubed gave this child): cubed writes no prompt
 * before that, and its `--settings` hook refuses any host tool no hook here
 * answered (claude-agent.ts). */
import type { EngineInterface, Register } from 'claude-code'
import { WorkspaceClient } from './workspace.ts'
import { ALLOWED_TOOLS, CUBE_TOOL_PREFIX, NO_SUBAGENTS, PROJECT_HOOKS_NOTE, SUBAGENT_TOOLS, bash, cubeTool, edit, GUEST_HOME, instructions, read, write, VIRTUAL_ROOT, type ToolScope } from './tools.ts'

const ALLOWED = new Set(ALLOWED_TOOLS)
const SUBAGENTS = new Set(SUBAGENT_TOOLS)
const UNCONFIGURED = 'cube: this session has no thread workspace; cubed starts Claude Code with one'
const FAILED = 'cube: the mod failed on this call, so it is refused rather than run on the cubed host'
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
  // cube's own tools are cubed's to answer, or refuse.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(CUBE_TOOL_PREFIX)) return next(e)
    if (SUBAGENTS.has(tool)) return { deny: `${tool}: ${NO_SUBAGENTS}` }
    if (!ALLOWED.has(tool)) return { deny: `${tool} is not available in cube threads: it would act on the cubed host, not the thread workspace. Use Bash, Read, Write or Edit.` }
    return next(e)
  }).catch(($, e, next) => next.called ? next(e) : { deny: FAILED })

  // Every spawn, whatever starts it (a fork, a teammate, a workflow, an
  // agent definition): the tool list is not the only way in.
  on('agent.spawn', () => ({ deny: NO_SUBAGENTS })).catch(() => ({ deny: NO_SUBAGENTS }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await bash(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  }).catch(() => ({ deny: FAILED }))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await read(scope, e)
    return 'deny' in result ? result : { result }
  }).catch(() => ({ deny: FAILED }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await write(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  }).catch(() => ({ deny: FAILED }))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const result = await edit(scope, e.tool_use_id, e)
    return 'deny' in result ? result : { result }
  }).catch(() => ({ deny: FAILED }))

  // cube's own tools, registered at session.start from what cubed offers.
  on('tool.call', { tool: /^mcp__cube__/ }, async ($, e, next) => {
    const scope = await workspace($, next.signal)
    if (!scope) return { deny: UNCONFIGURED }
    const { tool, tool_use_id, ...input } = e
    const result = await cubeTool(scope, tool_use_id, String(tool), input)
    return typeof result === 'string' ? { result } : result
  }).catch(() => ({ deny: FAILED }))

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
      `Work artifacts, documents for the user that cube keeps (not files in the machine): ${CUBE_TOOL_PREFIX}artifact_write, ${CUBE_TOOL_PREFIX}artifact_read and ${CUBE_TOOL_PREFIX}artifact_edit.`,
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

  // Last, once every hook above is in: cube's own tools are registered as
  // cubed lists them, then cubed sends no prompt until this child says so
  // with its nonce. A start, a resume or a clear says it again. A failed
  // registration throws before the word, so the turn fails closed.
  on('session.start', async ($, e, next) => {
    const scope = await workspace($)
    const nonce = await $.env.get('CUBE_MOD_NONCE')
    if (scope) for (const tool of await scope.client.tools(scope.token)) await $.tool.register(tool)
    if (scope && nonce) await scope.client.ready(scope.token, nonce)
    return next(e)
  })
}
