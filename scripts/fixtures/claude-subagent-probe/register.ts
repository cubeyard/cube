/** The probe's stand-in for packages/claude-mod/hooks/register.ts, copied
 * over it in a scratch copy of the mod by scripts/probe-claude-subagents.ts.
 * It keeps the real mod's Bash, Read, Write and Edit over the workspace, lets
 * the subagent tools through to Claude Code, and reports every tool.call and
 * agent.spawn event (and the result Claude Code gave back) to the probe's
 * socket, which answers with a verdict: pass, deny, or rewrite. */
import type { EngineInterface, Register } from 'claude-code'
import { WorkspaceClient } from './workspace.ts'
import { bash, edit, read, write, type ToolScope } from './tools.ts'

const WORKSPACE_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit'])
type Verdict = { deny?: string; rewrite?: Record<string, unknown>; result?: unknown }

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (_key, inner) => typeof inner === 'function' ? '[function]' : inner))
}

async function probe($: Pick<EngineInterface, 'env' | 'http'>, kind: string, body: unknown): Promise<Verdict> {
  const socketPath = await $.env.get('CUBE_WORKSPACE_SOCKET')
  if (!socketPath) return {}
  const reply = await $.http.fetch(`http://localhost/probe/${kind}`, {
    method: 'POST', socketPath, headers: { 'content-type': 'application/json' }, body: JSON.stringify(plain(body)),
  })
  return JSON.parse(reply.text) as Verdict
}

async function scope($: Pick<EngineInterface, 'env' | 'http'>, signal?: AbortSignal): Promise<ToolScope | undefined> {
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
  on('agent.spawn', async ($, e, next) => {
    const verdict = await probe($, 'agent.spawn', e)
    if (verdict.deny) return { deny: verdict.deny }
    const answer = await next(verdict.rewrite ? { ...e, ...verdict.rewrite } : e)
    await probe($, 'agent.spawn.answer', answer)
    return answer
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'probe: agent.spawn hook failed' })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const verdict = await probe($, 'tool.call', e)
    if (verdict.deny) return { deny: verdict.deny }
    if (WORKSPACE_TOOLS.has(tool)) {
      const s = await scope($, next.signal)
      if (!s) return { deny: 'probe: no workspace' }
      const result = tool === 'Bash' ? await bash(s, e.tool_use_id, e as never)
        : tool === 'Read' ? await read(s, e as never)
        : tool === 'Write' ? await write(s, e.tool_use_id, e as never)
        : await edit(s, e.tool_use_id, e as never)
      await probe($, 'tool.workspace', { tool, tool_use_id: e.tool_use_id, aborted: next.signal?.aborted ?? null })
      return 'deny' in result ? result : { result }
    }
    const answer = await next(e)
    const after = await probe($, 'tool.answer', { tool, tool_use_id: e.tool_use_id, answer })
    return after.result === undefined ? answer : after.result as typeof answer
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'probe: tool.call hook failed' })
}
