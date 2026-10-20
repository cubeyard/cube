// The hooks module scripts/check-claude-tools.ts loads in place of
// register.ts: the mod's own hooks (cubeHooks) with two proof tools instead
// of CUBE_TOOLS, which offers none yet. They read artifacts through the
// route the /cube/artifacts paths reach; their names and shapes decide
// nothing about the tools cube will offer. A tool.check hook only records
// that it ran. Never loaded in a thread.
import type { Register } from 'claude-code'
import { cubeHooks } from '../hooks/register.ts'
import type { CubeTool, ToolScope } from '../hooks/tools.ts'
import { WorkspaceClientError } from '../hooks/workspace.ts'

/** A read through cubed: the route's refusal reaches the model as an error,
 * any other failure is thrown for cubeHooks to turn into one. */
async function artifact(scope: ToolScope, name?: string): Promise<{ result: string } | { deny: string }> {
  try {
    const read = scope.client.artifact(scope.token, name)
    // A stop does not wait for cubed's answer.
    const stopped = new Promise<undefined>(resolve => scope.signal?.addEventListener('abort', () => resolve(undefined), { once: true }))
    const answer = await Promise.race([read, stopped])
    if (!answer) return { deny: 'stopped' }
    if (typeof answer.text !== 'string') throw new Error('cubed answered without a text')
    return { result: answer.text }
  } catch (error) {
    if (error instanceof WorkspaceClientError) return { deny: `${error.code}: ${error.message}` }
    throw error
  }
}

const TOOLS: CubeTool[] = [
  {
    name: 'check_artifact_read',
    description: 'Proof tool: the newest revision of a cube artifact, by its name or id, with the comments sent to you.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'the artifact name or id' } }, required: ['name'], additionalProperties: false },
    isDeferred: false,
    // Claude Code passes the input on without checking it against the schema.
    call: (scope, _toolUseId, input) => {
      const extra = Object.keys(input).filter(field => field !== 'name')
      if (typeof input.name !== 'string' || extra.length) return Promise.resolve({ deny: `invalid input: name (a string) only${extra.length ? `, not ${extra.join(', ')}` : ''}` })
      return artifact(scope, input.name)
    },
  },
  {
    name: 'check_artifact_list',
    description: 'Proof tool: the cube artifacts this thread can read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isDeferred: true,
    call: (scope, _toolUseId, input) => Object.keys(input).length ? Promise.resolve({ deny: 'invalid input: no fields' }) : artifact(scope),
  },
]

export const register: Register = on => {
  cubeHooks(on, TOOLS)
  on('tool.check', async ($, e, next) => {
    const decision = await next(e)
    const socketPath = await $.env.get('CUBE_WORKSPACE_SOCKET')
    if (socketPath) await $.http.fetch(`http://localhost/check/tool.check?${new URLSearchParams({ tool: String(e.tool), decision: decision.decision })}`, { method: 'POST', socketPath })
    return decision
  })
}
